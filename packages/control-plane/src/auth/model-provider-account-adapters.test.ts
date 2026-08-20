import { describe, expect, it, vi } from "vitest";
import { OpenAIModelProviderAccountAdapter } from "./model-provider-account-openai-adapter";
import { XaiModelProviderAccountAdapter } from "./model-provider-account-xai-adapter";
import { modelProviderAccountAdapterRegistry } from "./model-provider-account-default-adapters";
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

  it("requires OpenAI to return a replacement refresh token", async () => {
    const adapter = new OpenAIModelProviderAccountAdapter(
      vi.fn().mockResolvedValue({ id_token: "id", access_token: "access" })
    );

    await expect(adapter.refresh({ refreshToken: "old" })).rejects.toMatchObject({
      classification: "ambiguous",
    });
  });

  it("does not use a claimed OpenAI account ID when trusted extraction fails", async () => {
    const adapter = new OpenAIModelProviderAccountAdapter(
      vi.fn().mockResolvedValue({
        id_token: "not-a-jwt",
        access_token: "access",
        refresh_token: "replacement",
      })
    );

    const result = await adapter.connect({ refreshToken: "old", accountId: "claimed-account" });

    expect(result.externalAccountId).toBeUndefined();
    expect(result.credential).not.toHaveProperty("accountId");
  });

  it("distinguishes a definitive OpenAI invalid_grant from an ambiguous failure", async () => {
    const unauthorized = new OpenAIModelProviderAccountAdapter(
      vi
        .fn()
        .mockRejectedValue(
          new OpenAITokenRefreshError("failed", 400, JSON.stringify({ error: "invalid_grant" }))
        )
    );
    const ambiguous = new OpenAIModelProviderAccountAdapter(
      vi.fn().mockRejectedValue(new OpenAITokenRefreshError("failed", 500, "upstream failure"))
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
});
