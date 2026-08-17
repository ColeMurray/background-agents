import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CLASSIFICATION_REQUEST_TIMEOUT_MS,
  DEFAULT_CLASSIFICATION_MODEL,
  OPENAI_CLASSIFICATION_MAX_COMPLETION_TOKENS,
  callOpenAIStructured,
  openAiChatCompletionEnvelopeSchema,
  resolveClassificationProvider,
} from "./classification";

const SCHEMA = {
  name: "classify",
  schema: { type: "object", properties: {}, required: [], additionalProperties: false },
};

describe("resolveClassificationProvider", () => {
  it.each([
    ["anthropic/claude-haiku-4-5", "anthropic", "claude-haiku-4-5"],
    ["claude-haiku-4-5", "anthropic", "claude-haiku-4-5"],
    ["openai/gpt-5.4-mini", "openai", "gpt-5.4-mini"],
    ["gpt-5.4-mini", "openai", "gpt-5.4-mini"],
  ])("routes %s to %s and strips the prefix", (modelId, provider, model) => {
    expect(resolveClassificationProvider(modelId)).toEqual({ provider, model });
  });

  it("routes the default model to Anthropic", () => {
    expect(resolveClassificationProvider(DEFAULT_CLASSIFICATION_MODEL).provider).toBe("anthropic");
  });

  it("throws on an unrecognised id rather than silently defaulting to Anthropic", () => {
    expect(() => resolveClassificationProvider("mistral/mistral-large")).toThrow(
      /Unrecognized classification model/
    );
  });
});

describe("openAiChatCompletionEnvelopeSchema", () => {
  it("parses a response with the consumed message fields", () => {
    const parsed = openAiChatCompletionEnvelopeSchema.safeParse({
      choices: [{ message: { content: "{}", refusal: null } }],
    });

    expect(parsed.success).toBe(true);
  });

  it("rejects a response without choices", () => {
    expect(openAiChatCompletionEnvelopeSchema.safeParse({}).success).toBe(false);
  });
});

describe("callOpenAIStructured", () => {
  afterEach(() => vi.unstubAllGlobals());

  function stubFetch(impl: typeof fetch) {
    const fetchMock = vi.fn(impl);
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("sends a strict structured-output request with no temperature", async () => {
    const fetchMock = stubFetch(async () =>
      Response.json({ choices: [{ message: { content: '{"ok":true}' } }] })
    );

    const result = await callOpenAIStructured("sk-test", "gpt-5.4-mini", "prompt", SCHEMA);

    expect(result).toEqual({ ok: true });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.openai.com/v1/chat/completions");
    expect(init!.headers).toMatchObject({ Authorization: "Bearer sk-test" });

    const body = JSON.parse(init!.body as string);
    // gpt-5-family models reject an explicit temperature with HTTP 400.
    expect(body).not.toHaveProperty("temperature");
    expect(body.model).toBe("gpt-5.4-mini");
    expect(body.max_completion_tokens).toBe(OPENAI_CLASSIFICATION_MAX_COMPLETION_TOKENS);
    expect(body.response_format).toEqual({
      type: "json_schema",
      json_schema: { name: SCHEMA.name, strict: true, schema: SCHEMA.schema },
    });
  });

  it("bounds the request with the shared timeout signal", async () => {
    const fakeSignal = {} as AbortSignal;
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockReturnValue(fakeSignal);
    const fetchMock = stubFetch(async () =>
      Response.json({ choices: [{ message: { content: "{}" } }] })
    );

    await callOpenAIStructured("sk-test", "gpt-5.4-mini", "prompt", SCHEMA);

    expect(timeoutSpy).toHaveBeenCalledWith(CLASSIFICATION_REQUEST_TIMEOUT_MS);
    expect(fetchMock.mock.calls[0][1]!.signal).toBe(fakeSignal);
    timeoutSpy.mockRestore();
  });

  it.each([
    {
      label: "an empty choices array",
      respond: () => Response.json({ choices: [] }),
      message: /No choices in OpenAI response/,
    },
    {
      label: "a non-2xx response",
      respond: () => new Response("server exploded", { status: 500 }),
      message: /OpenAI API error 500: server exploded/,
    },
    {
      label: "a malformed envelope",
      respond: () => Response.json({ nope: true }),
      message: /Malformed OpenAI response/,
    },
    {
      label: "a refusal",
      respond: () => Response.json({ choices: [{ message: { content: null, refusal: "no" } }] }),
      message: /OpenAI refused to classify: no/,
    },
    {
      label: "empty content",
      respond: () => Response.json({ choices: [{ message: { content: null } }] }),
      message: /Empty OpenAI response content/,
    },
    {
      label: "non-JSON content",
      respond: () => Response.json({ choices: [{ message: { content: "not json" } }] }),
      message: /Failed to parse OpenAI response content as JSON/,
    },
  ])("throws on $label", async ({ respond, message }) => {
    stubFetch(async () => respond());

    await expect(callOpenAIStructured("sk-test", "gpt-5.4-mini", "prompt", SCHEMA)).rejects.toThrow(
      message
    );
  });

  it("truncates a long error body", async () => {
    stubFetch(async () => new Response("x".repeat(2000), { status: 400 }));

    await expect(callOpenAIStructured("sk-test", "gpt-5.4-mini", "prompt", SCHEMA)).rejects.toThrow(
      `OpenAI API error 400: ${"x".repeat(500)}`
    );
  });
});
