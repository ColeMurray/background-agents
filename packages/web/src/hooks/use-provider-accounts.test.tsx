// @vitest-environment jsdom

import type { ReactNode } from "react";
import { renderHook, waitFor } from "@testing-library/react";
import { SWRConfig } from "swr";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { browserApiFetch } from "@/lib/browser-api-fetch";
import {
  cancelProviderDeviceAuthorization,
  connectProviderAccount,
  pollProviderDeviceAuthorization,
  startProviderDeviceAuthorization,
  type ProviderResourceError,
  useLegacyProviderCredentials,
  useProviderAccounts,
} from "./use-provider-accounts";

vi.mock("@/lib/auth-session", () => ({
  useAuthSession: () => ({ data: { user: { id: "user-1" } }, status: "authenticated" }),
}));

vi.mock("@/lib/browser-api-fetch", () => ({ browserApiFetch: vi.fn() }));

function wrapper({ children }: { children: ReactNode }) {
  return (
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>{children}</SWRConfig>
  );
}

describe("useLegacyProviderCredentials", () => {
  beforeEach(() => vi.clearAllMocks());

  it("retains the exact legacy key locations", async () => {
    vi.mocked(browserApiFetch).mockResolvedValue(
      Response.json({
        legacyKeys: [
          { scope: "global", key: "OPENAI_OAUTH_REFRESH_TOKEN" },
          {
            scope: "repository",
            scopeId: "7",
            repository: "acme/repo",
            key: "XAI_OAUTH_ACCESS_TOKEN",
          },
          { scope: "environment", scopeId: "env-1", key: "XAI_OAUTH_REFRESH_TOKEN" },
        ],
      })
    );

    const { result } = renderHook(() => useLegacyProviderCredentials(), { wrapper });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.legacyKeys).toEqual([
      { scope: "global", key: "OPENAI_OAUTH_REFRESH_TOKEN" },
      {
        scope: "repository",
        scopeId: "7",
        repository: "acme/repo",
        key: "XAI_OAUTH_ACCESS_TOKEN",
      },
      { scope: "environment", scopeId: "env-1", key: "XAI_OAUTH_REFRESH_TOKEN" },
    ]);
  });

  it("rejects an invalid inventory response", async () => {
    vi.mocked(browserApiFetch).mockResolvedValue(Response.json({ legacyKeys: "invalid" }));

    const { result } = renderHook(() => useLegacyProviderCredentials(), { wrapper });

    await waitFor(() => expect(result.current.error).toBeInstanceOf(Error));
  });
});

describe("useProviderAccounts", () => {
  beforeEach(() => vi.clearAllMocks());

  it("uses the shared static provider catalog without fetching it", async () => {
    vi.mocked(browserApiFetch)
      .mockResolvedValueOnce(Response.json({ accounts: [] }))
      .mockResolvedValueOnce(Response.json({ defaults: [] }));

    const { result } = renderHook(() => useProviderAccounts(), { wrapper });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.providers).toEqual([
      { provider: "openai", displayName: "OpenAI", subscriptionName: "ChatGPT" },
      { provider: "xai", displayName: "xAI", subscriptionName: "SuperGrok" },
    ]);
    expect(browserApiFetch).toHaveBeenCalledTimes(2);
    expect(browserApiFetch).not.toHaveBeenCalledWith("/api/model-subscription-providers");
  });
});

describe("connectProviderAccount", () => {
  beforeEach(() => vi.clearAllMocks());

  it("accepts the create response with reconnection metadata", async () => {
    const account = {
      id: "a".repeat(32),
      provider: "openai",
      displayName: "Primary",
      externalAccountId: "external-1",
      status: "active",
      createdBy: null,
      updatedBy: null,
      lastVerifiedAt: null,
      lastUsedAt: null,
      createdAt: 1,
      updatedAt: 1,
      archivedAt: null,
    };
    vi.mocked(browserApiFetch).mockResolvedValue(
      Response.json({ account, reconnectedExisting: false }, { status: 201 })
    );

    await expect(
      connectProviderAccount({
        provider: "openai",
        displayName: "Primary",
        refreshToken: "refresh-token",
        accountId: "external-1",
      })
    ).resolves.toEqual(account);
  });
});

describe("provider device authorization requests", () => {
  beforeEach(() => vi.clearAllMocks());

  it("validates start and poll responses with shared schemas", async () => {
    const transactionId = "b".repeat(64);
    vi.mocked(browserApiFetch)
      .mockResolvedValueOnce(
        Response.json({
          transactionId,
          provider: "openai",
          operation: "create",
          userCode: "ABCD-EFGH",
          verificationUrl: "https://auth.openai.com/codex/device",
          expiresAt: Date.now() + 60_000,
          expiresInMs: 60_000,
          pollIntervalMs: 1_000,
        })
      )
      .mockResolvedValueOnce(
        Response.json({
          status: "pending",
          expiresAt: Date.now() + 60_000,
          pollIntervalMs: 1_000,
          nextPollAt: Date.now() + 1_000,
        })
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    await expect(
      startProviderDeviceAuthorization("openai", {
        operation: "create",
        displayName: "ChatGPT account",
      })
    ).resolves.toMatchObject({ transactionId, userCode: "ABCD-EFGH", expiresInMs: 60_000 });
    await expect(pollProviderDeviceAuthorization("openai", transactionId)).resolves.toMatchObject({
      status: "pending",
    });
    await expect(
      cancelProviderDeviceAuthorization("openai", transactionId)
    ).resolves.toBeUndefined();

    expect(browserApiFetch).toHaveBeenNthCalledWith(
      1,
      "/api/model-provider-accounts/device-authorizations/openai",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ operation: "create", displayName: "ChatGPT account" }),
      })
    );
    expect(browserApiFetch).toHaveBeenNthCalledWith(
      2,
      `/api/model-provider-accounts/device-authorizations/openai/${transactionId}/poll`,
      expect.objectContaining({ method: "POST" })
    );
    expect(browserApiFetch).toHaveBeenNthCalledWith(
      3,
      `/api/model-provider-accounts/device-authorizations/openai/${transactionId}`,
      expect.objectContaining({ method: "DELETE" })
    );
  });

  it("rejects malformed device authorization responses", async () => {
    vi.mocked(browserApiFetch).mockResolvedValue(Response.json({ transactionId: "unsafe" }));

    await expect(
      startProviderDeviceAuthorization("openai", {
        operation: "create",
        displayName: "ChatGPT account",
      })
    ).rejects.toThrow("Invalid device authorization response");
  });

  it("preserves status and retryability from API errors", async () => {
    vi.mocked(browserApiFetch).mockResolvedValue(
      Response.json({ error: "Provider account is archived", retryable: false }, { status: 409 })
    );

    const request = startProviderDeviceAuthorization("openai", {
      operation: "reconnect",
      providerAccountId: "a".repeat(32),
    });

    await expect(request).rejects.toMatchObject({
      name: "ProviderResourceError",
      message: "Provider account is archived",
      status: 409,
      retryable: false,
    } satisfies Partial<ProviderResourceError>);
  });

  it("rejects invalid device authorization path parameters before fetching", async () => {
    await expect(pollProviderDeviceAuthorization("openai", "../unsafe")).rejects.toThrow();
    await expect(
      startProviderDeviceAuthorization("unknown" as "openai", {
        operation: "create",
        displayName: "ChatGPT account",
      })
    ).rejects.toThrow();
    expect(browserApiFetch).not.toHaveBeenCalled();
  });
});
