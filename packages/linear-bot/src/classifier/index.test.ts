import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import {
  CLASSIFICATION_REQUEST_TIMEOUT_MS,
  classifyRepo,
  classifyToolInputSchema,
  openaiChatCompletionResponseSchema,
} from "./index";
import { clearReposLocalCache } from "./repos";
import { createFakeKV, makeLinearBotEnv } from "../test-helpers";
import type { Env } from "../types";

describe("openaiChatCompletionResponseSchema", () => {
  it("parses a well-formed chat completion response", () => {
    const parsed = openaiChatCompletionResponseSchema.safeParse({
      id: "chatcmpl_1",
      choices: [
        {
          message: {
            content: JSON.stringify({
              repoId: "org/repo",
              confidence: "high",
              reasoning: "The issue names the repo.",
              alternatives: [],
            }),
          },
        },
      ],
    });

    expect(parsed.success).toBe(true);
  });

  it("rejects a response without content", () => {
    const parsed = openaiChatCompletionResponseSchema.safeParse({ id: "chatcmpl_1" });

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

// ─── classifyRepo — OpenAI transport ─────────────────────────────────────────

const TWO_REPOS = [
  {
    id: 1,
    owner: "acme",
    name: "backend",
    fullName: "acme/backend",
    description: null,
    private: true,
    defaultBranch: "main",
    archived: false,
  },
  {
    id: 2,
    owner: "acme",
    name: "frontend",
    fullName: "acme/frontend",
    description: null,
    private: true,
    defaultBranch: "main",
    archived: false,
  },
];

function stubRepos(env: Env, repos: unknown[]) {
  const controlPlane = env.CONTROL_PLANE as unknown as { fetch: Mock };
  controlPlane.fetch.mockImplementation(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "https://internal/repos") {
      return {
        ok: true,
        json: () => Promise.resolve({ repos, cached: false, cachedAt: "2026-08-02T00:00:00.000Z" }),
      };
    }
    throw new Error(`Unexpected control-plane fetch to ${url}`);
  });
}

function classificationContent(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    repoId: "acme/backend",
    confidence: "high",
    reasoning: "Matches the described repo.",
    alternatives: [],
    ...overrides,
  });
}

describe("classifyRepo — OpenAI transport", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearReposLocalCache();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends max_completion_tokens, temperature 0, strict json_schema, and the configured model", async () => {
    const { kv } = createFakeKV();
    const env = makeLinearBotEnv(kv, { CLASSIFICATION_MODEL: "gpt-5.4-mini-test" });
    stubRepos(env, TWO_REPOS);

    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ choices: [{ message: { content: classificationContent() } }] }),
        {
          status: 200,
        }
      )
    );
    vi.stubGlobal("fetch", fetchMock);

    await classifyRepo(env, "Fix login bug", null, [], null, null, null, null, "trace-1");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.openai.com/v1/chat/completions");
    const body = JSON.parse(String(init.body));

    expect(body.model).toBe("gpt-5.4-mini-test");
    expect(body.temperature).toBe(0);
    expect(body.max_completion_tokens).toBe(2000);
    expect(body.max_tokens).toBeUndefined();
    expect(body.response_format.json_schema.strict).toBe(true);

    // Strict mode rejects a schema that omits additionalProperties:false or
    // leaves any property out of `required`, and the nullable repoId is what
    // lets the model say "unclear" instead of inventing a repository. Assert
    // the shape, not just the strict flag, so a regression can't stay green.
    const schema = body.response_format.json_schema.schema;
    expect(schema.type).toBe("object");
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(
      expect.arrayContaining(["repoId", "confidence", "reasoning", "alternatives"])
    );
    expect(schema.required).toHaveLength(4);
    expect(schema.properties.repoId.type).toEqual(["string", "null"]);
    expect(schema.properties.confidence.enum).toEqual(["high", "medium", "low"]);
    expect(schema.properties.alternatives.type).toBe("array");
    expect(schema.properties.alternatives.items.type).toBe("string");
  });

  it("defaults to gpt-5.4-mini when CLASSIFICATION_MODEL is unset", async () => {
    const { kv } = createFakeKV();
    const env = makeLinearBotEnv(kv, { CLASSIFICATION_MODEL: undefined });
    stubRepos(env, TWO_REPOS);

    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ choices: [{ message: { content: classificationContent() } }] }),
        {
          status: 200,
        }
      )
    );
    vi.stubGlobal("fetch", fetchMock);

    await classifyRepo(env, "Fix login bug", null, [], null, null, null, null, "trace-1b");

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body)).model).toBe("gpt-5.4-mini");
  });

  it("degrades to needsClarification with alternatives populated when OpenAI returns non-2xx", async () => {
    const { kv } = createFakeKV();
    const env = makeLinearBotEnv(kv);
    stubRepos(env, TWO_REPOS);

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("rate limited", { status: 429 }))
    );

    const result = await classifyRepo(
      env,
      "Fix login bug",
      null,
      [],
      null,
      null,
      null,
      null,
      "trace-2"
    );

    expect(result.needsClarification).toBe(true);
    expect(result.repo).toBeNull();
    expect(result.alternatives).toHaveLength(2);
  });

  it("bounds the classification request and degrades when it times out", async () => {
    const { kv } = createFakeKV();
    const env = makeLinearBotEnv(kv);
    stubRepos(env, TWO_REPOS);

    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    const fetchMock = vi
      .fn()
      .mockRejectedValue(
        Object.assign(new Error("The operation was aborted"), { name: "TimeoutError" })
      );
    vi.stubGlobal("fetch", fetchMock);

    const result = await classifyRepo(
      env,
      "Fix login bug",
      null,
      [],
      null,
      null,
      null,
      null,
      "trace-timeout"
    );

    // A stalled or queued provider request must not hold the webhook open;
    // asking the user to name the repository is the cheap, correct outcome.
    expect(result.needsClarification).toBe(true);
    expect(result.repo).toBeNull();
    expect(timeoutSpy).toHaveBeenCalledWith(CLASSIFICATION_REQUEST_TIMEOUT_MS);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    // Identity, not just shape: some other signal would leave the fetch unbounded.
    expect(init.signal).toBe(timeoutSpy.mock.results[0]?.value);
  });
});
