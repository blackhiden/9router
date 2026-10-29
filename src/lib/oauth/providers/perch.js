import { PERCH_CONFIG } from "../constants/oauth.js";

/**
 * Perch CLI login — Perch's own auth is Supabase Auth (OAuth2 + PKCE).
 *
 * The CLI (`perch login`) does exactly this, verified against
 * perchai-cli@2.4.120/dist/perch.mjs:
 *   1) GET {appUrl}/api/perch-terminal/cli-auth/config
 *      → { supabaseUrl, supabaseAnonKey, providers, redirectHost }
 *   2) Open {supabaseUrl}/auth/v1/authorize?provider=google
 *      &redirect_to=http://127.0.0.1:<port>/callback&code_challenge=…
 *   3) POST {supabaseUrl}/auth/v1/token?grant_type=pkce
 *      { auth_code, code_verifier } → Supabase session
 *
 * The callback must be a loopback IP: GoTrue's IsRedirectURLValid accepts any
 * IP whose IsLoopback() is true, regardless of port or allow-list. `localhost`
 * is a hostname, so it is NOT covered by that rule — hence 127.0.0.1.
 *
 * Each 9router connection stores one Supabase session, so the same Perch
 * account can be added once and different accounts side by side.
 */

const CONFIG_TTL_MS = 10 * 60 * 1000;
let configCache = null;

async function loadAuthConfig() {
  if (configCache && Date.now() < configCache.expiresAt) return configCache.value;

  const res = await fetch(PERCH_CONFIG.configUrl, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`Perch auth config failed (HTTP ${res.status})`);

  const data = await res.json();
  if (!data?.ok || !data.supabaseUrl || !data.supabaseAnonKey) {
    throw new Error("Perch auth config is missing supabaseUrl/supabaseAnonKey");
  }

  const value = {
    appUrl: data.appUrl || PERCH_CONFIG.appUrl,
    supabaseUrl: String(data.supabaseUrl).replace(/\/+$/, ""),
    anonKey: data.supabaseAnonKey,
    providers: Array.isArray(data.providers) ? data.providers : PERCH_CONFIG.providers,
  };
  configCache = { value, expiresAt: Date.now() + CONFIG_TTL_MS };
  return value;
}

const perch = {
  config: PERCH_CONFIG,
  flowType: "authorization_code_pkce",

  // The config endpoint is Perch's own source of truth (the CLI reads it too),
  // so a rotated Supabase project/anon key needs no 9router release.
  prepareConfig: async (config) => ({ ...config, ...(await loadAuthConfig()) }),

  buildAuthUrl: (config, redirectUri, state, codeChallenge, meta = {}) => {
    const provider = meta.provider === "github" ? "github" : "google";
    const params = new URLSearchParams({
      provider,
      redirect_to: redirectUri,
      code_challenge: codeChallenge,
      code_challenge_method: "s256",
    });
    if (provider === "google") params.set("prompt", "select_account");
    return `${config.supabaseUrl}/auth/v1/authorize?${params.toString()}`;
  },

  exchangeToken: async (config, code, redirectUri, codeVerifier, state, meta = {}) => {
    const res = await fetch(`${config.supabaseUrl}/auth/v1/token?grant_type=pkce`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        apikey: config.anonKey,
      },
      body: JSON.stringify({ auth_code: code, code_verifier: codeVerifier }),
    });

    const data = await res.json().catch(() => null);
    if (!res.ok) {
      throw new Error(data?.msg || data?.error_description || `Perch token exchange failed (HTTP ${res.status})`);
    }

    // Threaded through mapTokens → providerSpecificData so the refresh handler
    // and the executor hit the same Supabase project the login used.
    return {
      ...data,
      _supabaseUrl: config.supabaseUrl,
      _anonKey: config.anonKey,
      _appUrl: config.appUrl,
      _provider: meta.provider === "github" ? "github" : "google",
    };
  },

  mapTokens: (tokens) => {
    const user = tokens.user || {};
    return {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token || null,
      expiresIn: tokens.expires_in,
      email: user.email || undefined,
      displayName:
        user.user_metadata?.full_name ||
        user.user_metadata?.name ||
        user.email ||
        undefined,
      providerSpecificData: {
        authMethod: "oauth",
        userId: user.id || null,
        appUrl: tokens._appUrl || PERCH_CONFIG.appUrl,
        supabaseUrl: tokens._supabaseUrl || PERCH_CONFIG.supabaseUrl,
        anonKey: tokens._anonKey || PERCH_CONFIG.anonKey,
        oauthProvider: tokens._provider || null,
      },
    };
  },
};

export default perch;
