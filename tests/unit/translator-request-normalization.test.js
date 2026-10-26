import { describe, it, expect } from "vitest";

import { FORMATS } from "../../open-sse/translator/formats.js";
import { translateRequest } from "../../open-sse/translator/index.js";
import { claudeToOpenAIRequest } from "../../open-sse/translator/request/claude-to-openai.js";
import { filterToOpenAIFormat } from "../../open-sse/translator/formats/openai.js";
import { parseSSELine } from "../../open-sse/utils/streamHelpers.js";

describe("request normalization", () => {
  // collapseTextParts only flattens a lone text block; several blocks stay a
  // block array so per-block fields (cache_control, provider hints) survive.
  it("claudeToOpenAIRequest collapses a single text block into a string", () => {
    const body = {
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    };

    const result = claudeToOpenAIRequest("gpt-oss:120b", body, true);
    expect(result.messages[0].content).toBe("hi");
  });

  it("claudeToOpenAIRequest keeps multiple text blocks as blocks", () => {
    const body = {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "hi" },
            { type: "text", text: "there" },
          ],
        },
      ],
    };

    const result = claudeToOpenAIRequest("gpt-oss:120b", body, true);
    expect(result.messages[0].content).toEqual([
      { type: "text", text: "hi" },
      { type: "text", text: "there" },
    ]);
  });

  it("claudeToOpenAIRequest preserves multimodal arrays", () => {
    const body = {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "describe" },
            {
              type: "image",
              source: {
                type: "base64",
                media_type: "image/png",
                data: "ZmFrZQ==",
              },
            },
          ],
        },
      ],
    };

    const result = claudeToOpenAIRequest("gpt-4o", body, true);
    expect(Array.isArray(result.messages[0].content)).toBe(true);
  });

  // filterToOpenAIFormat strips Claude-only blocks (signature/thinking) and keeps
  // text blocks as blocks; it never rewrites arrays into a joined string.
  it("filterToOpenAIFormat keeps text blocks and drops Claude-only fields", () => {
    const single = filterToOpenAIFormat({
      messages: [{
        role: "user",
        content: [{ type: "text", text: "a", cache_control: { type: "ephemeral" } }],
      }],
    });
    expect(single.messages[0].content).toEqual([{ type: "text", text: "a" }]);

    const multi = filterToOpenAIFormat({
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "a" },
            { type: "text", text: "b" },
          ],
        },
      ],
    });
    expect(multi.messages[0].content).toEqual([
      { type: "text", text: "a" },
      { type: "text", text: "b" },
    ]);
  });

  it("translateRequest keeps /v1/messages Claude->OpenAI text payloads string-safe", () => {
    const body = {
      model: "ollama/gpt-oss:120b",
      system: [{ type: "text", text: "You are helpful." }],
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "hello" },
            { type: "text", text: "world" },
          ],
        },
      ],
      stream: true,
    };

    const result = translateRequest(
      FORMATS.CLAUDE,
      FORMATS.OPENAI,
      "gpt-oss:120b",
      JSON.parse(JSON.stringify(body)),
      true,
      null,
      "ollama",
    );

    const userMessage = result.messages.find((m) => m.role === "user");
    expect(userMessage.content).toEqual([
      { type: "text", text: "hello" },
      { type: "text", text: "world" },
    ]);
  });

  it("translateRequest strips unsupported Anthropic output_config for MiniMax Claude-compatible endpoints", () => {
    const body = {
      model: "MiniMax-M2.7",
      system: [{ type: "text", text: "You are helpful." }],
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "continue" }],
        },
      ],
      max_tokens: 1024,
      output_config: {
        effort: "medium",
        format: {
          type: "json_schema",
          schema: {
            type: "object",
            properties: { title: { type: "string" } },
            required: ["title"],
            additionalProperties: false,
          },
        },
      },
    };

    const result = translateRequest(
      FORMATS.CLAUDE,
      FORMATS.CLAUDE,
      "MiniMax-M2.7",
      JSON.parse(JSON.stringify(body)),
      true,
      null,
      "minimax",
    );

    expect(result.output_config).toBeUndefined();
    expect(result.messages[0].content[0].text).toBe("continue");
  });

  it("translateRequest preserves output_config for Anthropic Claude", () => {
    const body = {
      model: "claude-sonnet-4.5",
      system: [{ type: "text", text: "You are helpful." }],
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "continue" }],
        },
      ],
      max_tokens: 1024,
      output_config: {
        format: { type: "json_schema", schema: { type: "object" } },
      },
    };

    const result = translateRequest(
      FORMATS.CLAUDE,
      FORMATS.CLAUDE,
      "claude-sonnet-4.5",
      JSON.parse(JSON.stringify(body)),
      true,
      null,
      "claude",
    );

    expect(result.output_config).toEqual(body.output_config);
  });

  it("parseSSELine supports provider raw NDJSON stream lines", () => {
    const raw = JSON.stringify({
      model: "gpt-oss:120b",
      message: { role: "assistant", content: "hello" },
      done: false,
    });

    // Raw NDJSON is only accepted when the caller declares the Ollama format.
    const parsed = parseSSELine(raw, FORMATS.OLLAMA);
    expect(parsed).toEqual({
      model: "gpt-oss:120b",
      message: { role: "assistant", content: "hello" },
      done: false,
    });
  });

  it("parseSSELine still supports SSE data lines", () => {
    const parsed = parseSSELine('data: {"choices":[{"delta":{"content":"hi"}}]}');
    expect(parsed.choices[0].delta.content).toBe("hi");
  });
});
