import { describe, expect, it, vi } from "vitest";
import { AnthropicTokenError } from "./anthropic";
import { ProviderIdentityError } from "./model-provider-account-adapters";
import { AnthropicModelProviderAccountAdapter } from "./model-provider-account-anthropic-adapter";

const NOW = 1_000_000;
const CONNECT_INPUT = {
  provider: "anthropic" as const,
  displayName: "Team Claude",
  authorizationCode: "code",
  codeVerifier: "v".repeat(43),
  state: "state",
};

describe("AnthropicModelProviderAccountAdapter", () => {
  it("creates credential v1 from authorization-code tokens with the 8-hour default", async () => {
    const adapter = new AnthropicModelProviderAccountAdapter(
      vi.fn().mockResolvedValue({
        access_token: "access",
        refresh_token: "refresh",
        refresh_token_expires_in: 3600,
        scope: "user:inference user:profile",
        account: { uuid: "account-id" },
        organization: { uuid: "organization-id" },
      })
    );

    await expect(adapter.connect(CONNECT_INPUT, NOW)).resolves.toEqual({
      credential: {
        refreshToken: "refresh",
        accessToken: "access",
        accessTokenExpiresAt: NOW + 8 * 60 * 60 * 1000,
        refreshTokenExpiresAt: NOW + 3_600_000,
        scopes: ["user:inference", "user:profile"],
      },
      accessTokenExpiresAt: NOW + 8 * 60 * 60 * 1000,
    });
  });

  it("rotates refresh tokens and computes provider expiries", async () => {
    const adapter = new AnthropicModelProviderAccountAdapter(
      vi.fn(),
      vi.fn().mockResolvedValue({
        access_token: "next-access",
        refresh_token: "next-refresh",
        expires_at: NOW + 120_000,
        refresh_token_expires_at: 2_000_000,
        scope: "user:inference",
      })
    );

    const result = await adapter.refresh(
      {
        refreshToken: "old-refresh",
        accessToken: "old-access",
        accessTokenExpiresAt: NOW,
      },
      NOW
    );

    expect(result).toEqual({
      credential: {
        refreshToken: "next-refresh",
        accessToken: "next-access",
        accessTokenExpiresAt: NOW + 120_000,
        refreshTokenExpiresAt: 2_000_000,
        scopes: ["user:inference"],
      },
      accessToken: "next-access",
      accessTokenExpiresAt: NOW + 120_000,
    });
  });

  it("preserves refresh-token state when a successful refresh omits replacements", async () => {
    const adapter = new AnthropicModelProviderAccountAdapter(
      vi.fn(),
      vi.fn().mockResolvedValue({ access_token: "next-access" })
    );

    const result = await adapter.refresh(
      {
        refreshToken: "old-refresh",
        accessToken: "old-access",
        accessTokenExpiresAt: NOW,
        refreshTokenExpiresAt: 9_000_000,
        scopes: ["user:inference"],
      },
      NOW
    );

    expect(result.credential).toEqual({
      refreshToken: "old-refresh",
      accessToken: "next-access",
      accessTokenExpiresAt: NOW + 8 * 60 * 60 * 1000,
      refreshTokenExpiresAt: 9_000_000,
      scopes: ["user:inference"],
    });
  });

  it("rejects stale or seconds-based absolute expiry timestamps", async () => {
    const adapter = new AnthropicModelProviderAccountAdapter(
      vi.fn(),
      vi.fn().mockResolvedValue({
        access_token: "next-access",
        expires_at: 2_000,
      })
    );

    await expect(
      adapter.refresh(
        { refreshToken: "refresh", accessToken: "access", accessTokenExpiresAt: NOW },
        NOW
      )
    ).rejects.toMatchObject({ classification: "ambiguous" });
  });

  it("returns cached access and strictly validates persisted credentials", () => {
    const adapter = new AnthropicModelProviderAccountAdapter();
    const credential = {
      refreshToken: "refresh",
      accessToken: "access",
      accessTokenExpiresAt: 2_000_000,
    };

    expect(adapter.cachedAccess(credential)).toEqual({
      accessToken: "access",
      accessTokenExpiresAt: 2_000_000,
    });
    expect(adapter.parseCredential(credential, 1)).toEqual(credential);
    expect(() => adapter.parseCredential({ ...credential, extra: true }, 1)).toThrow();
    expect(() => adapter.parseCredential(credential, 2)).toThrow(/version/i);
  });

  it("maps definitive authorization failures and all uncertain failures", async () => {
    const unauthorized = new AnthropicModelProviderAccountAdapter(
      vi.fn(),
      vi.fn().mockRejectedValue(new AnthropicTokenError("failed", 400, "unauthorized"))
    );
    const ambiguous = new AnthropicModelProviderAccountAdapter(
      vi.fn(),
      vi.fn().mockRejectedValue(new AnthropicTokenError("failed", 503, "other"))
    );

    const credential = {
      refreshToken: "refresh",
      accessToken: "access",
      accessTokenExpiresAt: NOW,
    };
    await expect(unauthorized.refresh(credential)).rejects.toMatchObject({
      classification: "unauthorized",
    });
    await expect(ambiguous.refresh(credential)).rejects.toMatchObject({
      classification: "ambiguous",
    });
  });

  it("retains safe upstream diagnostics when authorization-code exchange fails", async () => {
    const adapter = new AnthropicModelProviderAccountAdapter(
      vi.fn().mockRejectedValue(new AnthropicTokenError("discarded body", 400, "unauthorized"))
    );

    await expect(adapter.connect(CONNECT_INPUT)).rejects.toMatchObject({
      message:
        "Anthropic authorization code exchange was unauthorized (status 400, reason unauthorized)",
      classification: "unauthorized",
    });

    const timeout = new AnthropicModelProviderAccountAdapter(
      vi.fn().mockRejectedValue(new DOMException("discarded detail", "TimeoutError"))
    );
    await expect(timeout.connect(CONNECT_INPUT)).rejects.toMatchObject({
      message: "Anthropic authorization code exchange outcome was ambiguous (cause TimeoutError)",
      classification: "ambiguous",
    });
  });

  it("allows only accounts with no trusted external identity", () => {
    const adapter = new AnthropicModelProviderAccountAdapter();

    expect(() => adapter.validateReconnectInputIdentity(CONNECT_INPUT, null)).not.toThrow();
    expect(() => adapter.validateExternalIdentity(undefined, null)).not.toThrow();
    expect(() => adapter.validateReconnectInputIdentity(CONNECT_INPUT, "claimed")).toThrow(
      ProviderIdentityError
    );
    expect(() => adapter.validateExternalIdentity("claimed", null)).toThrow(ProviderIdentityError);
  });
});
