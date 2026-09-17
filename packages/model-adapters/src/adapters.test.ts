/**
 * Model adapters and their failure modes.
 *
 * The property under test is not "the adapter can call a model" — no test can
 * observe that without a network. It is that every adapter **degrades honestly**:
 * unavailable when unconfigured, throwing a typed error rather than returning an
 * empty completion, and parsing only what it can verify. A model adapter that
 * silently returns `""` on a bad response turns into a claim-less extraction, which
 * looks exactly like "the evidence supported nothing".
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AnthropicAdapter,
  DeterministicStandInAdapter,
  LlmUnavailableError,
  ModelExtractor,
  OllamaAdapter,
  OpenAiCompatibleAdapter,
  extractJsonObject,
} from "./index.ts";

const CONTENT = "I approved the Sunday 02:00 UTC deploy window.";

describe("adapter availability", () => {
  it("reports an OpenAI-compatible adapter unavailable without a model name", () => {
    const adapter = new OpenAiCompatibleAdapter({ baseUrl: "http://x", apiKey: null, model: "" });
    assert.equal(adapter.available, false);
  });

  it("reports an Ollama adapter unavailable without a base url", () => {
    assert.equal(new OllamaAdapter({ baseUrl: "", model: "llama3" }).available, false);
  });

  it("reports an Anthropic adapter unavailable without a key", () => {
    assert.equal(
      new AnthropicAdapter({ baseUrl: "https://api.anthropic.com", apiKey: "", model: "claude-x" }).available,
      false,
    );
  });

  it("throws a typed error rather than returning an empty completion", async () => {
    const adapter = new OpenAiCompatibleAdapter({ baseUrl: "", apiKey: null, model: "" });
    await assert.rejects(
      () => adapter.complete({ system: "s", user: "u" }),
      (error: unknown) => error instanceof LlmUnavailableError,
    );
  });

  it("lets the extractor return no proposals when its adapter is unavailable, without throwing", async () => {
    // The write path must survive a model outage by degrading to deterministic
    // extraction. A model extractor that threw here would fail the whole event.
    const extractor = new ModelExtractor({
      adapter: new OpenAiCompatibleAdapter({ baseUrl: "", apiKey: null, model: "" }),
    });
    const proposals = await extractor.extract({
      content: CONTENT,
      origin: "user",
      actor_id: "user:alice",
      media_type: "text/plain",
      instruction_flagged: false,
      external: false,
    });
    assert.deepEqual(proposals, []);
  });
});

describe("response parsing", () => {
  it("accepts a bare JSON object with byte offsets inside the payload", () => {
    const extractor = new ModelExtractor({ adapter: new DeterministicStandInAdapter() });
    const proposals = extractor.parse(
      JSON.stringify({
        claims: [
          {
            kind: "decision",
            subject: "user:alice",
            predicate: "deploy.window",
            object: "Sunday 02:00 UTC",
            spans: [{ start: 2, end: 22 }],
          },
        ],
      }),
      CONTENT,
    );
    assert.equal(proposals.length, 1);
    assert.equal(proposals[0]?.kind, "decision");
    assert.equal(proposals[0]?.spans[0]?.start, 2);
  });

  it("accepts a response wrapped in prose or a code fence", () => {
    const extractor = new ModelExtractor({ adapter: new DeterministicStandInAdapter() });
    const wrapped = [
      "Sure, here are the claims:",
      "```json",
      JSON.stringify({
        claims: [
          { kind: "decision", subject: "user:alice", predicate: "p", object: "o", spans: [{ start: 0, end: 5 }] },
        ],
      }),
      "```",
    ].join("\n");
    assert.equal(extractor.parse(wrapped, CONTENT).length, 1);
  });

  it("discards an out-of-range offset rather than clamping it", () => {
    // Clamping would silently point a span at different bytes than the model
    // claimed, and the digest check would then fail at the gate — later, and with a
    // confusing reason. Refusing here attributes the fault to the extractor.
    const extractor = new ModelExtractor({ adapter: new DeterministicStandInAdapter() });
    const proposals = extractor.parse(
      JSON.stringify({
        claims: [
          { kind: "decision", subject: "s", predicate: "p", object: "o", spans: [{ start: 0, end: 100_000 }] },
        ],
      }),
      CONTENT,
    );
    assert.deepEqual(proposals, []);
  });

  it("refuses a privileged kind the extractor is not permitted to produce", () => {
    const extractor = new ModelExtractor({ adapter: new DeterministicStandInAdapter() });
    const proposals = extractor.parse(
      JSON.stringify({
        claims: [
          { kind: "permission", subject: "s", predicate: "p", object: "o", spans: [{ start: 0, end: 5 }] },
        ],
      }),
      CONTENT,
    );
    assert.deepEqual(proposals, [], "a model must not be able to propose a permission claim through this path");
  });

  it("discards the whole response when it is not JSON", () => {
    const extractor = new ModelExtractor({ adapter: new DeterministicStandInAdapter() });
    assert.deepEqual(extractor.parse("I could not find any claims.", CONTENT), []);
  });

  it("handles an empty claim list as a valid answer", () => {
    const extractor = new ModelExtractor({ adapter: new DeterministicStandInAdapter() });
    assert.deepEqual(extractor.parse('{"claims":[]}', CONTENT), []);
  });

  it("extracts JSON from a response with nested braces", () => {
    const parsed = extractJsonObject('prefix {"a":{"b":{"c":1}},"claims":[]} suffix') as {
      claims: unknown[];
    };
    assert.deepEqual(parsed.claims, []);
  });
});

describe("Anthropic response shape", () => {
  it("joins only text blocks and ignores tool-use blocks", async () => {
    const adapter = new AnthropicAdapter({
      baseUrl: "https://example.invalid",
      apiKey: "k",
      model: "claude-x",
      fetchImpl: (async () =>
        new Response(
          JSON.stringify({
            model: "claude-x",
            content: [
              { type: "tool_use", id: "t1" },
              { type: "text", text: '{"claims":[]}' },
            ],
            usage: { input_tokens: 12, output_tokens: 3 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        )) as typeof fetch,
    });
    const response = await adapter.complete({ system: "s", user: "u" });
    assert.equal(response.text, '{"claims":[]}');
    assert.equal(response.usage?.input_tokens, 12);
  });

  it("raises a typed error on a non-2xx response instead of returning empty text", async () => {
    const adapter = new AnthropicAdapter({
      baseUrl: "https://example.invalid",
      apiKey: "k",
      model: "claude-x",
      fetchImpl: (async () =>
        new Response("overloaded", { status: 529 })) as typeof fetch,
    });
    await assert.rejects(
      () => adapter.complete({ system: "s", user: "u" }),
      (error: unknown) => error instanceof LlmUnavailableError && /529/.test((error as Error).message),
    );
  });
});
