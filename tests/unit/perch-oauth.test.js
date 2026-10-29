import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import perch from "../../src/lib/oauth/providers/perch.js";
import { getProvider } from "../../src/lib/oauth/providers/index.js";
import { FREE_PROVIDERS } from "../../src/shared/constants/providers.js";
import REGISTRY from "../../open-sse/providers/registry/index.js";
import { refreshPerchToken } from "../../open-sse/services/tokenRefresh/providers.js";

const CONFIG = {
  appUrl: "https://app.perchai.app",
  configUrl: "https://app.perchai.app/api/perch-terminal/cli-auth/config",
  supabaseUrl: "https://proj.supabase.co",
  anonKey: "sb_publishable_test",
  providers: ["google", "github"],
  redirectHost: "127.0.0.1",
};

const CREDS = {
  providerSpecificData: {
    supabaseUrl: "https://proj.supabase.co",
    anonKey: "sb_publishable_test",
  },
};

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

let fetchMock;
beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("perch OAuth provider", () => {
  it("is registered as a multi-account OAuth provider, not noAuth", () => {
    expect(getProvider("perch-cli")).toBe(perch);

    const entry = REGISTRY.find((r) => r.id === "perch-cli");
    expect(entry.authModes).toEqual(["oauth"]);
    expect(entry.hasOAuth).toBe(true);
    expect(entry.noAuth).toBeUndefined();
    expect(entry.oauth.supabaseUrl).toBeTruthy();

    // The dashboard reads FREE_PROVIDERS to decide between the noAuth card and
    // the Connections/OAuth card.
    expect(FREE_PROVIDERS["perch-cli"].noAuth).toBeUndefined();
    expect(FREE_PROVIDERS["perch-cli"].authModes).toEqual(["oauth"]);
  });

  it("exposes Roost plus the live Starter model slugs", () => {
    const entry = REGISTRY.find((r) => r.id === "perch-cli");
    expect(entry.models.map((m) => m.id)).toEqual([
      "roost",
      "qwen-3.8-max",
      "laguna-s",
      "deepseek-flash-starter",
      "glm-5.3-flash-starter",
    ]);
  });

  it("builds a Supabase authorize URL with PKCE + loopback redirect", () => {
    const url = new URL(
      perch.buildAuthUrl(
        CONFIG,
        "http://127.0.0.1:3000/callback",
        "state",
        "challenge-123",
      ),
    );
    expect(url.origin + url.pathname).toBe("https://proj.supabase.co/auth/v1/authorize");
    expect(url.searchParams.get("provider")).toBe("google");
    expect(url.searchParams.get("redirect_to")).toBe("http://127.0.0.1:3000/callback");
    expect(url.searchParams.get("code_challenge")).toBe("challenge-123");
    expect(url.searchParams.get("code_challenge_method")).toBe("s256");
    expect(url.searchParams.get("prompt")).toBe("select_account");
  });

  it("supports GitHub without the Google account picker", () => {
    const url = new URL(
      perch.buildAuthUrl(CONFIG, "http://127.0.0.1:3000/callback", "s", "c", {
        provider: "github",
      }),
    );
    expect(url.searchParams.get("provider")).toBe("github");
    expect(url.searchParams.get("prompt")).toBeNull();
  });

  it("exchanges the PKCE code at Supabase's token endpoint", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        access_token: "at",
        refresh_token: "rt",
        expires_in: 3600,
        user: { id: "u1", email: "a@b.c", user_metadata: { full_name: "Perch User" } },
      }),
    );

    const tokens = await perch.exchangeToken(
      CONFIG,
      "auth-code",
      "http://127.0.0.1:3000/callback",
      "verifier",
    );

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://proj.supabase.co/auth/v1/token?grant_type=pkce");
    expect(init.headers.apikey).toBe("sb_publishable_test");
    expect(JSON.parse(init.body)).toEqual({
      auth_code: "auth-code",
      code_verifier: "verifier",
    });

    const mapped = perch.mapTokens(tokens);
    expect(mapped.accessToken).toBe("at");
    expect(mapped.refreshToken).toBe("rt");
    expect(mapped.expiresIn).toBe(3600);
    expect(mapped.email).toBe("a@b.c");
    expect(mapped.displayName).toBe("Perch User");
    expect(mapped.providerSpecificData.userId).toBe("u1");
    expect(mapped.providerSpecificData.supabaseUrl).toBe("https://proj.supabase.co");
  });

  it("fetches the live Supabase config (same endpoint as the CLI)", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        ok: true,
        appUrl: "https://app.perchai.app",
        supabaseUrl: "https://live.supabase.co",
        supabaseAnonKey: "live-key",
        providers: ["google"],
      }),
    );

    const config = await perch.prepareConfig(CONFIG);
    expect(fetchMock.mock.calls[0][0]).toBe(CONFIG.configUrl);
    expect(config.supabaseUrl).toBe("https://live.supabase.co");
    expect(config.anonKey).toBe("live-key");
  });

  it("refreshes with a JSON body + apikey and keeps the rotated refresh token", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        access_token: "new-at",
        refresh_token: "new-rt",
        expires_in: 3600,
        user: { id: "u1", email: "a@b.c" },
      }),
    );

    const result = await refreshPerchToken("old-rt-perch-test", CREDS, {
      warn() {},
    });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://proj.supabase.co/auth/v1/token?grant_type=refresh_token");
    expect(init.headers.apikey).toBe("sb_publishable_test");
    expect(JSON.parse(init.body)).toEqual({ refresh_token: "old-rt-perch-test" });
    expect(result.accessToken).toBe("new-at");
    expect(result.refreshToken).toBe("new-rt");
    expect(result.expiresIn).toBe(3600);
    expect(result.providerSpecificData.email).toBe("a@b.c");
  });

  it("marks a rejected refresh token as invalid_grant (re-login, no retry)", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ error_code: "validation_failed", msg: "Refresh token is not valid" }, 400),
    );

    const result = await refreshPerchToken("revoked-rt-perch-test", CREDS, {
      warn() {},
    });
    expect(result).toEqual({ error: "invalid_grant" });
  });
});
