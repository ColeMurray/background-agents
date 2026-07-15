import { getDefaultReasoningEffort } from "@open-inspect/shared";
import { describe, expect, it, vi } from "vitest";
import type { Env } from "./types";
import {
  getUserPreferences,
  resolveUserPreferences,
  updateUserPreferences,
} from "./user-preferences";

function createMockKV() {
  const store = new Map<string, string>();

  return {
    get: vi.fn(async (key: string, type?: string) => {
      const value = store.get(key);
      if (!value) {
        return null;
      }
      return type === "json" ? JSON.parse(value) : value;
    }),
    put: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
  };
}

function makeEnv(): Env {
  return {
    SLACK_KV: createMockKV() as unknown as KVNamespace,
    DEFAULT_MODEL: "anthropic/claude-haiku-4-5",
  } as Env;
}

describe("updateUserPreferences", () => {
  it("preserves unspecified fields and resets reasoning when the model changes", async () => {
    const env = makeEnv();
    await env.SLACK_KV.put(
      "user_prefs:U123",
      JSON.stringify({
        userId: "U123",
        model: "anthropic/claude-haiku-4-5",
        reasoningEffort: "medium",
        branch: "staging",
        updatedAt: 1,
      })
    );

    await updateUserPreferences(env, "U123", { model: "anthropic/claude-haiku-4-5" });

    const prefs = await getUserPreferences(env, "U123");
    expect(prefs?.model).toBe("anthropic/claude-haiku-4-5");
    expect(prefs?.reasoningEffort).toBeUndefined();
    expect(prefs?.branch).toBe("staging");

    const resolved = resolveUserPreferences(prefs, env.DEFAULT_MODEL);
    expect(resolved.reasoningEffort).toBe(getDefaultReasoningEffort("anthropic/claude-haiku-4-5"));
  });

  it("distinguishes an omitted branch from an explicit clear", async () => {
    const env = makeEnv();
    await env.SLACK_KV.put(
      "user_prefs:U123",
      JSON.stringify({
        userId: "U123",
        model: "anthropic/claude-haiku-4-5",
        reasoningEffort: "max",
        branch: "staging",
        updatedAt: 1,
      })
    );

    await updateUserPreferences(env, "U123", { branch: undefined });

    const prefs = await getUserPreferences(env, "U123");
    expect(prefs?.model).toBe("anthropic/claude-haiku-4-5");
    expect(prefs?.reasoningEffort).toBe("max");
    expect(prefs?.branch).toBeUndefined();
  });

  it("does not persist a model when only branch is changed", async () => {
    const env = makeEnv();

    await updateUserPreferences(env, "U123", { branch: "feature/test" });

    const prefs = await getUserPreferences(env, "U123");
    expect(prefs?.model).toBeUndefined();
    expect(prefs?.branch).toBe("feature/test");
  });

  it("preserves an existing stored model when only branch is changed", async () => {
    const env = makeEnv();
    await env.SLACK_KV.put(
      "user_prefs:U123",
      JSON.stringify({
        userId: "U123",
        model: "openai/gpt-5.4",
        updatedAt: 1,
      })
    );

    await updateUserPreferences(env, "U123", { branch: "feature/test" });

    const prefs = await getUserPreferences(env, "U123");
    expect(prefs?.model).toBe("openai/gpt-5.4");
    expect(prefs?.branch).toBe("feature/test");
  });

  it("preserves reasoning effort on branch updates using the Slack default model context", async () => {
    const env = makeEnv();
    await env.SLACK_KV.put(
      "user_prefs:U123",
      JSON.stringify({
        userId: "U123",
        reasoningEffort: "none",
        updatedAt: 1,
      })
    );

    await updateUserPreferences(
      env,
      "U123",
      { branch: "feature/test" },
      {
        defaultModel: "openai/gpt-5.4",
        enabledModels: ["openai/gpt-5.4"],
      }
    );

    const prefs = await getUserPreferences(env, "U123");
    expect(prefs?.model).toBeUndefined();
    expect(prefs?.reasoningEffort).toBe("none");
    expect(prefs?.branch).toBe("feature/test");
  });

  it("does not persist a model when only reasoning effort is changed", async () => {
    const env = makeEnv();

    await updateUserPreferences(
      env,
      "U123",
      { reasoningEffort: "none" },
      {
        defaultModel: "openai/gpt-5.4",
        enabledModels: ["openai/gpt-5.4"],
      }
    );

    const prefs = await getUserPreferences(env, "U123");
    expect(prefs?.model).toBeUndefined();
    expect(prefs?.reasoningEffort).toBe("none");
  });
});

describe("resolveUserPreferences", () => {
  it("uses the Slack default model when no model is stored", () => {
    const resolved = resolveUserPreferences(
      {
        userId: "U123",
        updatedAt: 1,
      },
      "anthropic/claude-sonnet-4-6",
      ["anthropic/claude-sonnet-4-6"]
    );

    expect(resolved.model).toBe("anthropic/claude-sonnet-4-6");
  });

  it("uses a stored model before the Slack default", () => {
    const resolved = resolveUserPreferences(
      {
        userId: "U123",
        model: "anthropic/claude-haiku-4-5",
        updatedAt: 1,
      },
      "anthropic/claude-sonnet-4-6",
      ["anthropic/claude-haiku-4-5", "anthropic/claude-sonnet-4-6"]
    );

    expect(resolved.model).toBe("anthropic/claude-haiku-4-5");
  });

  it("uses the Slack default before the shared default for unsupported stored models", () => {
    const resolved = resolveUserPreferences(
      {
        userId: "U123",
        model: "openai/gpt-5.2",
        updatedAt: 1,
      },
      "openai/gpt-5.4",
      ["anthropic/claude-sonnet-4-6", "openai/gpt-5.4"]
    );

    expect(resolved.model).toBe("openai/gpt-5.4");
  });

  it("falls back when the App Home model is no longer enabled", () => {
    const resolved = resolveUserPreferences(
      {
        userId: "U123",
        model: "anthropic/claude-haiku-4-5",
        updatedAt: 1,
      },
      "anthropic/claude-sonnet-4-6",
      ["openai/gpt-5.4", "anthropic/claude-sonnet-4-6"]
    );

    expect(resolved.model).toBe("anthropic/claude-sonnet-4-6");
  });

  it("uses the first enabled model when neither preferred nor default is enabled", () => {
    const resolved = resolveUserPreferences(
      {
        userId: "U123",
        model: "anthropic/claude-haiku-4-5",
        updatedAt: 1,
      },
      "anthropic/claude-sonnet-4-6",
      ["openai/gpt-5.4"]
    );

    expect(resolved.model).toBe("openai/gpt-5.4");
  });

  it("ignores removed models when choosing the first enabled model", () => {
    const resolved = resolveUserPreferences(
      {
        userId: "U123",
        model: "anthropic/claude-haiku-4-5",
        updatedAt: 1,
      },
      "anthropic/claude-sonnet-4-6",
      ["openai/gpt-5.2", "gpt-5.4"]
    );

    expect(resolved.model).toBe("openai/gpt-5.4");
  });

  it("validates stored reasoning effort against the resolved Slack default model", () => {
    const resolved = resolveUserPreferences(
      {
        userId: "U123",
        reasoningEffort: "none",
        updatedAt: 1,
      },
      "openai/gpt-5.4",
      ["openai/gpt-5.4"]
    );

    expect(resolved.model).toBe("openai/gpt-5.4");
    expect(resolved.reasoningEffort).toBe("none");
  });
});
