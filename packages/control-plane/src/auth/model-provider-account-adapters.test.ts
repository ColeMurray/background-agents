import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { OpenAIModelProviderAccountAdapter } from "./model-provider-account-openai-adapter";
import { XaiModelProviderAccountAdapter } from "./model-provider-account-xai-adapter";
import { modelProviderAccountAdapterRegistry } from "./model-provider-account-default-adapters";
import { ProviderIdentityError } from "./model-provider-account-adapters";
import type { ModelProviderAccountAdapterRegistry } from "./model-provider-account-adapters";
import { OpenAITokenRefreshError } from "./openai";

describe("model provider account adapters", () => {
  it("registers OpenAI and xAI", () => {
    expect(modelProviderAccountAdapterRegistry.get("openai")).toBeInstanceOf(
      OpenAIModelProviderAccountAdapter
    );
    expect(modelProviderAccountAdapterRegistry.get("xai")).toBeInstanceOf(
      XaiModelProviderAccountAdapter
    );
  });

  it("requires complete adapters at the registry boundary", () => {
    type RegistryAdapters = ConstructorParameters<typeof ModelProviderAccountAdapterRegistry>[0];
    expectTypeOf<
      readonly [{ readonly provider: "openai" }]
    >().not.toMatchTypeOf<RegistryAdapters>();
  });

  it("uses the canonical provider request schemas", () => {
    const openai = new OpenAIModelProviderAccountAdapter();
    const xai = new XaiModelProviderAccountAdapter();

    expect(() =>
      openai.parseConnectInput({
        provider: "openai",
        refreshToken: "refresh-token",
      })
    ).toThrow();
    expect(() =>
      openai.parseConnectInput({
        provider: "openai",
        refreshToken: "x".repeat(65_537),
        accountId: "acct-1",
      })
    ).toThrow();
    expect(() =>
      xai.parseConnectInput({
        provider: "xai",
        refreshToken: "refresh-token",
        accountId: "unexpected",
      })
    ).toThrow();
  });

  it("requires OpenAI to return a replacement refresh token", async () => {
    const adapter = new OpenAIModelProviderAccountAdapter(
      vi.fn().mockResolvedValue({ id_token: "id", access_token: "access" })
    );

    await expect(adapter.refresh({ refreshToken: "old" })).rejects.toMatchObject({
      classification: "ambiguous",
    });
  });

  it("rejects a claimed OpenAI account ID when trusted extraction fails", async () => {
    const adapter = new OpenAIModelProviderAccountAdapter(
      vi.fn().mockResolvedValue({
        id_token: "not-a-jwt",
        access_token: "access",
        refresh_token: "replacement",
      })
    );

    await expect(
      adapter.connect({
        provider: "openai",
        refreshToken: "old",
        accountId: "claimed-account",
      })
    ).rejects.toBeInstanceOf(ProviderIdentityError);
  });

  it("distinguishes a definitive OpenAI invalid_grant from an ambiguous failure", async () => {
    const unauthorized = new OpenAIModelProviderAccountAdapter(
      vi.fn().mockRejectedValue(new OpenAITokenRefreshError("failed", 400, "invalid_grant"))
    );
    const ambiguous = new OpenAIModelProviderAccountAdapter(
      vi.fn().mockRejectedValue(new OpenAITokenRefreshError("failed", 500))
    );

    await expect(unauthorized.refresh({ refreshToken: "old" })).rejects.toMatchObject({
      classification: "unauthorized",
    });
    await expect(ambiguous.refresh({ refreshToken: "old" })).rejects.toMatchObject({
      classification: "ambiguous",
    });
  });

  it("retains the xAI refresh token when replacement is omitted", async () => {
    const adapter = new XaiModelProviderAccountAdapter(
      vi.fn().mockResolvedValue({ access_token: "access", expires_in: 120 })
    );

    const result = await adapter.refresh({ refreshToken: "old" }, 1_000);

    expect(result.credential).toEqual({
      refreshToken: "old",
      accessToken: "access",
      accessTokenExpiresAt: 121_000,
    });
  });

  it("uses a bounded default expiry when a provider omits expiry", async () => {
    const adapter = new XaiModelProviderAccountAdapter(
      vi.fn().mockResolvedValue({ access_token: "access" })
    );

    const result = await adapter.refresh({ refreshToken: "refresh" }, 10_000);

    expect(result.accessTokenExpiresAt).toBe(3_610_000);
    expect(result.credential.accessTokenExpiresAt).toBe(3_610_000);
  });

  it("only exposes allowlisted runtime metadata", () => {
    const openai = new OpenAIModelProviderAccountAdapter();
    const xai = new XaiModelProviderAccountAdapter();

    expect(
      openai.runtimeMetadata(
        { refreshToken: "secret", accountId: "credential-account" },
        "stored-account"
      )
    ).toEqual({ accountId: "credential-account" });
    expect(openai.runtimeMetadata({ refreshToken: "secret" }, "stored-account")).toEqual({
      accountId: "stored-account",
    });
    expect(xai.runtimeMetadata({ refreshToken: "secret" }, null)).toEqual({});
  });

  it("validates persisted OpenAI device state and its schema version before polling", async () => {
    const capability = modelProviderAccountAdapterRegistry.requireDeviceAuthorization("openai");

    await expect(async () =>
      capability.pollPersisted({ deviceAuthId: "device" }, 1, 5_000)
    ).rejects.toThrow();
    await expect(async () =>
      capability.pollPersisted({ deviceAuthId: "device", userCode: "CODE" }, 2, 5_000)
    ).rejects.toThrow(/version/i);
    await expect(async () =>
      capability.pollPersisted(
        { deviceAuthId: "device", userCode: "CODE", unexpected: true },
        1,
        5_000
      )
    ).rejects.toThrow();
  });

  it("registers and validates persisted xAI device authorization state", async () => {
    const capability = modelProviderAccountAdapterRegistry.requireDeviceAuthorization("xai");

    await expect(async () => capability.pollPersisted({}, 1, 5_000)).rejects.toThrow();
    await expect(async () =>
      capability.pollPersisted({ deviceCode: "device" }, 2, 5_000)
    ).rejects.toThrow(/version/i);
    await expect(async () =>
      capability.pollPersisted({ deviceCode: "device", unexpected: true }, 1, 5_000)
    ).rejects.toThrow();
  });
});
