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
    expect(prefs?.appHomeModelOverride).toBe(true);
    expect(prefs?.reasoningEffort).toBe(getDefaultReasoningEffort("anthropic/claude-haiku-4-5"));
    expect(prefs?.branch).toBe("staging");
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

  it("does not mark the model as overridden when only branch is changed", async () => {
    const env = makeEnv();

    await updateUserPreferences(env, "U123", { branch: "feature/test" });

    const prefs = await getUserPreferences(env, "U123");
    expect(prefs?.model).toBe("anthropic/claude-haiku-4-5");
    expect(prefs?.appHomeModelOverride).toBe(false);
    expect(prefs?.branch).toBe("feature/test");
  });
});

describe("resolveUserPreferences", () => {
  it("uses the Slack default model when App Home has not overridden model", () => {
    const resolved = resolveUserPreferences(
      {
        userId: "U123",
        model: "anthropic/claude-haiku-4-5",
        appHomeModelOverride: false,
        updatedAt: 1,
      },
      "anthropic/claude-sonnet-4-6",
      ["anthropic/claude-sonnet-4-6"]
    );

    expect(resolved.model).toBe("anthropic/claude-sonnet-4-6");
  });

  it("treats legacy preferences without an override flag as inheriting Slack defaults", () => {
    const resolved = resolveUserPreferences(
      {
        userId: "U123",
        model: "anthropic/claude-haiku-4-5",
        updatedAt: 1,
      },
      "anthropic/claude-sonnet-4-6",
      ["anthropic/claude-sonnet-4-6"]
    );

    expect(resolved.model).toBe("anthropic/claude-sonnet-4-6");
    expect(resolved.appHomeModelOverride).toBe(false);
  });

  it("uses the Slack default before the shared default for invalid stored models", () => {
    const resolved = resolveUserPreferences(
      {
        userId: "U123",
        model: "not-a-real-model",
        appHomeModelOverride: true,
        updatedAt: 1,
      },
      "openai/gpt-5.2",
      ["anthropic/claude-sonnet-4-6", "openai/gpt-5.2"]
    );

    expect(resolved.model).toBe("openai/gpt-5.2");
  });

  it("falls back when the App Home model is no longer enabled", () => {
    const resolved = resolveUserPreferences(
      {
        userId: "U123",
        model: "anthropic/claude-haiku-4-5",
        appHomeModelOverride: true,
        updatedAt: 1,
      },
      "anthropic/claude-sonnet-4-6",
      ["openai/gpt-5.2", "anthropic/claude-sonnet-4-6"]
    );

    expect(resolved.model).toBe("anthropic/claude-sonnet-4-6");
  });

  it("uses the first enabled model when neither preferred nor default is enabled", () => {
    const resolved = resolveUserPreferences(
      {
        userId: "U123",
        model: "anthropic/claude-haiku-4-5",
        appHomeModelOverride: true,
        updatedAt: 1,
      },
      "anthropic/claude-sonnet-4-6",
      ["openai/gpt-5.2"]
    );

    expect(resolved.model).toBe("openai/gpt-5.2");
  });
});
