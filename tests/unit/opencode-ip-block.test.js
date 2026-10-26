// The free tier answers 403 with a reputation block ("abusive traffic") that
// shares no words with the rate-limit body. Before this was classified, the
// request died at the first pool instead of rotating to a clean egress.
import { describe, it, expect } from "vitest";
import { OpenCodeExecutor } from "open-sse/executors/opencode.js";

const ABUSE_BODY = JSON.stringify({
  type: "error",
  error: {
    type: "FreeTierError",
    message:
      "OpenCode's free models aren't available from your current network because we've " +
      "detected abusive traffic from this IP address. This isn't related to your account. " +
      "If you're on a VPN or proxy, turn it off and try again, or subscribe to OpenCode Go " +
      "at https://opencode.ai/go to keep building.",
  },
});

// Fingerprint rejection: the client shape is wrong, no pool can fix it.
const FINGERPRINT_BODY = JSON.stringify({
  type: "error",
  error: {
    type: "FreeTierError",
    message:
      "OpenCode's free tier can only be used from within OpenCode. " +
      "Download it at https://opencode.ai and keep building.",
  },
});

describe("opencode free-tier pool-scoped error classification", () => {
  const executor = new OpenCodeExecutor();

  it("marks an abuse/reputation 403 as pool-scoped ip-blocked", () => {
    const parsed = executor.parseError({ status: 403 }, ABUSE_BODY);
    expect(parsed).not.toBeNull();
    expect(parsed.poolScoped).toEqual({ reason: "ip-blocked" });
    expect(parsed.status).toBe(403);
  });

  it("marks an 'abusive traffic' 429 as pool-scoped too", () => {
    expect(executor.parseError({ status: 429 }, ABUSE_BODY)?.poolScoped)
      .toEqual({ reason: "ip-blocked" });
  });

  it("keeps rate-limit bodies on the existing ip-limit reason", () => {
    const parsed = executor.parseError({ status: 429 }, '{"error":{"message":"Free usage limit reached, retry later"}}');
    expect(parsed?.poolScoped).toEqual({ reason: "ip-limit" });
  });

  it("does NOT rotate pools for a fingerprint rejection", () => {
    expect(executor.parseError({ status: 403 }, FINGERPRINT_BODY)).toBeNull();
  });

  it("leaves unrelated failures to the default parser", () => {
    expect(executor.parseError({ status: 400 }, '{"error":{"message":"Model is unavailable."}}')).toBeNull();
    expect(executor.parseError({ status: 500 }, "internal error")).toBeNull();
    expect(executor.parseError({ status: 200 }, ABUSE_BODY)).toBeNull();
  });
});
