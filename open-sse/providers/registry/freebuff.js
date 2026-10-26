/**
 * Freebuff — the free, ad-supported coding agent by Codebuff (freebuff.com).
 *
 * The Freebuff CLI (github.com/CodebuffAI/freebuff) is an interactive TUI that
 * talks to the Codebuff/Freebuff backend. Two hosts are involved:
 *   - session claims go to POST /api/v1/freebuff/session/admission with
 *       x-freebuff-model + x-freebuff-wallet-spend-limit: session
 *       (POST /api/v1/freebuff/session is the pre-0.2 fallback — it 404/405s now)
 *   - login flow (freebuff mode) runs on  https://freebuff.com
 *       POST /api/auth/cli/code {fingerprintId} → { loginUrl, fingerprintHash, expiresAt }
 *       open loginUrl in browser, then GET /api/auth/cli/status until {user}.
 *       (The server echoes the request host into loginUrl, so calling
 *       freebuff.com yields freebuff.com/login?auth_code=… exactly like the
 *       official CLI — www.codebuff.com would yield the wrong link.)
 *   - LLM traffic goes to the OpenAI-compatible endpoint on
 *       https://www.codebuff.com/api/v1/chat/completions
 *     (freebuff.com does NOT serve /api/v1/* — it 404s with the SPA shell.)
 *
 * Both hosts share one backend: the authToken obtained via the freebuff.com
 * login validates against www.codebuff.com (Bearer auth). The request body
 * must carry the CLI's `codebuff` provider block
 * (`codebuff_metadata.run_id/client_id/cost_mode`) — injected by
 * executors/freebuff.js. cost_mode:"free" is what admits a session on the free
 * (country-gated, session-limited) tier instead of billing credits.
 */
export default {
  id: "freebuff",
  priority: 45,
  hasFree: true,
  alias: "fb",
  uiAlias: "fb",
  display: {
    name: "Freebuff",
    icon: "bolt",
    color: "#84CC16",
    textIcon: "FB",
    website: "https://freebuff.com",
    notice: {
      signupUrl: "https://freebuff.com",
      text: "Free ad-supported coding agent by Codebuff. Sign in with your Freebuff/Codebuff account via browser login. Each model is priced in Freebucks per hour of session, charged once when the session starts. Your daily Freebucks refill at midnight Pacific; the wallet keeps what you buy or earn. Free tier is ad-supported and country-gated: full mode (5 hours of agent time/day) in supported regions, limited mode elsewhere where only some models are free. ⚠️ One account has ONE active session locked to ONE model — requesting a different model while a session is active returns 'model_locked' (409); wait for the session to expire (~1h) instead of forcing re-claims (ToS: one account per person, human-initiated sessions only). DeepSeek V4.1 Flash closes daily ~00:00–10:00 UTC (peak window) — MiMo is the fallback then.",
    },
  },
  category: "free",
  authType: "oauth",
  authModes: ["oauth"],
  hasOAuth: true,
  transport: {
    baseUrl: "https://www.codebuff.com/api/v1/chat/completions",
    format: "openai",
    headers: {
      "User-Agent": "ai-sdk/openai-compatible/1.0/codebuff",
    },
    retry: {
      429: { attempts: 2, delayMs: 2000 },
      503: { attempts: 2, delayMs: 1500 },
    },
    // Session endpoint doubles as the quota API: GET /api/v1/freebuff/session
    // returns the shared daily session quota (rateLimitsByModel) without
    // claiming anything — POST would burn a session, so quota reads are GET
    // only (see services/usage/freebuff.js).
    usage: {
      url: "https://www.codebuff.com/api/v1/freebuff/session",
    },
  },
  features: {
    usage: true,
  },
  // Wire ids + labels mirror the freebuff CLI 0.2.34 picker (FREEBUFF_MODELS)
  // and the server catalog at /api/v1/freebuff/models, as of 2026-10-25. NO
  // per-model prices live here: Freebucks pricing is server-authoritative — the
  // session response's `freebucks` block carries `prices` (model → Freebucks/hr)
  // plus an announced `priceChanges` schedule (see services/usage/freebuff.js,
  // which folds both in — the CLI hardcodes no number either).
  //
  // A row the backend advertises but a free account cannot claim is omitted, so
  // a pick never fails on a dead slot: luna-es / kimi-k3-eco (god-only),
  // z-ai/glm-5.2 (referral reward), the `-max` variants (provisioned per
  // account), stealth/ox-alpha and stealth/space-bunny-alpha (catalogue rows
  // outside the picker), and the retired picks (openai/gpt-5.6-luna,
  // deepseek-v4-pro, minimax-m3 — 404 model_not_found).
  //
  // Two rows are conditional and the executor checks the live session status
  // before claiming them: deepseek/deepseek-v4-flash(-fast) are `off_peak_only`
  // on the server (closed ~00:00–10:00 UTC daily — MiMo is the fallback then)
  // and anthropic/claude-fable-5.1 is a capacity-limited wave trial only
  // admitted while the backend advertises it via limitedModelOffers.
  models: [
    { id: "mimo/mimo-v2.5", name: "MiMo v2.6 Flash Fast" },
    { id: "z-ai/glm-5.3-flash", name: "GLM 5.3 Flash" },
    { id: "deepseek/deepseek-v4-flash", name: "DeepSeek V4.1 Flash 10/17" },
    { id: "deepseek/deepseek-v4-flash-fast", name: "DeepSeek V4.1 Flash Fast 10/17" },
    { id: "openai/gpt-6-luna", name: "GPT-6 Luna" },
    { id: "mimo/mimo-v2.6-pro", name: "MiMo 2.6 Pro" },
    { id: "upstage/solar-mini4", name: "Solar Mini 4" },
    { id: "upstage/solar-pro4", name: "Solar Pro 4" },
    { id: "google/gemini-3.8-flash", name: "Gemini 3.8 Flash" },
    { id: "meta/muse-spark-1.3-contributor", name: "Muse Spark 1.3" },
    { id: "google/gemini-4-argon", name: "Gemini 4 Argon" },
    { id: "openai/gpt-6.1-sol", name: "GPT-6.1 Sol" },
    { id: "anthropic/claude-fable-5.1", name: "Claude Fable 5.1 (limited offer)" },
  ],
  // Login-flow host — the CLI in freebuff mode logs in via freebuff.com, and
  // the server builds loginUrl from the host it was called on, so the link the
  // user opens must come from freebuff.com to match the official CLI.
  oauth: {
    baseUrl: "https://freebuff.com",
    loginCodePath: "/api/auth/cli/code",
    loginStatusPath: "/api/auth/cli/status",
    oauthTimeoutMs: 300000,
  },
};
