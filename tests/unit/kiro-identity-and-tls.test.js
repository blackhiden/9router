import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHash } from "crypto";

const SECRETS = ["test-access-token", "test-refresh-token", "test-client-id", "test-api-key"];

function assertKiroIdentityHeaders(headers, expectedClient = "runtime") {
  const entries = Object.entries(headers || {});
  const uaHits = entries.filter(([k]) => k.toLowerCase() === "user-agent");
  const amzHits = entries.filter(([k]) => k.toLowerCase() === "x-amz-user-agent");

  expect(uaHits).toHaveLength(1);
  expect(amzHits).toHaveLength(1);

  const ua = String(uaHits[0][1]);
  const amz = String(amzHits[0][1]);
  const expectedApi = expectedClient === "streaming" ? "codewhispererstreaming" : "codewhispererruntime";
  const expectedMetrics = expectedClient === "streaming" ? "E" : "N,E";

  expect(ua).toMatch(
    new RegExp(
      `^aws-sdk-js/1\\.0\\.0 ua/2\\.1 os/windows#10\\.0\\.26200 lang/js md/nodejs#22\\.21\\.1 api/${expectedApi}#1\\.0\\.0 m/${expectedMetrics} KiroIDE-1\\.4\\.154-[0-9a-f]{64}$`
    )
  );
  expect(amz).toMatch(/^aws-sdk-js\/1\.0\.0 KiroIDE-1\.4\.154-[0-9a-f]{64}$/);

  for (const secret of SECRETS) {
    expect(ua).not.toContain(secret);
    expect(amz).not.toContain(secret);
  }
}

describe("Kiro IDE 1.4.154 identity headers (issue #5613 / #5652)", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    globalThis.fetch = originalFetch;
  });

  afterEach(() => {
    vi.doUnmock("../../open-sse/utils/proxyFetch.js");
    vi.doUnmock("undici");
    globalThis.fetch = originalFetch;
  });

  it("builds deterministic hashed machineId and distinct runtime/streaming headers", async () => {
    const { KIRO_IDE_VERSION, buildKiroIdentityHeaders } = await import(
      "../../open-sse/shared/kiroIdentity.js"
    );

    expect(KIRO_IDE_VERSION).toBe("1.4.154");
    const expectedHash = createHash("sha256").update("test-client-id").digest("hex");

    const runtimeHeaders = buildKiroIdentityHeaders(
      {
        accessToken: "test-access-token",
        refreshToken: "test-refresh-token",
        providerSpecificData: { clientId: "test-client-id" },
      },
      "runtime"
    );
    assertKiroIdentityHeaders(runtimeHeaders, "runtime");
    expect(runtimeHeaders["X-Amz-User-Agent"]).toBe(`aws-sdk-js/1.0.0 KiroIDE-1.4.154-${expectedHash}`);

    const streamingHeaders = buildKiroIdentityHeaders(
      {
        accessToken: "test-access-token",
        refreshToken: "test-refresh-token",
        providerSpecificData: { clientId: "test-client-id" },
      },
      "streaming"
    );
    assertKiroIdentityHeaders(streamingHeaders, "streaming");

    const anonHeaders = buildKiroIdentityHeaders({});
    const anonHash = createHash("sha256").update("kiro-anonymous").digest("hex");
    expect(anonHeaders["X-Amz-User-Agent"]).toBe(`aws-sdk-js/1.0.0 KiroIDE-1.4.154-${anonHash}`);
  });

  it("applies streaming KiroIDE-1.4.154 identity on KiroExecutor.buildHeaders without duplicate UA keys", async () => {
    const { KiroExecutor } = await import("../../open-sse/executors/kiro.js");
    const executor = new KiroExecutor();
    const credentials = {
      accessToken: "test-access-token",
      refreshToken: "test-refresh-token",
      providerSpecificData: { clientId: "test-client-id", authMethod: "idc", region: "us-east-1" },
    };

    const headers = executor.buildHeaders(
      credentials,
      true,
      "https://q.us-east-1.amazonaws.com/generateAssistantResponse"
    );
    assertKiroIdentityHeaders(headers, "streaming");
    expect(headers.Authorization).toBe("Bearer test-access-token");
  });

  it("sends KiroIDE-1.4.154 runtime identity from resolveKiroModels", async () => {
    const { resolveKiroModels } = await import("../../open-sse/services/kiroModels.js");
    const calls = [];
    globalThis.fetch = vi.fn(async (url, init = {}) => {
      calls.push({ url: String(url), headers: init.headers || {} });
      return {
        ok: true,
        status: 200,
        json: async () => ({ models: [{ modelId: "auto", modelName: "Auto" }] }),
      };
    });

    const credentials = {
      accessToken: "test-access-token",
      refreshToken: "test-refresh-token",
      providerSpecificData: { clientId: "test-client-id", authMethod: "idc", region: "us-east-1" },
    };
    const result = await resolveKiroModels(credentials, { forceRefresh: true });
    expect(result?.models?.length).toBeGreaterThan(0);
    expect(calls).toHaveLength(1);
    assertKiroIdentityHeaders(calls[0].headers, "runtime");
  });

  it("sends KiroIDE-1.4.154 runtime identity across KiroService OAuth/API-key endpoints and fetchKiroProfileArn", async () => {
    const { KiroService } = await import("../../src/lib/oauth/services/kiro.js");
    const { fetchKiroProfileArn } = await import("../../src/lib/oauth/providerHelpers.js");
    const calls = [];
    globalThis.fetch = vi.fn(async (url, init = {}) => {
      calls.push({ url: String(url), headers: init.headers || {} });
      return {
        ok: true,
        status: 200,
        json: async () => ({
          models: [{ modelId: "auto", modelName: "Auto" }],
          profiles: [{ arn: "arn:aws:codewhisperer:us-east-1:123456789012:profile/ABC" }],
        }),
      };
    });

    const svc = new KiroService();
    await svc.listAvailableApiKeyModels("test-api-key");
    await svc.listAvailableProfiles("test-access-token");
    await svc.listAvailableModels("test-access-token", "arn:aws:codewhisperer:us-east-1:1:profile/A");
    const arn = await fetchKiroProfileArn("test-access-token");

    expect(arn).toBe("arn:aws:codewhisperer:us-east-1:123456789012:profile/ABC");
    expect(calls).toHaveLength(4);
    for (const call of calls) {
      assertKiroIdentityHeaders(call.headers, "runtime");
    }
  });

  it("sends KiroIDE-1.4.154 runtime identity on all three getKiroUsage attempts", async () => {
    const calls = [];
    vi.doMock("../../open-sse/utils/proxyFetch.js", () => ({
      proxyAwareFetch: vi.fn(async (url, init = {}) => {
        calls.push({ url: String(url), headers: init.headers || {} });
        return {
          ok: false,
          status: 500,
          text: async () => "stub failure",
        };
      }),
    }));

    const { getKiroUsage } = await import("../../open-sse/services/usage/kiro.js");
    await getKiroUsage("test-access-token", {
      clientId: "test-client-id",
      authMethod: "idc",
      region: "us-east-1",
    });

    expect(calls).toHaveLength(3);
    for (const call of calls) {
      assertKiroIdentityHeaders(call.headers, "runtime");
    }
  });
});

