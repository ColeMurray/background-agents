import { describe, expect, it } from "vitest";
import {
  DEFAULT_HARNESS,
  HARNESS_CATALOG,
  HARNESS_IDS,
  checkHarnessCompatibility,
  filterModelsForHarness,
  getValidHarnessOrDefault,
  harnessSupportsModel,
  harnessSupportsProviderAuth,
  isValidHarness,
} from "./harnesses";
import { VALID_MODELS } from "./models";

describe("harness catalog", () => {
  it("lists exactly the two harnesses with the built-in first", () => {
    expect(HARNESS_IDS).toEqual(["opencode", "claude"]);
    expect(DEFAULT_HARNESS).toBe("opencode");
  });

  it("never brands the Claude harness as Claude Code", () => {
    expect(HARNESS_CATALOG.claude.label).toBe("Claude Agent");
  });

  it("resolves an absent or unknown harness to the default", () => {
    expect(getValidHarnessOrDefault(undefined)).toBe("opencode");
    expect(getValidHarnessOrDefault(null)).toBe("opencode");
    expect(getValidHarnessOrDefault("codex")).toBe("opencode");
    expect(getValidHarnessOrDefault("claude")).toBe("claude");
    expect(isValidHarness("claude")).toBe(true);
    expect(isValidHarness(42)).toBe(false);
  });
});

describe("harnessSupportsModel", () => {
  it("lets OpenCode run every catalog model", () => {
    for (const model of VALID_MODELS) {
      expect(harnessSupportsModel("opencode", model)).toBe(true);
    }
  });

  it("restricts the Claude harness to Anthropic models", () => {
    expect(harnessSupportsModel("claude", "anthropic/claude-sonnet-4-6")).toBe(true);
    expect(harnessSupportsModel("claude", "claude-sonnet-4-6")).toBe(true);
    expect(harnessSupportsModel("claude", "openai/gpt-5.5")).toBe(false);
    expect(harnessSupportsModel("claude", "xai/grok-4.6")).toBe(false);
  });

  it("filters a model list by harness", () => {
    const filtered = filterModelsForHarness("claude", VALID_MODELS);
    expect(filtered.length).toBeGreaterThan(0);
    expect(filtered.every((model) => model.startsWith("anthropic/"))).toBe(true);
    expect(filterModelsForHarness("opencode", VALID_MODELS)).toEqual([...VALID_MODELS]);
  });
});

describe("harnessSupportsProviderAuth", () => {
  it("passes resolver-assigned legacy mode through on every harness", () => {
    expect(harnessSupportsProviderAuth("opencode", "anthropic", "legacy_scoped_oauth")).toBe(true);
    expect(harnessSupportsProviderAuth("claude", "anthropic", "legacy_scoped_oauth")).toBe(true);
  });

  it("only the Claude harness may select an Anthropic provider account", () => {
    expect(harnessSupportsProviderAuth("opencode", "anthropic", "provider_account")).toBe(false);
    expect(harnessSupportsProviderAuth("opencode", "anthropic", "api_key")).toBe(true);
    expect(harnessSupportsProviderAuth("claude", "anthropic", "provider_account")).toBe(true);
  });

  it("keeps OpenAI and xAI provider accounts on OpenCode", () => {
    expect(harnessSupportsProviderAuth("opencode", "openai", "provider_account")).toBe(true);
    expect(harnessSupportsProviderAuth("opencode", "xai", "provider_account")).toBe(true);
  });
});

describe("checkHarnessCompatibility", () => {
  it("accepts a compatible harness, model and auth", () => {
    expect(checkHarnessCompatibility("opencode", "anthropic/claude-sonnet-4-6")).toBeNull();
    expect(
      checkHarnessCompatibility("claude", "anthropic/claude-sonnet-4-6", {
        anthropic: "provider_account",
        openai: "provider_account",
      })
    ).toBeNull();
  });

  it("rejects a model the harness cannot run", () => {
    const result = checkHarnessCompatibility("claude", "openai/gpt-5.5");
    expect(result?.code).toBe("model");
    expect(result?.message).toContain("Claude Agent");
  });

  it("rejects an auth mode the harness cannot select for the model's provider", () => {
    const result = checkHarnessCompatibility("opencode", "anthropic/claude-sonnet-4-6", {
      anthropic: "provider_account",
    });
    expect(result?.code).toBe("provider_auth");
    expect(result?.message).toContain("API key");
  });

  it("ignores auth modes for providers the model does not use", () => {
    expect(
      checkHarnessCompatibility("opencode", "openai/gpt-5.5", {
        anthropic: "provider_account",
        openai: "api_key",
      })
    ).toBeNull();
  });
});
