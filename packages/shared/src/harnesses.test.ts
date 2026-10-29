import { describe, expect, it } from "vitest";
import {
  DEFAULT_HARNESS,
  HARNESS_CATALOG,
  HARNESS_IDS,
  checkHarnessCompatibility,
  filterModelsForHarness,
  getValidHarnessOrDefault,
  getHarnessReasoningConfig,
  harnessSupportsModel,
  harnessSupportsProviderAuth,
  isValidHarness,
  selectedProviderAuthModes,
  reconcileProviderSelectionsForHarness,
  resolveHarnessModel,
  checkHarnessPromptCompatibility,
  selectHarnessProviderSelections,
} from "./harnesses";
import { DEFAULT_MODEL, VALID_MODELS, getReasoningConfig } from "./models";

describe("harness selection policy", () => {
  it.each(["opencode", "claude"] as const)(
    "preserves %s legacy model and effort fallback",
    (harness) => {
      expect(resolveHarnessModel(harness, "unknown")).toBe(DEFAULT_MODEL);
      expect(checkHarnessPromptCompatibility(harness, DEFAULT_MODEL, "invalid")).toBeNull();
    }
  );
  it("keeps invalid native models visible for rejection instead of substituting a default", () => {
    expect(resolveHarnessModel("codex", "unknown")).not.toBe(DEFAULT_MODEL);
    expect(
      checkHarnessPromptCompatibility("codex", resolveHarnessModel("codex", "unknown"))?.code
    ).toBe("model");
    expect(resolveHarnessModel("codex", "gpt-6.1-sol")).toBe("openai/gpt-6.1-sol");
    expect(checkHarnessPromptCompatibility("codex", "openai/gpt-6.1-sol", "invalid")?.code).toBe(
      "reasoning_effort"
    );
  });
  it("scopes execution routing without erasing UI preferences for a later harness switch", () => {
    const selections = {
      openai: { mode: "api_key" as const },
      anthropic: { mode: "provider_account" as const, accountId: "unused" },
    };
    expect(selectHarnessProviderSelections("codex", selections)).toEqual({
      openai: selections.openai,
    });
    expect(reconcileProviderSelectionsForHarness("codex", selections)).toBe(selections);
    expect(selectHarnessProviderSelections("claude", selections)).toBe(selections);
    expect(selectHarnessProviderSelections("opencode", selections)).toBe(selections);
  });
});

