import { describe, expect, it, vi } from "vitest";
import type { OAuthFlowStateReader } from "./oauth-flow-state";
import { createOAuthProviderCallbackHandlers } from "./oauth-provider-callback-handler";
import type { OAuthSignInProviderRegistry } from "./providers/types";

const STATE = "s".repeat(43);
const PROVIDER_VERIFIER = "v".repeat(43);

describe("createOAuthProviderCallbackHandlers", () => {
  it("keeps GitHub callback mechanics behind the selected provider handler", async () => {
    const consume = vi.fn(async () => ({
      flowId: "flow-github",
      provider: "github" as const,
      clientId: "web" as const,
      redirectUri: "https://web.example/api/auth/callback",
      clientCodeChallenge: "c".repeat(43),
      providerPkceVerifier: PROVIDER_VERIFIER,
      oidcNonceHash: null,
    }));
    const exchangeAuthorizationCode = vi.fn(async () => ({
      identity: {
        provider: "github" as const,
        issuer: "https://github.com",
        subject: "github-subject",
        verifiedEmails: ["person@example.com"],
        primaryEmail: "person@example.com",
      },
      credential: {
        kind: "access_only_nonexpiring" as const,
        accessToken: "ghu_access",
      },
    }));
    const providers = {
      github: {
        provider: "github" as const,
        createAuthorizationUrl: vi.fn(),
        exchangeAuthorizationCode,
      },
      google: {
        provider: "google" as const,
        createAuthorizationUrl: vi.fn(),
        exchangeAuthorizationCode: vi.fn(),
      },
    } satisfies OAuthSignInProviderRegistry;

    const handlers = createOAuthProviderCallbackHandlers({
      flowStateStore: { consume } as unknown as OAuthFlowStateReader,
      providers,
    });
    const callback = await handlers.github.consume(STATE);

    expect(consume).toHaveBeenCalledWith(STATE, "github");
    await expect(callback.exchange("provider-code")).resolves.toMatchObject({
      identity: { provider: "github", subject: "github-subject" },
      credential: { accessToken: "ghu_access" },
    });
    expect(exchangeAuthorizationCode).toHaveBeenCalledWith({
      code: "provider-code",
      codeVerifier: PROVIDER_VERIFIER,
    });
  });

  it("keeps Google callback mechanics behind the selected provider handler", async () => {
    const consume = vi.fn(async () => ({
      flowId: "flow-google",
      provider: "google" as const,
      clientId: "web" as const,
      redirectUri: "https://web.example/api/auth/callback",
      clientCodeChallenge: "c".repeat(43),
      providerPkceVerifier: PROVIDER_VERIFIER,
      oidcNonceHash: "f".repeat(64),
    }));
    const exchangeAuthorizationCode = vi.fn(async () => ({
      identity: {
        provider: "google" as const,
        issuer: "https://accounts.google.com",
        subject: "google-subject",
        verifiedEmails: ["person@example.com"],
        primaryEmail: "person@example.com",
      },
      credential: null,
    }));
    const providers = {
      github: {
        provider: "github" as const,
        createAuthorizationUrl: vi.fn(),
        exchangeAuthorizationCode: vi.fn(),
      },
      google: {
        provider: "google" as const,
        createAuthorizationUrl: vi.fn(),
        exchangeAuthorizationCode,
      },
    } satisfies OAuthSignInProviderRegistry;

    const handlers = createOAuthProviderCallbackHandlers({
      flowStateStore: { consume } as unknown as OAuthFlowStateReader,
      providers,
    });
    const callback = await handlers.google.consume(STATE);

    expect(consume).toHaveBeenCalledWith(STATE, "google");
    await expect(callback.exchange("provider-code")).resolves.toMatchObject({
      identity: { provider: "google", subject: "google-subject" },
      credential: null,
    });
    expect(exchangeAuthorizationCode).toHaveBeenCalledWith({
      code: "provider-code",
      codeVerifier: PROVIDER_VERIFIER,
      oidcNonceHash: "f".repeat(64),
    });
  });
});
