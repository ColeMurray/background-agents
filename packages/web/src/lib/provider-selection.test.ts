import { describe, expect, it } from "vitest";
import {
  parseStoredProviderSelections,
  setProviderSelection,
  type ProviderSelectionDrafts,
} from "./provider-selection";

describe("provider selection state", () => {
  it("retains explicit state for every provider while another provider changes", () => {
    let state: ProviderSelectionDrafts = {};
    state = setProviderSelection(state, "openai", {
      mode: "provider_account",
      accountId: "a".repeat(32),
    });
    state = setProviderSelection(state, "xai", { mode: "api_key" });

    expect(state).toEqual({
      openai: { mode: "provider_account", accountId: "a".repeat(32) },
      xai: { mode: "api_key" },
    });
  });

  it("removes only the selected provider when policy mode is restored", () => {
    const state: ProviderSelectionDrafts = {
      openai: { mode: "api_key" },
      xai: { mode: "provider_account", accountId: "b".repeat(32) },
    };

    expect(setProviderSelection(state, "openai", undefined)).toEqual({
      xai: { mode: "provider_account", accountId: "b".repeat(32) },
    });
  });

  it("parses valid stored selections", () => {
    expect(
      parseStoredProviderSelections(
        JSON.stringify({
          openai: { mode: "provider_account", accountId: "a".repeat(32) },
          xai: { mode: "api_key" },
        })
      )
    ).toEqual({
      openai: { mode: "provider_account", accountId: "a".repeat(32) },
      xai: { mode: "api_key" },
    });
  });

  it.each([null, "not json", JSON.stringify({ openai: { mode: "unknown" } })])(
    "ignores invalid stored selections: %s",
    (value) => {
      expect(parseStoredProviderSelections(value)).toBeNull();
    }
  );
});
