import { describe, expect, it } from "vitest";
import {
  MODEL_PROVIDER_ACCOUNT_ID_PATTERN,
  SUBSCRIPTION_PROVIDER_DISPLAY_METADATA,
  SUBSCRIPTION_PROVIDER_IDS,
  connectModelProviderAccountRequestSchema,
  modelProviderAccountReconnectMethod,
  modelProviderAccountDefaultResponseSchema,
  modelProviderAccountDefaultRequestSchema,
  modelProviderAccountDefaultsResponseSchema,
  modelProviderAccountResponseSchema,
  modelProviderAccountsResponseSchema,
  modelProviderAccountStatusSchema,
  modelProviderSelectionsSchema,
  providerAuthModeSchema,
  reconnectModelProviderAccountRequestSchema,
  providerDeviceAuthorizationStatusResponseSchema,
  startProviderDeviceAuthorizationRequestSchema,
  startProviderDeviceAuthorizationResponseSchema,
  sessionModelProviderAuthResponseSchema,
} from "./provider-accounts";

const ACCOUNT_ID = "0123456789abcdef0123456789abcdef";
const TRANSACTION_ID = "01".repeat(32);

describe("subscription provider registry", () => {
  it("exposes stable provider IDs and display metadata", () => {
    expect(SUBSCRIPTION_PROVIDER_IDS).toEqual(["openai", "xai"]);
    expect(SUBSCRIPTION_PROVIDER_DISPLAY_METADATA).toEqual({
      openai: { displayName: "OpenAI", subscriptionName: "ChatGPT" },
      xai: { displayName: "xAI", subscriptionName: "SuperGrok" },
    });
  });

  it("validates generated account IDs without accepting generic strings", () => {
    expect(MODEL_PROVIDER_ACCOUNT_ID_PATTERN.test(ACCOUNT_ID)).toBe(true);
    for (const value of ["", "account-1", "A".repeat(32), "0".repeat(31), "0".repeat(33)]) {
      expect(
        modelProviderSelectionsSchema.safeParse({
          openai: { mode: "provider_account", accountId: value },
        }).success
      ).toBe(false);
    }
  });
});

describe("modelProviderSelectionsSchema", () => {
  it("accepts a bounded partial map with strict discriminated selections", () => {
    expect(modelProviderSelectionsSchema.parse({})).toEqual({});
    expect(
      modelProviderSelectionsSchema.parse({
        openai: { mode: "provider_account", accountId: ACCOUNT_ID },
        xai: { mode: "api_key" },
      })
    ).toEqual({
      openai: { mode: "provider_account", accountId: ACCOUNT_ID },
      xai: { mode: "api_key" },
    });
  });

  it("rejects unknown provider keys and fields forbidden by each mode", () => {
    for (const selections of [
      { anthropic: { mode: "api_key" } },
      { OpenAI: { mode: "api_key" } },
      { openai: { mode: "api_key", accountId: ACCOUNT_ID } },
      { xai: { mode: "provider_account" } },
      { openai: { mode: "unknown" } },
    ]) {
      expect(modelProviderSelectionsSchema.safeParse(selections).success).toBe(false);
    }
  });
});

describe("provider account write requests", () => {
  it("shares the bounded account status, auth mode, and default update contracts", () => {
    expect(modelProviderAccountStatusSchema.options).toEqual([
      "active",
      "disabled",
      "reconnect_required",
    ]);
    expect(providerAuthModeSchema.options).toEqual(["provider_account", "api_key"]);
    expect(
      modelProviderAccountDefaultRequestSchema.safeParse({
        providerAccountId: ACCOUNT_ID,
        unattendedMode: "legacy_scoped_oauth",
      }).success
    ).toBe(false);
    expect(
      modelProviderAccountDefaultRequestSchema.parse({
        providerAccountId: ACCOUNT_ID,
        unattendedMode: "provider_account",
      })
    ).toEqual({ providerAccountId: ACCOUNT_ID, unattendedMode: "provider_account" });
    expect(
      modelProviderAccountDefaultRequestSchema.safeParse({
        providerAccountId: ACCOUNT_ID,
        unattendedMode: "provider_account",
        unexpected: true,
      }).success
    ).toBe(false);
  });

  it("accepts only the provider-specific connect fields", () => {
    expect(
      connectModelProviderAccountRequestSchema.safeParse({
        provider: "openai",
        displayName: "Team ChatGPT",
        refreshToken: "refresh-token",
        accountId: "acct_external",
      }).success
    ).toBe(true);
    expect(
      connectModelProviderAccountRequestSchema.safeParse({
        provider: "xai",
        displayName: "Team SuperGrok",
        refreshToken: "refresh-token",
      }).success
    ).toBe(true);
    expect(
      connectModelProviderAccountRequestSchema.safeParse({
        provider: "xai",
        displayName: "Team SuperGrok",
        refreshToken: "refresh-token",
        accountId: "not-an-xai-field",
      }).success
    ).toBe(false);
  });

  it("requires OpenAI account identity when reconnecting and rejects display updates", () => {
    expect(
      reconnectModelProviderAccountRequestSchema.safeParse({
        provider: "openai",
        refreshToken: "new-refresh-token",
        accountId: "acct_external",
      }).success
    ).toBe(true);
    expect(
      reconnectModelProviderAccountRequestSchema.safeParse({
        provider: "openai",
        refreshToken: "new-refresh-token",
      }).success
    ).toBe(false);
    expect(
      reconnectModelProviderAccountRequestSchema.safeParse({
        provider: "xai",
        refreshToken: "new-refresh-token",
        displayName: "rename through reconnect",
      }).success
    ).toBe(false);
  });
});