describe("proxyFetch TLS ECDH curve default (AWS OIDC compatibility)", () => {
  const savedCurve = process.env.NINEROUTER_TLS_ECDH_CURVE;

  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    if (savedCurve === undefined) delete process.env.NINEROUTER_TLS_ECDH_CURVE;
    else process.env.NINEROUTER_TLS_ECDH_CURVE = savedCurve;
    vi.doUnmock("undici");
  });

  it("defaults ecdhCurve to X25519:prime256v1:secp384r1 on direct and proxied dispatchers", async () => {
    delete process.env.NINEROUTER_TLS_ECDH_CURVE;
    const agentOpts = [];
    const proxyAgentOpts = [];

    vi.doMock("undici", async () => {
      const actual = await vi.importActual("undici");
      class MockAgent {
        constructor(opts) { agentOpts.push(opts); }
      }
      class MockProxyAgent {
        constructor(opts) { proxyAgentOpts.push(opts); }
      }
      return {
        ...actual,
        Agent: MockAgent,
        ProxyAgent: MockProxyAgent,
        fetch: vi.fn(async () => ({ ok: true, status: 200 })),
      };
    });

    const { proxyAwareFetch, resetDirectDispatchersForTests } = await import(
      "../../open-sse/utils/proxyFetch.js"
    );
    resetDirectDispatchersForTests();

    await proxyAwareFetch("https://oidc.us-east-1.amazonaws.com/client/register", { method: "POST" });
    await proxyAwareFetch(
      "https://oidc.us-east-1.amazonaws.com/client/register",
      { method: "POST" },
      { connectionProxyEnabled: true, connectionProxyUrl: "http://127.0.0.1:8888" }
    );

    expect(agentOpts[0].connect.ecdhCurve).toBe("X25519:prime256v1:secp384r1");
    expect(proxyAgentOpts[0].requestTls.ecdhCurve).toBe("X25519:prime256v1:secp384r1");
  });

  it("allows NINEROUTER_TLS_ECDH_CURVE env override", async () => {
    process.env.NINEROUTER_TLS_ECDH_CURVE = "prime256v1";
    const agentOpts = [];

    vi.doMock("undici", async () => {
      const actual = await vi.importActual("undici");
      class MockAgent {
        constructor(opts) { agentOpts.push(opts); }
      }
      return {
        ...actual,
        Agent: MockAgent,
        fetch: vi.fn(async () => ({ ok: true, status: 200 })),
      };
    });

    const { proxyAwareFetch, resetDirectDispatchersForTests } = await import(
      "../../open-sse/utils/proxyFetch.js"
    );
    resetDirectDispatchersForTests();

    await proxyAwareFetch("https://oidc.us-east-1.amazonaws.com/client/register", { method: "POST" });
    expect(agentOpts[0].connect.ecdhCurve).toBe("prime256v1");
  });
});
