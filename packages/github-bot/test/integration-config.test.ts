import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Env } from "../src/types";
import type { Logger } from "../src/logger";
import { parseInlinePromptFlags } from "@open-inspect/shared/inline-prompt-flags";

import { getGitHubConfig } from "../src/utils/integration-config";
import { resolveModelSelection } from "../src/model-selection";

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
    GITHUB_KV: { get: vi.fn(), put: vi.fn() },
    CONTROL_PLANE: { fetch: vi.fn(fetchImpl) },
    DEFAULT_MODEL: "anthropic/claude-haiku-4-5",
    SERVICE_AUTH_SECRET: "test-secret",
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
      harness: "opencode",
      reasoningEffort: "high",
      autoReviewOnOpen: true,
      enabledRepos: null,
      allowedTriggerUsers: null,
      codeReviewInstructions: "Be thorough",
      commentActionInstructions: null,
    });
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("parses the harness from a successful response", async () => {
    const env = createMockEnv(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            config: {
              model: "anthropic/claude-opus-4-6",
              harness: "claude",
              reasoningEffort: null,
              autoReviewOnOpen: true,
              enabledRepos: null,
              allowedTriggerUsers: null,
              codeReviewInstructions: null,
              commentActionInstructions: null,
            },
          }),
          { status: 200 }
        )
      )
    );

    const result = await getGitHubConfig(env, "acme/widgets", createMockLogger());

    expect(result.harness).toBe("claude");
  });

  it("treats a response without a harness key as the built-in default (older control plane)", async () => {
    const env = createMockEnv(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            config: {
              model: "anthropic/claude-opus-4-6",
              reasoningEffort: null,
              autoReviewOnOpen: true,
              enabledRepos: null,
              allowedTriggerUsers: null,
              codeReviewInstructions: null,
              commentActionInstructions: null,
            },
          }),
          { status: 200 }
        )
      )
    );
    const log = createMockLogger();

    const result = await getGitHubConfig(env, "acme/widgets", log);

    expect(result.harness).toBe("opencode");
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("accepts nullable config fields from successful response", async () => {
    const env = createMockEnv(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            config: {
              model: null,
              reasoningEffort: null,
              autoReviewOnOpen: false,
              enabledRepos: ["acme/widgets"],
              allowedTriggerUsers: ["octocat"],
              codeReviewInstructions: null,
              commentActionInstructions: null,
            },
          }),
          { status: 200 }
        )
      )
    );

    const result = await getGitHubConfig(env, "acme/widgets", createMockLogger());

    expect(result).toEqual({
      model: "anthropic/claude-haiku-4-5",
      harness: "opencode",
      reasoningEffort: null,
      autoReviewOnOpen: false,
      enabledRepos: ["acme/widgets"],
      allowedTriggerUsers: ["octocat"],
      codeReviewInstructions: null,
      commentActionInstructions: null,
    });
  });

  it("returns fail-closed config and logs warn on malformed response", async () => {
    const env = createMockEnv(() =>
      Promise.resolve(new Response(JSON.stringify({ config: { model: 123 } }), { status: 200 }))
    );
    const log = createMockLogger();

    const result = await getGitHubConfig(env, "acme/widgets", log);

    expect(result).toEqual({
      model: "anthropic/claude-haiku-4-5",
      harness: "opencode",
      reasoningEffort: null,
      autoReviewOnOpen: false,
      enabledRepos: [],
      allowedTriggerUsers: [],
      codeReviewInstructions: null,
      commentActionInstructions: null,
    });
    expect(log.warn).toHaveBeenCalledWith(
      "config.invalid_response",
      expect.objectContaining({ repo: "acme/widgets", fallback: "fail_closed" })
    );
  });

  it("returns fail-closed config and logs warn on invalid JSON response", async () => {
    const env = createMockEnv(() => Promise.resolve(new Response("not json", { status: 200 })));
    const log = createMockLogger();

    const result = await getGitHubConfig(env, "acme/widgets", log);

    expect(result).toEqual({
      model: "anthropic/claude-haiku-4-5",
      harness: "opencode",
      reasoningEffort: null,
      autoReviewOnOpen: false,
      enabledRepos: [],
      allowedTriggerUsers: [],
      codeReviewInstructions: null,
      commentActionInstructions: null,
    });
    expect(log.warn).toHaveBeenCalledWith(
      "config.invalid_response",
      expect.objectContaining({ repo: "acme/widgets", fallback: "fail_closed" })
    );
  });

  it("returns fail-closed config and logs warn on network error", async () => {
    const env = createMockEnv(() => Promise.reject(new Error("connection refused")));
    const log = createMockLogger();

    const result = await getGitHubConfig(env, "acme/widgets", log);

    expect(result).toEqual({
      model: "anthropic/claude-haiku-4-5",
      harness: "opencode",
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
      harness: "opencode",
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

    const result = await getGitHubConfig(env, "acme/widgets", createMockLogger());

    expect(result).toEqual({
      model: "anthropic/claude-haiku-4-5",
      harness: "opencode",
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
      harness: "opencode",
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

describe("resolveModelSelection harness", () => {
  const env = {} as unknown as Env;

  it("sends the built-in harness with the canonical model when unconfigured", async () => {
    const log = createMockLogger();
    const result = await resolveModelSelection(
      env,
      log,
      "trace-default-harness",
      { model: "openai/gpt-5", harness: "opencode", reasoningEffort: null },
      undefined
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Stale model canonicalizes; the default harness runs the canonical one.
    expect(result.selection.model).toBe("anthropic/claude-sonnet-4-6");
    expect(result.selection.harness).toBe("opencode");
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("keeps a compatible configured harness", async () => {
    const log = createMockLogger();
    const result = await resolveModelSelection(
      env,
      log,
      "trace-keep-harness",
      { model: "anthropic/claude-opus-4-6", harness: "claude", reasoningEffort: null },
      undefined
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.selection.harness).toBe("claude");
  });

  it("refuses a mismatch instead of switching to the built-in harness", async () => {
    const log = createMockLogger();
    const result = await resolveModelSelection(
      env,
      log,
      "trace-mismatch",
      { model: "openai/gpt-5.4", harness: "claude", reasoningEffort: null },
      undefined
    );

    expect(result).toMatchObject({
      ok: false,
      reason: "harness_model_incompatible",
      message: expect.stringContaining(
        'Model "openai/gpt-5.4" cannot run on the Claude Agent harness.'
      ),
    });
    expect(log.warn).not.toHaveBeenCalled();
  });
  it("keeps Claude after canonicalizing a stale deployment model", async () => {
    const log = createMockLogger();
    const result = await resolveModelSelection(
      env,
      log,
      "trace-stale-claude",
      { model: "openai/gpt-5", harness: "claude", reasoningEffort: "xhigh" },
      undefined
    );
    expect(result).toMatchObject({
      ok: true,
      selection: { model: "anthropic/claude-sonnet-4-6", harness: "claude", reasoningEffort: null },
    });
    expect(log.warn).not.toHaveBeenCalled();
  });

  it.each([
    { model: "gpt-5.4", harness: "claude", compatible: false, canonical: "openai/gpt-5.4" },
    {
      model: "claude-opus-4-6",
      harness: "claude",
      compatible: true,
      canonical: "anthropic/claude-opus-4-6",
    },
    { model: "gpt-5.4", harness: "opencode", compatible: true, canonical: "openai/gpt-5.4" },
  ] as const)(
    "checks $harness against inline model override $model",
    async ({ model, harness, compatible, canonical }) => {
      const log = createMockLogger();
      const inlineEnv = createMockEnv(() =>
        Promise.resolve(
          Response.json({
            enabledModels: ["openai/gpt-5.4", "anthropic/claude-opus-4-6"],
          })
        )
      );
      const result = await resolveModelSelection(
        inlineEnv,
        log,
        "trace-inline-harness",
        { model: "anthropic/claude-sonnet-4-6", harness, reasoningEffort: "low" },
        parseInlinePromptFlags(`!model:${model} Review this`)
      );
      if (compatible) {
        expect(result).toMatchObject({
          ok: true,
          overridden: true,
          selection: { harness, model: canonical, reasoningEffort: "low" },
        });
      } else {
        expect(result).toMatchObject({
          ok: false,
          reason: "harness_model_incompatible",
          message: expect.stringContaining(
            `Model "${canonical}" cannot run on the Claude Agent harness.`
          ),
        });
      }
      expect(log.warn).not.toHaveBeenCalled();
    }
  );

  it.each([
    { source: "integration config", configModel: "gpt-6-sol" },
    { source: "deployment default", configModel: null },
    { source: "retired integration model", configModel: "openai/gpt-5.3-codex-spark" },
  ])(
    "checks the canonical model from $source without changing the configured harness",
    async ({ configModel }) => {
      const configuredEnv = createMockEnv(() =>
        Promise.resolve(
          Response.json({
            config: {
              model: configModel,
              harness: "claude",
              reasoningEffort: null,
              autoReviewOnOpen: true,
              enabledRepos: null,
              allowedTriggerUsers: null,
              codeReviewInstructions: null,
              commentActionInstructions: null,
            },
          })
        )
      );
      configuredEnv.DEFAULT_MODEL = "gpt-6-sol";
      const log = createMockLogger();
      const config = await getGitHubConfig(configuredEnv, "acme/widgets", log);

      expect(config.harness).toBe("claude");
      expect(
        await resolveModelSelection(configuredEnv, log, "trace-resolved-config", config, undefined)
      ).toMatchObject({
        ok: false,
        reason: "harness_model_incompatible",
        message: expect.stringContaining(
          'Model "openai/gpt-6-sol" cannot run on the Claude Agent harness.'
        ),
      });
      expect(log.warn).not.toHaveBeenCalled();
    }
  );
});
