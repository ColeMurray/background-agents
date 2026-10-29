import type { SubscriptionProviderId } from "@open-inspect/shared/types/provider-accounts";
import { describe, expect, it, vi } from "vitest";
import type { ModelProviderAccount } from "../db/model-provider-accounts";
import type { ProviderDefault } from "../db/provider-account-defaults";
import { resolveProviderAccountSelections } from "./provider-account-resolution";

const OPENAI_ACCOUNT_ID = "1".repeat(32);
const XAI_ACCOUNT_ID = "2".repeat(32);
const ANTHROPIC_ACCOUNT_ID = "3".repeat(32);

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
    defaults: { get: vi.fn(async (provider: "openai" | "xai") => defaults.get(provider) ?? null) },
    accounts: { getById: vi.fn(async (id: string) => accounts.get(id) ?? null) },
    adapters: { get: vi.fn(() => ({})) },
  };
}

describe("Codex connected-account scope", () => {
  it("falls back to the API key with no selection or default, never legacy OAuth", async () => {
    const fallback = await resolveProviderAccountSelections(
      { harness: "codex", unattended: false },
      stores()
    );
    expect(fallback.find((item) => item.provider === "openai")).toEqual({
      provider: "openai",
      authMode: "api_key",
      selectionSource: "api_key_fallback",
    });
    const resolved = await resolveProviderAccountSelections(
      { harness: "codex", unattended: false, explicit: { openai: { mode: "api_key" } } },
      stores()
    );
    expect(resolved[0]).toEqual({
      provider: "openai",
      authMode: "api_key",
      selectionSource: "explicit",
    });
  });
  it("ignores unreachable stale provider selections without validating their accounts", async () => {
    const deps = stores();
    const resolved = await resolveProviderAccountSelections(
      {
        harness: "codex",
        unattended: false,
        explicit: {
          openai: { mode: "api_key" },
          anthropic: { mode: "provider_account", accountId: ANTHROPIC_ACCOUNT_ID },
          xai: { mode: "provider_account", accountId: XAI_ACCOUNT_ID },
        },
      },
      deps
    );
    expect(deps.accounts.getById).not.toHaveBeenCalled();
    expect(resolved).toEqual([
      { provider: "openai", authMode: "api_key", selectionSource: "explicit" },
      { provider: "xai", authMode: "api_key", selectionSource: "harness_fallback" },
      { provider: "anthropic", authMode: "api_key", selectionSource: "harness_fallback" },
    ]);
  });
  it("binds a connected Settings default and preserves unattended API policy", async () => {
    const deps = stores({
      defaults: [providerDefault("openai", OPENAI_ACCOUNT_ID, "api_key")],
      accounts: [account(OPENAI_ACCOUNT_ID, "openai")],
    });
    const interactive = await resolveProviderAccountSelections(
      { harness: "codex", unattended: false },
      deps
    );
    expect(interactive[0]).toMatchObject({
      authMode: "provider_account",
      providerAccountId: OPENAI_ACCOUNT_ID,
    });
    const unattended = await resolveProviderAccountSelections(
      { harness: "codex", unattended: true },
      deps
    );
    expect(unattended[0]).toEqual({
      provider: "openai",
      authMode: "api_key",
      selectionSource: "unattended_policy",
    });
  });
});
