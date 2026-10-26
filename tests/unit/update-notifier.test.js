import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// The notifier fetches the fork repo's tags (via global fetch) and keeps
// per-process global state; isolate both between tests.
const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
}));

let updateNotifier;

const tagsResponse = (...names) => ({
  ok: true,
  json: async () => names.map((name) => ({ name })),
});

beforeEach(async () => {
  delete global.__updateNotifierState;
  delete global.__updateNotifierEmitter;
  delete global.__updateNotifierTimerStarted;
  vi.resetModules();
  vi.stubGlobal("fetch", mocks.fetch);
  mocks.fetch.mockReset();
  mocks.fetch.mockResolvedValue(tagsResponse("v1.0.28"));
  updateNotifier = await import("../../src/lib/updateNotifier.js");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("updateNotifier", () => {
  it("reports no update when the latest tag matches the current version", async () => {
    const info = await updateNotifier.checkForUpdate();

    expect(info.hasUpdate).toBe(false);
    expect(info.currentVersion).toBe("1.0.28");
    expect(info.latestVersion).toBe("1.0.28");
    expect(info.source).toBe("https://github.com/arsydoni4326-alt/9routercustom.git");
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    // Sourced from the GitHub tags API (newest-first), not package.json.
    expect(mocks.fetch.mock.calls[0][0]).toContain("/tags");
  });

  it("reports an update and emits an event when the latest tag is newer", async () => {
    mocks.fetch.mockResolvedValue(tagsResponse("v1.0.29"));

    const listener = vi.fn();
    updateNotifier.onUpdateAvailable(listener);

    const info = await updateNotifier.checkForUpdate();

    expect(info.hasUpdate).toBe(true);
    expect(info.latestVersion).toBe("1.0.29");
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0][0].latestVersion).toBe("1.0.29");
  });

  it("treats a suffixed custom tag with the same base version as no update", async () => {
    mocks.fetch.mockResolvedValue(tagsResponse("v1.0.28-arsydoni4326-alt"));

    const info = await updateNotifier.checkForUpdate();

    expect(info.latestVersion).toBe("1.0.28-arsydoni4326-alt");
    expect(info.hasUpdate).toBe(false);
  });

  it("treats a newer suffixed custom tag as an update", async () => {
    mocks.fetch.mockResolvedValue(tagsResponse("v1.0.29-arsydoni4326-alt"));

    const info = await updateNotifier.checkForUpdate();

    expect(info.hasUpdate).toBe(true);
    expect(info.latestVersion).toBe("1.0.29-arsydoni4326-alt");
  });

  it("throttles repeat checks inside the cooldown window", async () => {
    await updateNotifier.checkForUpdate();
    await updateNotifier.checkForUpdate();

    // Second call is served from cache — no extra GitHub request.
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });

  it("checks again after the cooldown window has passed", async () => {
    await updateNotifier.checkForUpdate();

    // Simulate the cooldown elapsing.
    global.__updateNotifierState.lastCheckAt = 0;

    mocks.fetch.mockResolvedValue(tagsResponse("v1.0.30"));
    const info = await updateNotifier.checkForUpdate();

    expect(mocks.fetch).toHaveBeenCalledTimes(2);
    expect(info.hasUpdate).toBe(true);
    expect(info.latestVersion).toBe("1.0.30");
  });

  it("fails gracefully when the GitHub fetch fails", async () => {
    mocks.fetch.mockRejectedValue(new Error("network down"));

    const info = await updateNotifier.checkForUpdate();

    expect(info.hasUpdate).toBe(false);
    expect(info.latestVersion).toBeNull();
  });

  it("unsubscribes listeners returned by onUpdateAvailable", async () => {
    mocks.fetch.mockResolvedValue(tagsResponse("v1.0.31"));
    const listener = vi.fn();
    const unsubscribe = updateNotifier.onUpdateAvailable(listener);

    await updateNotifier.checkForUpdate();
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();

    // Cooldown passed + newer tag again → would emit if still subscribed.
    global.__updateNotifierState.lastCheckAt = 0;
    mocks.fetch.mockResolvedValue(tagsResponse("v1.0.32"));
    await updateNotifier.checkForUpdate();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("getUpdateInfo returns cached info without a network request", async () => {
    await updateNotifier.checkForUpdate();

    const info = updateNotifier.getUpdateInfo();

    expect(info.hasUpdate).toBe(false);
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });

  it("periodically polls the fork repo for the latest incoming tag", async () => {
    vi.useFakeTimers();
    delete global.__updateNotifierState;
    delete global.__updateNotifierEmitter;
    delete global.__updateNotifierTimerStarted;
    vi.resetModules();
    vi.stubGlobal("fetch", mocks.fetch);
    mocks.fetch.mockReset();
    mocks.fetch.mockResolvedValue(tagsResponse("v1.0.33"));
    updateNotifier = await import("../../src/lib/updateNotifier.js");

    // The poller only fires after the configured interval — no check at startup.
    expect(mocks.fetch).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(15 * 60 * 1000);

    expect(mocks.fetch).toHaveBeenCalled();
    expect(updateNotifier.getUpdateInfo().hasUpdate).toBe(true);
  });
});