describe("harness catalog", () => {
  it("lists only harnesses the runtime can boot, built-in first", () => {
    expect(HARNESS_IDS).toEqual(["opencode", "claude", "codex"]);
    expect(DEFAULT_HARNESS).toBe("opencode");
  });

  it("never brands the Claude harness as Claude Code", () => {
    expect(HARNESS_CATALOG.claude.label).toBe("Claude Agent");
  });

  it("resolves an absent or unknown harness to the default", () => {
    expect(getValidHarnessOrDefault(undefined)).toBe("opencode");
    expect(getValidHarnessOrDefault(null)).toBe("opencode");
    expect(getValidHarnessOrDefault("unknown")).toBe("opencode");
    expect(getValidHarnessOrDefault("claude")).toBe("claude");
    expect(isValidHarness("claude")).toBe(true);
    expect(isValidHarness("codex")).toBe(true);
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
    expect(harnessSupportsProviderAuth("claude", "openai", "legacy_scoped_oauth")).toBe(true);
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

  it("selects no auth mode for a provider the harness has no row for", () => {
    expect(harnessSupportsProviderAuth("claude", "openai", "provider_account")).toBe(false);
    expect(harnessSupportsProviderAuth("claude", "openai", "api_key")).toBe(false);
    expect(harnessSupportsProviderAuth("claude", "xai", "provider_account")).toBe(false);
    expect(harnessSupportsProviderAuth("opencode", "google", "api_key")).toBe(false);
  });
});

describe("reconcileProviderSelectionsForHarness", () => {
  const account = { mode: "provider_account" as const, accountId: "a".repeat(32) };

  it("drops a selection the harness runs the provider without", () => {
    expect(
      reconcileProviderSelectionsForHarness("opencode", { anthropic: account, openai: account })
    ).toEqual({ openai: account });
  });

  it("keeps selections for providers the harness does not run", () => {
    const selections = { openai: account, xai: { mode: "api_key" as const } };
    expect(reconcileProviderSelectionsForHarness("claude", selections)).toBe(selections);
  });

  it("returns the same object when every selection is usable", () => {
    const selections = { anthropic: account };
    expect(reconcileProviderSelectionsForHarness("claude", selections)).toBe(selections);
    expect(
      reconcileProviderSelectionsForHarness("opencode", { anthropic: { mode: "api_key" } })
    ).toEqual({ anthropic: { mode: "api_key" } });
  });
});

describe("selectedProviderAuthModes", () => {
  it("maps explicit selections to their modes and skips absent providers", () => {
    expect(
      selectedProviderAuthModes({
        openai: { mode: "provider_account", accountId: "0123456789abcdef0123456789abcdef" },
        xai: { mode: "api_key" },
      })
    ).toEqual({ openai: "provider_account", xai: "api_key" });
    expect(selectedProviderAuthModes({ openai: undefined })).toEqual({});
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

describe("Codex pinned native compatibility", () => {
  it.each([
    ["openai/gpt-5.5", "medium", false],
    ["openai/gpt-5.6-sol", "low", true],
    ["openai/gpt-5.6-terra", "medium", true],
    ["openai/gpt-5.6-luna", "medium", true],
    ["openai/gpt-6-astra", "low", true],
    ["openai/gpt-6-sol", "medium", true],
    ["openai/gpt-6.1-sol", "low", true],
    ["openai/gpt-6-luna", "medium", true],
  ] as const)(
    "preserves native reasoning for %s without changing legacy settings",
    (model, effort, max) => {
      const legacy = structuredClone(getReasoningConfig(model));
      const native = getHarnessReasoningConfig("codex", model);
      expect(native?.default).toBe(effort);
      expect(native?.efforts).not.toContain("none");
      expect(native?.efforts.includes("max")).toBe(max);
      expect(getReasoningConfig(model)).toEqual(legacy);
      for (const harness of ["opencode", "claude"] as const) {
        expect(getHarnessReasoningConfig(harness, model)).toEqual(legacy);
      }
    }
  );
  it("intersects the native catalog without changing legacy model support", () => {
    expect(harnessSupportsModel("codex", "openai/gpt-6.1-sol")).toBe(true);
    expect(harnessSupportsModel("codex", "gpt-5.5")).toBe(true);
    expect(harnessSupportsModel("codex", "openai/gpt-5.4")).toBe(false);
    expect(harnessSupportsModel("opencode", "openai/gpt-5.4")).toBe(true);
    expect(harnessSupportsModel("codex", "anthropic/claude-sonnet-4-6")).toBe(false);
  });
  it("accepts native max but never none or automatic ultra delegation", () => {
    expect(checkHarnessCompatibility("codex", "openai/gpt-5.6-sol", undefined, "max")).toBeNull();
    for (const effort of ["none", "ultra", ""]) {
      expect(
        checkHarnessCompatibility("codex", "openai/gpt-6.1-sol", undefined, effort)?.code
      ).toBe("reasoning_effort");
    }
    expect(checkHarnessCompatibility("codex", "openai/gpt-5.5", undefined, "max")?.code).toBe(
      "reasoning_effort"
    );
  });
  it("permits API keys and connected Settings accounts but not legacy OAuth", () => {
    for (const mode of ["api_key", "provider_account"] as const) {
      expect(checkHarnessCompatibility("codex", "openai/gpt-6-sol", { openai: mode })).toBeNull();
    }
    expect(
      checkHarnessCompatibility("codex", "openai/gpt-6-sol", { openai: "legacy_scoped_oauth" })
        ?.code
    ).toBe("provider_auth");
  });
});
