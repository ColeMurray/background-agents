import type {
  ProviderAccountRouting,
  SubscriptionProviderId,
} from "@open-inspect/shared/types/provider-accounts";
import { describe, expect, it, vi } from "vitest";
import type { ModelProviderAccount } from "../db/model-provider-accounts";
import type { ProviderDefault } from "../db/provider-account-defaults";
import { ProviderAccountSelectionPolicyError } from "../model-provider-accounts/selection-policy";
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
    routing?: ProviderAccountRouting[];
    random?: () => number;
  } = {}
) {
  const defaults = new Map((options.defaults ?? []).map((item) => [item.provider, item]));
  const accounts = new Map((options.accounts ?? []).map((item) => [item.id, item]));
  const routing = new Map((options.routing ?? []).map((item) => [item.provider, item]));
  return {
    defaults: {
      get: vi.fn(async (provider: SubscriptionProviderId) => defaults.get(provider) ?? null),
    },
    ...(options.routing
      ? {
          routing: {
            getRouting: vi.fn(
              async (provider: SubscriptionProviderId): Promise<ProviderAccountRouting> =>
                routing.get(provider) ?? {
                  provider,
                  unattendedMode: "provider_account",
                  selection: { mode: "unconfigured" },
                }
            ),
          },
        }
      : {}),
    ...(options.random ? { random: options.random } : {}),
    accounts: { getById: vi.fn(async (id: string) => accounts.get(id) ?? null) },
    adapters: { get: vi.fn(() => ({})) },
  };
}

describe("Codex connected-account scope", () => {
  it("falls back to the API key with no selection or default, never legacy OAuth", async () => {
    const fallback = await resolveProviderAccountSelections(
      { harness: "codex", model: "openai/gpt-5.6-sol", unattended: false },
      stores()
    );
    expect(fallback.find((item) => item.provider === "openai")).toEqual({
      provider: "openai",
      authMode: "api_key",
      selectionSource: "api_key_fallback",
    });
    const resolved = await resolveProviderAccountSelections(
      {
        harness: "codex",
        model: "openai/gpt-5.6-sol",
        unattended: false,
        explicit: { openai: { mode: "api_key" } },
      },
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
        model: "openai/gpt-5.6-sol",
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
      { harness: "codex", model: "openai/gpt-5.6-sol", unattended: false },
      deps
    );
    expect(interactive[0]).toMatchObject({
      authMode: "provider_account",
      providerAccountId: OPENAI_ACCOUNT_ID,
    });
    const unattended = await resolveProviderAccountSelections(
      { harness: "codex", model: "openai/gpt-5.6-sol", unattended: true },
      deps
    );
    expect(unattended[0]).toEqual({
      provider: "openai",
      authMode: "api_key",
      selectionSource: "unattended_policy",
    });
  });
});

