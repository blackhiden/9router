import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const fx = vi.hoisted(() => ({
  keys: {},
  combos: [],
  aliases: {},
  nodes: [],
  edgeVoices: vi.fn(),
  localVoices: vi.fn(),
}));

vi.mock("open-sse/handlers/ttsCore.js", () => ({
  VOICE_FETCHERS: {
    "edge-tts": fx.edgeVoices,
    "local-device": fx.localVoices,
    elevenlabs: vi.fn(),
  },
}));
vi.mock("@/lib/db/repos/apiKeysRepo.js", () => ({
  getApiKeyByKey: async (k) => fx.keys[k] || null,
}));
vi.mock("@/lib/db/repos/combosRepo.js", () => ({
  getCombos: async () => fx.combos,
}));
vi.mock("@/lib/localDb", () => ({
  getModelAliases: async () => fx.aliases,
  getComboByName: async () => null,
  getProviderNodes: async () => fx.nodes,
}));
vi.mock("@/sse/utils/logger.js", () => ({
  warn: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
  error: vi.fn(),
}));

import { GET } from "@/app/api/v1/audio/voices/route.js";

function makeReq(query, key) {
  return new NextRequest(`https://router.example/v1/audio/voices?${query}`, {
    headers: key ? { Authorization: `Bearer ${key}` } : {},
  });
}

describe("/v1/audio/voices key-access + direct voice listing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fx.keys = {
      "sk-edge-only": {
        id: "k1",
        name: "edge-only",
        isActive: true,
        access: { restricted: true, allow: ["edge-tts"] },
      },
      "sk-el-only": {
        id: "k2",
        name: "el-only",
        isActive: true,
        access: { restricted: true, allow: ["el/voice-1"] },
      },
      "sk-open": {
        id: "k3",
        name: "open",
        isActive: true,
        access: { restricted: false, allow: [] },
      },
    };
    fx.edgeVoices.mockResolvedValue([
      { ShortName: "en-US-JennyNeural", FriendlyName: "Jenny", Locale: "en-US", Gender: "Female" },
    ]);
    fx.localVoices.mockResolvedValue([
      { id: "local-1", name: "Local 1", locale: "en_US", lang: "en", country: "US", gender: "Female" },
    ]);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      voices: [{ id: "voice-1", name: "Rachel", lang: "en", gender: "Female" }],
    }), { status: 200, headers: { "Content-Type": "application/json" } })));
  });

  afterEach(() => vi.unstubAllGlobals());

  it("denies restricted keys for disallowed edge-tts without invoking listTtsVoices", async () => {
    const res = await GET(makeReq("provider=edge-tts", "sk-el-only"));
    expect(res.status).toBe(403);
    expect(fx.edgeVoices).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("denies restricted keys for disallowed elevenlabs without fetching internal route", async () => {
    const res = await GET(makeReq("provider=elevenlabs", "sk-edge-only"));
    expect(res.status).toBe(403);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("serves edge-tts directly via listTtsVoices without HTTP self-fetch when key allows it", async () => {
    const res = await GET(makeReq("provider=edge-tts&lang=en", "sk-edge-only"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      object: "list",
      data: [{ id: "en-US-JennyNeural", name: "Jenny", lang: "en", gender: "Female", model: "edge-tts/en-US-JennyNeural" }],
    });
    expect(fx.edgeVoices).toHaveBeenCalledTimes(1);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("allows elevenlabs voice listing when a model under its alias is allowed", async () => {
    const res = await GET(makeReq("provider=elevenlabs&lang=en", "sk-el-only"));
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual([
      { id: "voice-1", name: "Rachel", lang: "en", gender: "Female", model: "el/voice-1" },
    ]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("serves local-device directly for unrestricted keys", async () => {
    const res = await GET(makeReq("provider=local-device", "sk-open"));
    expect(res.status).toBe(200);
    expect((await res.json()).data[0].model).toBe("local-device/local-1");
    expect(fx.localVoices).toHaveBeenCalledTimes(1);
    expect(fetch).not.toHaveBeenCalled();
  });
});
