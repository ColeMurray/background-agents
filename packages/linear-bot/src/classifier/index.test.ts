import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  anthropicMessagesResponseSchema,
  classifyRepo,
  classifyToolInputSchema,
  CLASSIFICATION_REQUEST_TIMEOUT_MS,
  openaiChatCompletionResponseSchema,
} from "./index";
import { clearReposLocalCache } from "./repos";
import { createFakeKV, makeLinearBotEnv } from "../test-helpers";
import type { Env } from "../types";

describe("anthropicMessagesResponseSchema", () => {
  it("parses a response with the consumed tool block fields", () => {
    const parsed = anthropicMessagesResponseSchema.safeParse({
      id: "msg_1",
      content: [
        {
          type: "tool_use",
          id: "toolu_1",
          name: "classify_repository",
          input: {
            repoId: "org/repo",
            confidence: "high",
            reasoning: "The issue names the repo.",
            alternatives: [],
          },
        },
      ],
    });

    expect(parsed.success).toBe(true);
  });

  it("rejects a response without content", () => {
    const parsed = anthropicMessagesResponseSchema.safeParse({ id: "msg_1" });

    expect(parsed.success).toBe(false);
  });
});

describe("classifyToolInputSchema", () => {
  it("parses a valid classification tool input", () => {
    const parsed = classifyToolInputSchema.safeParse({
      repoId: "org/repo",
      confidence: "medium",
      reasoning: "The labels match this repository.",
      alternatives: ["org/other"],
    });

    expect(parsed.success).toBe(true);
  });

  it("parses a null repoId for low-confidence classifications", () => {
    const parsed = classifyToolInputSchema.safeParse({
      repoId: null,
      confidence: "low",
      reasoning: "No repository was a clear match.",
      alternatives: ["org/api", "org/web"],
    });

    expect(parsed.success).toBe(true);
  });

  it("rejects malformed or partial tool input", () => {
    const parsed = classifyToolInputSchema.safeParse({
      repoId: "org/repo",
      confidence: "certain",
      reasoning: "Invalid confidence value.",
    });

    expect(parsed.success).toBe(false);
  });
});

describe("openaiChatCompletionResponseSchema", () => {
  it("parses a response with the consumed message fields", () => {
    const parsed = openaiChatCompletionResponseSchema.safeParse({
      choices: [{ message: { content: "{}", refusal: null } }],
    });

    expect(parsed.success).toBe(true);
  });

  it("rejects a response without choices", () => {
    const parsed = openaiChatCompletionResponseSchema.safeParse({});

    expect(parsed.success).toBe(false);
  });
});