describe("random provider account pools", () => {
  const pool = (
    accountIds: string[],
    unattendedMode: "provider_account" | "api_key" = "provider_account"
  ): ProviderAccountRouting => ({
    provider: "openai",
    unattendedMode,
    selection: { mode: "random", accountIds },
  });

  it("draws one eligible account for Codex and skips providers that harness cannot use", async () => {
    const random = vi.fn(() => 0.99);
    const resolved = await resolveProviderAccountSelections(
      { harness: "codex", model: "openai/gpt-5.6-sol", unattended: false, randomEnabled: true },
      stores({
        routing: [
          pool([OPENAI_ACCOUNT_ID, XAI_ACCOUNT_ID]),
          {
            provider: "xai",
            unattendedMode: "provider_account",
            selection: { mode: "random", accountIds: [XAI_ACCOUNT_ID] },
          },
        ],
        accounts: [account(OPENAI_ACCOUNT_ID, "openai"), account(XAI_ACCOUNT_ID, "openai")],
        random,
      })
    );
    expect(resolved.find((item) => item.provider === "openai")).toEqual({
      provider: "openai",
      authMode: "provider_account",
      providerAccountId: XAI_ACCOUNT_ID,
      selectionSource: "installation_random",
    });
    expect(resolved.find((item) => item.provider === "xai")).toEqual({
      provider: "xai",
      authMode: "api_key",
      selectionSource: "harness_fallback",
    });
    expect(random).toHaveBeenCalledOnce();
  });

  it("keeps the fixed default when random allocation is disabled and a pool is not configured", async () => {
    const resolved = await resolveProviderAccountSelections(
      { harness: "opencode", model: "openai/gpt-5.6-sol", unattended: false, randomEnabled: false },
      stores({
        routing: [
          {
            provider: "openai",
            unattendedMode: "provider_account",
            selection: { mode: "fixed", accountId: OPENAI_ACCOUNT_ID },
          },
        ],
        accounts: [account(OPENAI_ACCOUNT_ID, "openai")],
      })
    );
    expect(resolved[0]).toMatchObject({
      authMode: "provider_account",
      providerAccountId: OPENAI_ACCOUNT_ID,
      selectionSource: "installation_default",
    });
  });

  it("refuses a random pool while the rollout flag is off and skips ineligible members", async () => {
    const disabled = stores({
      routing: [pool([OPENAI_ACCOUNT_ID, XAI_ACCOUNT_ID])],
      accounts: [account(OPENAI_ACCOUNT_ID, "openai"), account(XAI_ACCOUNT_ID, "openai")],
      random: () => 0,
    });
    await expect(
      resolveProviderAccountSelections(
        {
          harness: "opencode",
          model: "openai/gpt-5.6-sol",
          unattended: false,
          randomEnabled: false,
        },
        disabled
      )
    ).rejects.toBeInstanceOf(ProviderAccountSelectionPolicyError);

    const inactive = account(OPENAI_ACCOUNT_ID, "openai", { status: "disabled" });
    const resolved = await resolveProviderAccountSelections(
      { harness: "opencode", model: "openai/gpt-5.6-sol", unattended: false, randomEnabled: true },
      stores({
        routing: [pool([OPENAI_ACCOUNT_ID, XAI_ACCOUNT_ID])],
        accounts: [inactive, account(XAI_ACCOUNT_ID, "openai")],
        random: () => 0,
      })
    );
    expect(resolved[0]).toMatchObject({ providerAccountId: XAI_ACCOUNT_ID });
  });

  it("does not fail an unrelated provider when its random pool is disabled", async () => {
    const resolved = await resolveProviderAccountSelections(
      {
        harness: "opencode",
        model: "anthropic/claude-haiku-4-5",
        unattended: false,
        randomEnabled: false,
      },
      stores({
        routing: [pool([OPENAI_ACCOUNT_ID, XAI_ACCOUNT_ID])],
        accounts: [account(OPENAI_ACCOUNT_ID, "openai"), account(XAI_ACCOUNT_ID, "openai")],
      })
    );
    expect(resolved.find((item) => item.provider === "openai")).toEqual({
      provider: "openai",
      authMode: "legacy_scoped_oauth",
      selectionSource: "legacy_fallback",
    });
    expect(resolved.find((item) => item.provider === "anthropic")).toEqual({
      provider: "anthropic",
      authMode: "api_key",
      selectionSource: "api_key_fallback",
    });
  });

  it("uses API key for unattended runs without drawing", async () => {
    const random = vi.fn(() => 0);
    const resolved = await resolveProviderAccountSelections(
      { harness: "codex", model: "openai/gpt-5.6-sol", unattended: true, randomEnabled: true },
      stores({
        routing: [pool([OPENAI_ACCOUNT_ID], "api_key")],
        accounts: [account(OPENAI_ACCOUNT_ID, "openai")],
        random,
      })
    );
    expect(resolved[0]).toEqual({
      provider: "openai",
      authMode: "api_key",
      selectionSource: "unattended_policy",
    });
    expect(random).not.toHaveBeenCalled();
  });
});
