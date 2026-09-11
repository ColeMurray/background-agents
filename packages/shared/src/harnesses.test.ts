import { describe, expect, it } from "vitest";
import {
  DEFAULT_HARNESS,
  HARNESS_IDS,
  checkHarnessCompatibility,
  filterModelsForHarness,
  getValidHarnessOrDefault,
  harnessSupportsModel,
  harnessSupportsProviderAuth,
  isValidHarness,
  selectedProviderAuthModes,
} from "./harnesses";
import { VALID_MODELS } from "./models";

describe("harness catalog", () => {
  it("lists only harnesses the runtime can boot, built-in first", () => {
    expect(HARNESS_IDS).toEqual(["opencode"]);
    expect(DEFAULT_HARNESS).toBe("opencode");
  });

  it("resolves an absent or unknown harness to the default", () => {
    expect(getValidHarnessOrDefault(undefined)).toBe("opencode");
    expect(getValidHarnessOrDefault(null)).toBe("opencode");
    expect(getValidHarnessOrDefault("codex")).toBe("opencode");
    expect(getValidHarnessOrDefault("opencode")).toBe("opencode");
    expect(isValidHarness("opencode")).toBe(true);
    expect(isValidHarness("codex")).toBe(false);
    expect(isValidHarness(42)).toBe(false);
  });
});

describe("harnessSupportsModel", () => {
  it("lets OpenCode run every catalog model", () => {
    for (const model of VALID_MODELS) {
      expect(harnessSupportsModel("opencode", model)).toBe(true);
    }
    expect(filterModelsForHarness("opencode", VALID_MODELS)).toEqual([...VALID_MODELS]);
  });
});

describe("harnessSupportsProviderAuth", () => {
  it("passes resolver-assigned legacy mode through", () => {
    expect(harnessSupportsProviderAuth("opencode", "openai", "legacy_scoped_oauth")).toBe(true);
    expect(harnessSupportsProviderAuth("opencode", "anthropic", "legacy_scoped_oauth")).toBe(true);
  });

  it("keeps OpenAI and xAI provider accounts and the Anthropic API key on OpenCode", () => {
    expect(harnessSupportsProviderAuth("opencode", "openai", "provider_account")).toBe(true);
    expect(harnessSupportsProviderAuth("opencode", "xai", "provider_account")).toBe(true);
    expect(harnessSupportsProviderAuth("opencode", "anthropic", "api_key")).toBe(true);
    expect(harnessSupportsProviderAuth("opencode", "anthropic", "provider_account")).toBe(false);
  });

  it("selects no auth mode for a provider the harness has no row for", () => {
    expect(harnessSupportsProviderAuth("opencode", "google", "api_key")).toBe(false);
    expect(harnessSupportsProviderAuth("opencode", "google", "provider_account")).toBe(false);
    expect(harnessSupportsProviderAuth("opencode", "google", "legacy_scoped_oauth")).toBe(true);
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
      checkHarnessCompatibility("opencode", "openai/gpt-5.5", { openai: "provider_account" })
    ).toBeNull();
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
