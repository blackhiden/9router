// Cursor auto-import (GET /api/oauth/cursor/auto-import).
//
// The route has been rewritten since this suite first landed: it now probes a
// candidate list per platform, reads tokens with per-key `SELECT ... WHERE
// key=?` lookups through better-sqlite3, falls back to the sqlite3 CLI, and
// finally answers with `windowsManual` so the modal can ask the user to paste
// tokens. These tests pin that contract.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fsPromises from "fs/promises";

// Mock next/server
vi.mock("next/server", () => ({
  NextResponse: {
    json: vi.fn((body, init) => ({
      status: init?.status || 200,
      body,
      json: async () => body,
    })),
  },
}));

// Mock os
vi.mock("os", () => ({
  default: { homedir: vi.fn(() => "/mock/home") },
  homedir: vi.fn(() => "/mock/home"),
}));

// Mock fs/promises
vi.mock("fs/promises", () => ({
  access: vi.fn(),
  constants: { R_OK: 4 },
}));

// The sqlite3 CLI fallback must never spawn a real process in tests.
vi.mock("child_process", () => ({
  execFile: vi.fn((file, args, options, callback) => {
    callback(new Error(`spawn ${file} ENOENT`));
  }),
}));

// Shared mock db instance
const mockDbInstance = {
  prepare: vi.fn(),
  close: vi.fn(),
  __throwOnConstruct: false,
};

// Mock better-sqlite3 as a class so `new Database(...)` works
vi.mock("better-sqlite3", () => ({
  default: class MockDatabase {
    constructor() {
      if (mockDbInstance.__throwOnConstruct) {
        throw new Error("SQLITE_CANTOPEN: unable to open database file");
      }
      return mockDbInstance;
    }
  },
}));

const DARWIN_DB =
  "/mock/home/Library/Application Support/Cursor/User/globalStorage/state.vscdb";
const DARWIN_INSIDERS_DB =
  "/mock/home/Library/Application Support/Cursor - Insiders/User/globalStorage/state.vscdb";
const LINUX_DB = "/mock/home/.config/Cursor/User/globalStorage/state.vscdb";
const LINUX_LOWER_DB = "/mock/home/.config/cursor/User/globalStorage/state.vscdb";

/** Make every `prepare(sql).get(key)` resolve from a key → value map. */
function mockItemTable(values) {
  mockDbInstance.prepare.mockImplementation(() => ({
    get: vi.fn((key) => (key in values ? { value: values[key] } : undefined)),
  }));
}

// We need to dynamically import after mocks are registered
let GET;

describe("GET /api/oauth/cursor/auto-import", () => {
  const originalPlatform = process.platform;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockDbInstance.__throwOnConstruct = false;
    // Force darwin so macOS-specific logic is exercised
    Object.defineProperty(process, "platform", { value: "darwin", writable: true });
    // Re-import to pick up fresh mocks each run
    const mod = await import("../../src/app/api/oauth/cursor/auto-import/route.js");
    GET = mod.GET;
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform, writable: true });
  });

  // ── Database discovery ────────────────────────────────────────────────

  it("returns not-found listing every macOS candidate when none is accessible", async () => {
    vi.mocked(fsPromises.access).mockRejectedValue(new Error("ENOENT"));

    const response = await GET();

    expect(response.body.found).toBe(false);
    expect(response.body.error).toContain("Cursor database not found");
    // The message must list what was actually probed.
    expect(response.body.error).toContain(DARWIN_DB);
    expect(response.body.error).toContain(DARWIN_INSIDERS_DB);
  });

  it("falls back to manual paste when the macOS db exists but cannot be opened", async () => {
    vi.mocked(fsPromises.access).mockResolvedValue();
    mockDbInstance.__throwOnConstruct = true;

    const response = await GET();

    expect(response.body.found).toBe(false);
    expect(response.body.windowsManual).toBe(true);
    expect(response.body.dbPath).toBe(DARWIN_DB);
  });

  // ── Token extraction ──────────────────────────────────────────────────

  it("extracts tokens using exact keys", async () => {
    vi.mocked(fsPromises.access).mockResolvedValue();
    mockItemTable({
      "cursorAuth/accessToken": "test-token",
      "storage.serviceMachineId": "test-machine-id",
    });

    const response = await GET();

    expect(response.body.found).toBe(true);
    expect(response.body.accessToken).toBe("test-token");
    expect(response.body.machineId).toBe("test-machine-id");
    expect(mockDbInstance.close).toHaveBeenCalled();
  });

  it("unwraps JSON-encoded string values", async () => {
    vi.mocked(fsPromises.access).mockResolvedValue();
    mockItemTable({
      "cursorAuth/accessToken": '"json-token"',
      "storage.serviceMachineId": '"json-machine-id"',
    });

    const response = await GET();

    expect(response.body.found).toBe(true);
    expect(response.body.accessToken).toBe("json-token");
    expect(response.body.machineId).toBe("json-machine-id");
  });

  it("uses the second access-token key when the first is absent", async () => {
    vi.mocked(fsPromises.access).mockResolvedValue();
    mockItemTable({
      "cursorAuth/token": "alt-token",
      "telemetry.machineId": "alt-machine",
    });

    const response = await GET();

    expect(response.body.found).toBe(true);
    expect(response.body.accessToken).toBe("alt-token");
    expect(response.body.machineId).toBe("alt-machine");
  });

  it("asks for manual paste when the db holds no token pair", async () => {
    vi.mocked(fsPromises.access).mockResolvedValue();
    mockItemTable({});

    const response = await GET();

    expect(response.body.found).toBe(false);
    expect(response.body.windowsManual).toBe(true);
    expect(response.body.dbPath).toBe(DARWIN_DB);
  });

  // ── Other platforms ───────────────────────────────────────────────────

  it("probes the ~/.config candidates on linux", async () => {
    Object.defineProperty(process, "platform", { value: "linux", writable: true });
    vi.mocked(fsPromises.access).mockRejectedValue(new Error("ENOENT"));

    const response = await GET();

    expect(response.body.found).toBe(false);
    expect(response.body.error).toContain(LINUX_DB);
    expect(response.body.error).toContain(LINUX_LOWER_DB);
  });

  it("treats unknown platforms like linux instead of rejecting them", async () => {
    Object.defineProperty(process, "platform", { value: "freebsd", writable: true });
    vi.mocked(fsPromises.access).mockRejectedValue(new Error("ENOENT"));

    const response = await GET();

    expect(response.status).toBe(200);
    expect(response.body.found).toBe(false);
    expect(response.body.error).toContain(LINUX_DB);
  });
});
