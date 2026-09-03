import { describe, expect, it, vi } from "vitest";
import type { ModelProviderAccount } from "../db/model-provider-accounts";
import type { ProviderDefault } from "../db/provider-account-defaults";
import { resolveProviderAccountSelections } from "./provider-account-resolution";
import { ProviderAccountSelectionPolicyError } from "../model-provider-accounts/selection-policy";
import type { SubscriptionProviderId } from "@open-inspect/shared/types/provider-accounts";

const OPENAI_ACCOUNT_ID = "1".repeat(32);
const XAI_ACCOUNT_ID = "2".repeat(32);

function account(
  id: string,
  provider: SubscriptionProviderId,
  overrides: Partial<ModelProviderAccount> = {}
): ModelProviderAccount {
  return {
    id,
    provider,
    displayName: provider,
    externalAccountId: null,
    status: "active",
    createdBy: null,
    updatedBy: null,
    lastVerifiedAt: null,
    lastUsedAt: null,
    createdAt: 1,
    updatedAt: 1,
    archivedAt: null,
    ...overrides,
  };
}

function providerDefault(
  provider: SubscriptionProviderId,
  providerAccountId: string,
  unattendedMode: "provider_account" | "api_key" = "provider_account"
): ProviderDefault {
  return {
    provider,
    providerAccountId,
    unattendedMode,
    createdBy: null,
    updatedBy: null,
    createdAt: 1,
    updatedAt: 1,
  };
}

function stores(
  options: {
    defaults?: ProviderDefault[];
    accounts?: ModelProviderAccount[];
  } = {}
) {
  const defaults = new Map((options.defaults ?? []).map((item) => [item.provider, item]));
  const accounts = new Map((options.accounts ?? []).map((item) => [item.id, item]));
  return {
    defaults: {
      get: vi.fn(async (provider: SubscriptionProviderId) => defaults.get(provider) ?? null),
    },
    accounts: { getById: vi.fn(async (id: string) => accounts.get(id) ?? null) },
    adapters: { get: vi.fn(() => ({})) },
  };
}

describe("resolveProviderAccountSelections", () => {
  it("uses legacy scoped OAuth when no explicit choice or default exists", async () => {
    await expect(
      resolveProviderAccountSelections({ unattended: false }, stores())
    ).resolves.toEqual([
      { provider: "anthropic", authMode: "api_key", selectionSource: "api_key_fallback" },
      { provider: "openai", authMode: "legacy_scoped_oauth", selectionSource: "legacy_fallback" },
      { provider: "xai", authMode: "legacy_scoped_oauth", selectionSource: "legacy_fallback" },
    ]);
  });

  it("resolves every provider using explicit choices before defaults", async () => {
    const result = await resolveProviderAccountSelections(
      {
        explicit: {
          anthropic: { mode: "api_key" },
          openai: { mode: "provider_account", accountId: OPENAI_ACCOUNT_ID },
          xai: { mode: "api_key" },
        },
        unattended: false,
      },
      stores({
        defaults: [
          providerDefault("openai", XAI_ACCOUNT_ID),
          providerDefault("xai", XAI_ACCOUNT_ID),
        ],
        accounts: [account(OPENAI_ACCOUNT_ID, "openai"), account(XAI_ACCOUNT_ID, "xai")],
      })
    );

    expect(result).toEqual([
      { provider: "anthropic", authMode: "api_key", selectionSource: "explicit" },
      {
        provider: "openai",
        authMode: "provider_account",
        providerAccountId: OPENAI_ACCOUNT_ID,
        selectionSource: "explicit",
      },
      { provider: "xai", authMode: "api_key", selectionSource: "explicit" },
    ]);
  });

  it("applies unattended API-key policy before an active default", async () => {
    const result = await resolveProviderAccountSelections(
      { unattended: true },
      stores({
        defaults: [providerDefault("openai", OPENAI_ACCOUNT_ID, "api_key")],
        accounts: [account(OPENAI_ACCOUNT_ID, "openai")],
      })
    );

    expect(result[0]).toEqual({
      provider: "anthropic",
      authMode: "api_key",
      selectionSource: "api_key_fallback",
    });
    expect(result[1]).toEqual({
      provider: "openai",
      authMode: "api_key",
      selectionSource: "unattended_policy",
    });
    expect(result[2]).toEqual({
      provider: "xai",
      authMode: "legacy_scoped_oauth",
      selectionSource: "legacy_fallback",
    });
  });

  it("snapshots the active default account selection", async () => {
    const defaults = [providerDefault("openai", OPENAI_ACCOUNT_ID)];
    const deps = stores({ defaults, accounts: [account(OPENAI_ACCOUNT_ID, "openai")] });
    const result = await resolveProviderAccountSelections({ unattended: false }, deps);

    defaults[0] = providerDefault("openai", XAI_ACCOUNT_ID);

    expect(result[1]).toEqual({
      provider: "openai",
      authMode: "provider_account",
      providerAccountId: OPENAI_ACCOUNT_ID,
      selectionSource: "installation_default",
    });
  });

  it.each([
    ["missing", null, 404],
    ["mismatched", account(OPENAI_ACCOUNT_ID, "xai"), 400],
    ["inactive", account(OPENAI_ACCOUNT_ID, "openai", { status: "disabled" }), 409],
    ["archived", account(OPENAI_ACCOUNT_ID, "openai", { archivedAt: 2 }), 409],
  ] as const)("rejects an explicit account that is %s", async (_label, selectedAccount, status) => {
    const error = await resolveProviderAccountSelections(
      {
        explicit: {
          openai: { mode: "provider_account", accountId: OPENAI_ACCOUNT_ID },
        },
        unattended: false,
      },
      stores({ accounts: selectedAccount ? [selectedAccount] : [] })
    ).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(ProviderAccountSelectionPolicyError);
    expect(error).toMatchObject({ status });
  });

  it("treats a default selected by policy as a configuration error when unusable", async () => {
    await expect(
      resolveProviderAccountSelections(
        { unattended: false },
        stores({ defaults: [providerDefault("openai", OPENAI_ACCOUNT_ID)] })
      )
    ).rejects.toMatchObject({ status: 404 });
  });
});
