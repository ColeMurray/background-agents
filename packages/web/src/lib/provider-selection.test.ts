import { describe, expect, it } from "vitest";
import {
  buildInteractiveProviderRoutingIdentity,
  parseStoredProviderSelections,
  reconcileProviderSelections,
  setProviderSelection,
  type ProviderSelectionDrafts,
} from "./provider-selection";

describe("provider selection state", () => {
  const account = {
    id: "a".repeat(32),
    provider: "openai" as const,
    displayName: "Team ChatGPT",
    externalAccountId: null,
    status: "active" as const,
    createdBy: null,
    updatedBy: null,
    lastVerifiedAt: null,
    lastUsedAt: null,
    createdAt: 1,
    updatedAt: 1,
    archivedAt: null,
  };

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

  it("removes unavailable accounts while preserving API-key selections", () => {
    expect(
      reconcileProviderSelections(
        {
          openai: { mode: "provider_account", accountId: account.id },
          xai: { mode: "api_key" },
        },
        [{ ...account, status: "disabled" }]
      )
    ).toEqual({ xai: { mode: "api_key" } });
  });

  it("retains selections for active matching accounts", () => {
    const selections: ProviderSelectionDrafts = {
      openai: { mode: "provider_account", accountId: account.id },
    };

    expect(reconcileProviderSelections(selections, [account])).toBe(selections);
  });

  it("derives interactive routing from explicit selections before defaults", () => {
    expect(
      buildInteractiveProviderRoutingIdentity(
        { openai: { mode: "api_key" } },
        [
          {
            provider: "openai",
            providerAccountId: account.id,
            unattendedMode: "provider_account",
            createdBy: null,
            updatedBy: null,
            createdAt: 1,
            updatedAt: 1,
          },
        ],
        [account]
      )
    ).toEqual({
      openai: { mode: "api_key" },
      xai: { mode: "legacy_scoped_oauth" },
    });
  });

  it("tracks default account eligibility without unattended policy noise", () => {
    const providerDefault = {
      provider: "openai" as const,
      providerAccountId: account.id,
      unattendedMode: "api_key" as const,
      createdBy: null,
      updatedBy: null,
      createdAt: 1,
      updatedAt: 1,
    };

    expect(buildInteractiveProviderRoutingIdentity({}, [providerDefault], [account])).toEqual({
      openai: {
        mode: "provider_account",
        accountId: account.id,
        status: "active",
        archivedAt: null,
      },
      xai: { mode: "legacy_scoped_oauth" },
    });
  });
});
