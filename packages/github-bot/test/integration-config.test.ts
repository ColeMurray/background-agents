import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Env } from "../src/types";
import type { Logger } from "../src/logger";

vi.mock("../src/utils/internal", () => ({
  generateInternalToken: vi.fn().mockResolvedValue("test-internal-token"),
}));

import { getGitHubConfig } from "../src/utils/integration-config";

function createMockLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
}

function createMockEnv(fetchImpl: (url: string, init?: RequestInit) => Promise<Response>): Env {
  return {
    CONTROL_PLANE: { fetch: vi.fn(fetchImpl) } as unknown as Fetcher,
    DEFAULT_MODEL: "anthropic/claude-haiku-4-5",
    INTERNAL_CALLBACK_SECRET: "test-secret",
  } as unknown as Env;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("getGitHubConfig", () => {
  it("returns config from successful response", async () => {
    const env = createMockEnv(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            config: {
              model: "anthropic/claude-opus-4-6",
              reasoningEffort: "high",
              autoReviewOnOpen: true,
              enabledRepos: null,
              allowedTriggerUsers: null,
              codeReviewInstructions: "Be thorough",
              commentActionInstructions: null,
            },
          }),
          { status: 200 }
        )
      )
    );
    const log = createMockLogger();

    const result = await getGitHubConfig(env, "acme/widgets", log);

    expect(result).toEqual({
      model: "anthropic/claude-opus-4-6",
      reasoningEffort: "high",
      autoReviewOnOpen: true,
      enabledRepos: null,
      allowedTriggerUsers: null,
      codeReviewInstructions: "Be thorough",
      commentActionInstructions: null,
    });
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("returns fail-closed config and logs warn on network error", async () => {
    const env = createMockEnv(() => Promise.reject(new Error("connection refused")));
    const log = createMockLogger();

    const result = await getGitHubConfig(env, "acme/widgets", log);

    expect(result).toEqual({
      model: "anthropic/claude-haiku-4-5",
      reasoningEffort: null,
      autoReviewOnOpen: false,
      enabledRepos: [],
      allowedTriggerUsers: [],
      codeReviewInstructions: null,
      commentActionInstructions: null,
    });
    expect(log.warn).toHaveBeenCalledWith(
      "config.fetch_error",
      expect.objectContaining({
        repo: "acme/widgets",
        fallback: "fail_closed",
      })
    );
  });

  it("returns fail-closed config and logs warn on non-ok response", async () => {
    const env = createMockEnv(() =>
      Promise.resolve(new Response("Internal Server Error", { status: 500 }))
    );
    const log = createMockLogger();

    const result = await getGitHubConfig(env, "acme/widgets", log);

    expect(result).toEqual({
      model: "anthropic/claude-haiku-4-5",
      reasoningEffort: null,
      autoReviewOnOpen: false,
      enabledRepos: [],
      allowedTriggerUsers: [],
      codeReviewInstructions: null,
      commentActionInstructions: null,
    });
    expect(log.warn).toHaveBeenCalledWith(
      "config.fetch_failed",
      expect.objectContaining({
        repo: "acme/widgets",
        status: 500,
        fallback: "fail_closed",
      })
    );
  });

  it("works without a logger (no logging on error)", async () => {
    const env = createMockEnv(() => Promise.reject(new Error("timeout")));

    const result = await getGitHubConfig(env, "acme/widgets");

    expect(result).toEqual({
      model: "anthropic/claude-haiku-4-5",
      reasoningEffort: null,
      autoReviewOnOpen: false,
      enabledRepos: [],
      allowedTriggerUsers: [],
      codeReviewInstructions: null,
      commentActionInstructions: null,
    });
  });

  it("returns permissive defaults when config is null (no settings configured)", async () => {
    const env = createMockEnv(() =>
      Promise.resolve(new Response(JSON.stringify({ config: null }), { status: 200 }))
    );
    const log = createMockLogger();

    const result = await getGitHubConfig(env, "acme/widgets", log);

    expect(result).toEqual({
      model: "anthropic/claude-haiku-4-5",
      reasoningEffort: null,
      autoReviewOnOpen: true,
      enabledRepos: null,
      allowedTriggerUsers: null,
      codeReviewInstructions: null,
      commentActionInstructions: null,
    });
    expect(log.warn).not.toHaveBeenCalled();
  });
});