describe("provider device authorization contracts", () => {
  it("accepts only strict create and reconnect start inputs", () => {
    expect(
      startProviderDeviceAuthorizationRequestSchema.parse({
        operation: "create",
        displayName: "Primary OpenAI",
      })
    ).toEqual({ operation: "create", displayName: "Primary OpenAI" });
    expect(
      startProviderDeviceAuthorizationRequestSchema.parse({
        operation: "reconnect",
        providerAccountId: ACCOUNT_ID,
      })
    ).toEqual({ operation: "reconnect", providerAccountId: ACCOUNT_ID });
    for (const value of [
      { operation: "create", providerAccountId: ACCOUNT_ID },
      { operation: "reconnect", displayName: "Wrong" },
      { operation: "create", displayName: "OpenAI", refreshToken: "secret" },
    ]) {
      expect(startProviderDeviceAuthorizationRequestSchema.safeParse(value).success).toBe(false);
    }
  });

  it("exposes only browser-safe start and polling fields", () => {
    expect(
      startProviderDeviceAuthorizationResponseSchema.safeParse({
        transactionId: TRANSACTION_ID,
        provider: "openai",
        operation: "create",
        userCode: "ABCD-EFGH",
        verificationUrl: "https://auth.openai.com/codex/device",
        expiresAt: 10_000,
        expiresInMs: 9_000,
        pollIntervalMs: 5_000,
      }).success
    ).toBe(true);
    expect(
      providerDeviceAuthorizationStatusResponseSchema.safeParse({
        status: "pending",
        expiresAt: 10_000,
        pollIntervalMs: 5_000,
        nextPollAt: 6_000,
        deviceAuthId: "must-not-leak",
      }).success
    ).toBe(false);
    expect(
      providerDeviceAuthorizationStatusResponseSchema.safeParse({
        status: "failed",
        error: "Authorization failed.",
        retryable: true,
        providerBody: "must-not-leak",
      }).success
    ).toBe(false);
  });
});

describe("provider account response schemas", () => {
  const account = {
    id: ACCOUNT_ID,
    provider: "openai" as const,
    displayName: "Team ChatGPT",
    externalAccountId: "acct_external",
    status: "active",
    createdBy: "user-1",
    updatedBy: "user-1",
    lastVerifiedAt: 10,
    lastUsedAt: null,
    createdAt: 1,
    updatedAt: 10,
    archivedAt: null,
  };

  it("accepts secret-free account, default, and session auth responses", () => {
    expect(modelProviderAccountResponseSchema.safeParse({ account }).success).toBe(true);
    expect(modelProviderAccountsResponseSchema.safeParse({ accounts: [account] }).success).toBe(
      true
    );
    expect(
      modelProviderAccountDefaultsResponseSchema.safeParse({
        defaults: [
          {
            provider: "openai",
            providerAccountId: ACCOUNT_ID,
            unattendedMode: "provider_account",
            createdBy: "user-1",
            updatedBy: "user-1",
            createdAt: 1,
            updatedAt: 2,
          },
        ],
      }).success
    ).toBe(true);
    expect(
      modelProviderAccountDefaultResponseSchema.safeParse({
        default: {
          provider: "openai",
          providerAccountId: ACCOUNT_ID,
          unattendedMode: "provider_account",
          createdBy: "user-1",
          updatedBy: "user-1",
          createdAt: 1,
          updatedAt: 2,
        },
      }).success
    ).toBe(true);
    expect(
      sessionModelProviderAuthResponseSchema.safeParse({
        providerAuth: [
          {
            provider: "openai",
            authMode: "provider_account",
            providerAccountId: ACCOUNT_ID,
            selectionSource: "explicit",
          },
          {
            provider: "xai",
            authMode: "legacy_scoped_oauth",
            selectionSource: "legacy_fallback",
          },
        ],
      }).success
    ).toBe(true);
  });

  it("centralizes the legacy reconnect capability", () => {
    expect(modelProviderAccountReconnectMethod(account)).toBe("device_authorization");
    expect(
      modelProviderAccountReconnectMethod({
        provider: "xai",
        externalAccountId: null,
      })
    ).toBe("refresh_token");
    expect(
      modelProviderAccountReconnectMethod({
        provider: "xai",
        externalAccountId: "xai-user-1",
      })
    ).toBe("device_authorization");
  });

  it("rejects credential leakage and inconsistent auth modes", () => {
    expect(
      modelProviderAccountResponseSchema.safeParse({
        account: { ...account, refreshToken: "must-not-leak" },
      }).success
    ).toBe(false);
    for (const removed of [{ externalAccountKind: "account" }, { providerMetadata: {} }]) {
      expect(
        modelProviderAccountResponseSchema.safeParse({ account: { ...account, ...removed } })
          .success
      ).toBe(false);
    }
    expect(modelProviderAccountStatusSchema.safeParse("verification_failed").success).toBe(false);
    expect(
      sessionModelProviderAuthResponseSchema.safeParse({
        providerAuth: [
          {
            provider: "openai",
            authMode: "provider_account",
            providerAccountId: ACCOUNT_ID,
            selectionSource: "installation_default",
            routingSourceType: "provider_default",
          },
        ],
      }).success
    ).toBe(false);
    expect(
      sessionModelProviderAuthResponseSchema.safeParse({
        providerAuth: [
          {
            provider: "openai",
            authMode: "api_key",
            providerAccountId: ACCOUNT_ID,
            selectionSource: "explicit",
          },
        ],
      }).success
    ).toBe(false);
  });
});
