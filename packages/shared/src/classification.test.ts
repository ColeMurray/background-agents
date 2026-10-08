import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CLASSIFICATION_REQUEST_TIMEOUT_MS,
  OPENAI_CLASSIFICATION_MAX_COMPLETION_TOKENS,
  callOpenAIStructured,
  openAiChatCompletionEnvelopeSchema,
  parseClassificationModel,
  resolveClassificationTarget,
} from "./classification";
import { z } from "zod";
import modelIdFixtures from "../test-fixtures/classification-model-ids.json";

const SCHEMA = {
  name: "classify",
  schema: { type: "object", properties: {}, required: [], additionalProperties: false },
};

// Terraform's classifier_provider.tftest.hcl reads the same file, so both
// grammars must agree on every id in it.
const MODEL_ID_FIXTURES = z
  .array(
    z.strictObject({
      id: z.string(),
      parsed: z
        .discriminatedUnion("provider", [
          z.strictObject({ provider: z.literal("anthropic"), model: z.string() }),
          z.strictObject({ provider: z.literal("openai"), model: z.string() }),
          z.strictObject({ provider: z.literal("bedrock"), region: z.string(), model: z.string() }),
        ])
        .nullable(),
    })
  )
  .parse(modelIdFixtures);

describe("parseClassificationModel", () => {
  it.each(MODEL_ID_FIXTURES.filter((f) => f.parsed))("parses $id", ({ id, parsed }) => {
    expect(parseClassificationModel(id)).toEqual(parsed);
  });

  it.each(MODEL_ID_FIXTURES.filter((f) => !f.parsed))("rejects $id", ({ id }) => {
    expect(() => parseClassificationModel(id)).toThrow(`Unrecognized classification model: ${id}`);
  });
});

describe("resolveClassificationTarget", () => {
  const KEYS = {
    ANTHROPIC_API_KEY: "anthropic-key",
    OPENAI_API_KEY: "openai-key",
    BEDROCK_API_KEY: "bedrock-key",
  };

  it("targets the Anthropic API with the Anthropic key by default", () => {
    expect(resolveClassificationTarget(KEYS)).toEqual({
      protocol: "anthropic-messages",
      provider: "anthropic",
      baseUrl: "https://api.anthropic.com",
      apiKey: "anthropic-key",
      model: "claude-haiku-4-5",
    });
  });

  it("targets Claude in Amazon Bedrock in the model's region with the Bedrock key", () => {
    expect(
      resolveClassificationTarget({
        ...KEYS,
        CLASSIFICATION_MODEL: "bedrock/eu-west-1/eu.anthropic.claude-haiku-4-5-20251001-v1:0",
      })
    ).toEqual({
      protocol: "anthropic-messages",
      provider: "bedrock",
      baseUrl: "https://bedrock-runtime.eu-west-1.amazonaws.com/anthropic",
      apiKey: "bedrock-key",
      model: "eu.anthropic.claude-haiku-4-5-20251001-v1:0",
    });
  });

  it("targets OpenAI chat completions with the OpenAI key", () => {
    expect(
      resolveClassificationTarget({ ...KEYS, CLASSIFICATION_MODEL: "openai/gpt-5.4-mini" })
    ).toEqual({
      protocol: "openai-chat",
      provider: "openai",
      apiKey: "openai-key",
      model: "gpt-5.4-mini",
    });
  });

  it.each([
    { model: "claude-haiku-4-5", binding: "ANTHROPIC_API_KEY" },
    { model: "gpt-5.4-mini", binding: "OPENAI_API_KEY" },
    {
      model: "bedrock/us-east-1/us.anthropic.claude-haiku-4-5-20251001-v1:0",
      binding: "BEDROCK_API_KEY",
    },
  ])("throws naming $binding when $model is selected without it", ({ model, binding }) => {
    const env = { ...KEYS, CLASSIFICATION_MODEL: model, [binding]: undefined };

    expect(() => resolveClassificationTarget(env)).toThrow(
      `Classification model "${model}" requires ${binding} to be set`
    );
  });

  it("does not serve a Bedrock model with the Anthropic key", () => {
    expect(() =>
      resolveClassificationTarget({
        CLASSIFICATION_MODEL: "bedrock/us-east-1/us.anthropic.claude-haiku-4-5-20251001-v1:0",
        ANTHROPIC_API_KEY: "anthropic-key",
      })
    ).toThrow(/requires BEDROCK_API_KEY/);
  });

  it("throws on an unrecognized model rather than defaulting to Anthropic", () => {
    expect(() =>
      resolveClassificationTarget({ ...KEYS, CLASSIFICATION_MODEL: "mistral/mistral-large" })
    ).toThrow(/Unrecognized classification model/);
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
    // Without a configured effort OpenAI applies the model's default.
    expect(body).not.toHaveProperty("reasoning_effort");
    expect(body.model).toBe("gpt-5.4-mini");
    expect(body.max_completion_tokens).toBe(OPENAI_CLASSIFICATION_MAX_COMPLETION_TOKENS);
    expect(body.response_format).toEqual({
      type: "json_schema",
      json_schema: { name: SCHEMA.name, strict: true, schema: SCHEMA.schema },
    });
  });

  it("sends a configured reasoning effort as reasoning_effort", async () => {
    const fetchMock = stubFetch(async () =>
      Response.json({ choices: [{ message: { content: "{}" } }] })
    );

    await callOpenAIStructured("sk-test", "gpt-6.1-sol", "prompt", SCHEMA, "low");

    const body = JSON.parse(fetchMock.mock.calls[0][1]!.body as string);
    expect(body.reasoning_effort).toBe("low");
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