describe("classifyRepo provider dispatch", () => {
  const traceId = "trace-classify";

  function twoRepoControlPlane(): Fetcher {
    return {
      fetch: vi.fn(async () =>
        Response.json({
          repos: [
            {
              id: 1,
              owner: "acme",
              name: "alpha",
              fullName: "acme/alpha",
              description: "Alpha service",
              private: false,
              defaultBranch: "main",
              archived: false,
              language: "TypeScript",
              metadata: {},
            },
            {
              id: 2,
              owner: "acme",
              name: "beta",
              fullName: "acme/beta",
              description: "Beta service",
              private: false,
              defaultBranch: "main",
              archived: false,
              language: "TypeScript",
              metadata: {},
            },
          ],
          cached: false,
          cachedAt: "2026-08-02T00:00:00.000Z",
        })
      ),
    } as unknown as Fetcher;
  }

  function classify(env: Env) {
    return classifyRepo(
      env,
      "Fix the login bug",
      "Users cannot log in",
      ["bug"],
      "Core",
      "Platform",
      "PLAT",
      undefined,
      traceId
    );
  }

  function anthropicToolResponse(repoId: string) {
    return vi.fn<typeof fetch>(async () =>
      Response.json({
        content: [
          {
            type: "tool_use",
            name: "classify_repository",
            input: { repoId, confidence: "high", reasoning: "Matches", alternatives: [] },
          },
        ],
      })
    );
  }

  beforeEach(() => {
    clearReposLocalCache();
    vi.unstubAllGlobals();
  });

  it("sends a spec-compliant OpenAI request when CLASSIFICATION_MODEL selects an OpenAI model", async () => {
    const { kv } = createFakeKV();
    const env = makeLinearBotEnv(kv, {
      CONTROL_PLANE: twoRepoControlPlane(),
      CLASSIFICATION_MODEL: "openai/gpt-5.4-mini",
      OPENAI_API_KEY: "openai-key",
    });

    const fetchMock = vi.fn<typeof fetch>(async () =>
      Response.json({
        choices: [
          {
            message: {
              content: JSON.stringify({
                repoId: "acme/alpha",
                confidence: "high",
                reasoning: "Matches",
                alternatives: [],
              }),
            },
          },
        ],
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await classify(env);

    expect(result.repo?.id).toBe("acme/alpha");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.openai.com/v1/chat/completions");
    expect(init!.headers).toMatchObject({ Authorization: "Bearer openai-key" });

    const body = JSON.parse(init!.body as string);
    expect(body.model).toBe("gpt-5.4-mini");
    expect(body.temperature).toBe(0);
    expect(body.max_completion_tokens).toBe(2000);
    expect(body).not.toHaveProperty("max_tokens");
    expect(body.response_format.type).toBe("json_schema");
    expect(body.response_format.json_schema.strict).toBe(true);
    const schema = body.response_format.json_schema.schema;
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(["repoId", "confidence", "reasoning", "alternatives"]);
    expect(schema.properties.repoId.type).toEqual(["string", "null"]);
  });

  it("degrades to a clarification result with alternatives on a non-2xx OpenAI response", async () => {
    const { kv } = createFakeKV();
    const env = makeLinearBotEnv(kv, {
      CONTROL_PLANE: twoRepoControlPlane(),
      CLASSIFICATION_MODEL: "gpt-5.4-mini",
      OPENAI_API_KEY: "openai-key",
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("server exploded", { status: 500 }))
    );

    const result = await classify(env);

    expect(result.needsClarification).toBe(true);
    expect(result.repo).toBeNull();
    expect(result.alternatives?.length).toBeGreaterThan(0);
  });

  it("bounds every classification request with the shared timeout signal", async () => {
    const { kv } = createFakeKV();
    const env = makeLinearBotEnv(kv, { CONTROL_PLANE: twoRepoControlPlane() });

    const fakeSignal = {} as AbortSignal;
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockReturnValue(fakeSignal);
    const fetchMock = anthropicToolResponse("acme/alpha");
    vi.stubGlobal("fetch", fetchMock);

    await classify(env);

    expect(timeoutSpy).toHaveBeenCalledWith(CLASSIFICATION_REQUEST_TIMEOUT_MS);
    const [, init] = fetchMock.mock.calls[0];
    expect(init!.signal).toBe(fakeSignal);

    timeoutSpy.mockRestore();
  });

  it("fires the Anthropic default path when CLASSIFICATION_MODEL is unset", async () => {
    const { kv } = createFakeKV();
    const env = makeLinearBotEnv(kv, { CONTROL_PLANE: twoRepoControlPlane() });
    expect(env.CLASSIFICATION_MODEL).toBeUndefined();

    const fetchMock = anthropicToolResponse("acme/beta");
    vi.stubGlobal("fetch", fetchMock);

    const result = await classify(env);

    expect(result.repo?.id).toBe("acme/beta");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect(init!.headers).toMatchObject({ "x-api-key": "anthropic-key" });
    const body = JSON.parse(init!.body as string);
    expect(body.model).toBe("claude-haiku-4-5");
  });

  it("degrades rather than throwing on an unrecognised classification model prefix", async () => {
    const { kv } = createFakeKV();
    const env = makeLinearBotEnv(kv, {
      CONTROL_PLANE: twoRepoControlPlane(),
      CLASSIFICATION_MODEL: "mistral/mistral-large",
    });

    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await classify(env);

    expect(result.needsClarification).toBe(true);
    expect(result.repo).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
