// #1998 — Headroom compression treated a Codex (openai-responses) body.input
// array as OpenAI messages: it sent Responses items to /v1/compress and then
// assigned the returned OpenAI messages back to body.input, violating the
// Responses format contract. body.input must stay Responses-shaped.
import { describe, it, expect, vi, afterEach } from "vitest";
import { compressWithHeadroom } from "../../open-sse/rtk/headroom.js";

describe("compressWithHeadroom openai-responses format (#1998)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps body.input in Responses format after compressing an openai-responses request", async () => {
    // Headroom always returns compressed OpenAI-style messages.
    global.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        messages: [{ role: "user", content: "compressed text" }],
        tokens_before: 100,
        tokens_after: 90,
        tokens_saved: 10,
      }),
    }));

    const body = {
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "a long original message ".repeat(20) }],
        },
      ],
    };

    const data = await compressWithHeadroom(body, {
      enabled: true,
      url: "http://headroom.test",
      model: "gpt-5",
      format: "openai-responses",
    });

    expect(data).not.toBeNull();
    // body.input must remain Responses items (type:"message" + content array),
    // NOT the raw OpenAI messages ({ role, content: "<string>" }) the bug produced.
    expect(Array.isArray(body.input)).toBe(true);
    expect(body.input[0]).toMatchObject({ type: "message", role: "user" });
    expect(Array.isArray(body.input[0].content)).toBe(true);
    expect(typeof body.input[0].content).not.toBe("string");
  });

  // #2132 — Responses tool/reasoning history must never be collapsed into a
  // single OpenAI message. What is safe (and now supported) is compressing the
  // plain-text tool output in place: only `function_call_output.output` goes to
  // the proxy, and every item keeps its Responses shape.
  it("compresses only Responses tool-output text and keeps every item shape (#2132)", async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        messages: [{ role: "tool", tool_call_id: "headroom-tool-0", content: "ok" }],
        tokens_saved: 10,
      }),
    }));

    const input = [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "investigate bug" }],
      },
      {
        type: "function_call",
        call_id: "call_apply_patch_123",
        name: "apply_patch",
        arguments: "*** Begin Patch\n*** End Patch",
      },
      {
        type: "function_call_output",
        call_id: "call_apply_patch_123",
        output: "ok ".repeat(40).trim(),
      },
      {
        type: "reasoning",
        summary: [{ type: "summary_text", text: "Need a plan" }],
      },
    ];
    const body = {
      input: structuredClone(input),
      tools: [
        {
          type: "custom",
          name: "apply_patch",
          format: { type: "grammar", syntax: "lark", definition: "start: /.+/" },
        },
      ],
    };
    const diagnostics = {};

    const data = await compressWithHeadroom(body, {
      enabled: true,
      url: "http://headroom.test",
      model: "gpt-5",
      format: "openai-responses",
      diagnostics,
    });

    expect(data).not.toBeNull();

    // Only the tool-output leaves were sent for compression…
    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [, fetchOpts] = global.fetch.mock.calls[0];
    expect(JSON.parse(fetchOpts.body).messages).toEqual([
      { role: "tool", tool_call_id: "headroom-tool-0", content: input[2].output },
    ]);

    // …and the Responses contract survives: same item types, same order, and
    // the tool/reasoning items are left exactly as they arrived.
    expect(body.input.map((item) => item.type)).toEqual([
      "message",
      "function_call",
      "function_call_output",
      "reasoning",
    ]);
    expect(body.input[0]).toEqual(input[0]);
    expect(body.input[1]).toEqual(input[1]);
    expect(body.input[3]).toEqual(input[3]);
    // The tool output itself is the compressed text.
    expect(body.input[2].output).toBe("ok");
  });
});
