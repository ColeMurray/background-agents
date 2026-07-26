import { describe, expect, it, vi } from "vitest";
import { AdmissionDeniedError, AdmissionUnavailableError } from "./admission-policy";
import { AccountLinkRequiredError } from "./browser-sign-in-identity";
import { createOAuthProviderCallbackHandlers } from "./oauth-provider-callback-handler";
import { OAuthProviderCallbackService } from "./oauth-provider-callback-service";
import type { OAuthFlowStateReader } from "./oauth-flow-state";
import { OAuthProviderError, type OAuthSignInProviderRegistry } from "./providers/types";

const STATE = "s".repeat(43);
const CLIENT_CHALLENGE = "c".repeat(43);
const PROVIDER_VERIFIER = "v".repeat(43);

function providerRegistry(): OAuthSignInProviderRegistry {
  return {
    github: {
      provider: "github",
      createAuthorizationUrl: vi.fn(),
      exchangeAuthorizationCode: vi.fn(async () => ({
        identity: {
          provider: "github" as const,
          issuer: "https://github.com",
          subject: "github-subject",
          login: "octocat",
          verifiedEmails: ["person@example.com"],
          primaryEmail: "person@example.com",
        },
        credential: {
          kind: "access_only_nonexpiring" as const,
          accessToken: "ghu_token",
        },
      })),
    },
    google: {
      provider: "google",
      createAuthorizationUrl: vi.fn(),
      exchangeAuthorizationCode: vi.fn(),
    },
  };
}

describe("OAuthProviderCallbackService", () => {
  it("delegates provider callback mechanics to the selected handler", async () => {
    const exchange = vi.fn(async () => ({
      identity: {
        provider: "google" as const,
        issuer: "https://accounts.google.com",
        subject: "google-subject",
        verifiedEmails: ["person@example.com"],
        primaryEmail: "person@example.com",
      },
      credential: null,
    }));
    const consume = vi.fn(async () => ({
      flow: {
        flowId: "flow-1",
        provider: "google" as const,
        clientId: "web" as const,
        redirectUri: "https://web.example/api/auth/callback",
        clientCodeChallenge: CLIENT_CHALLENGE,
        providerPkceVerifier: PROVIDER_VERIFIER,
        oidcNonceHash: "f".repeat(64),
      },
      exchange,
    }));
    const service = new OAuthProviderCallbackService({
      clients: { accepts: vi.fn(() => true) },
      providerHandlers: {
        github: { consume: vi.fn() },
        google: { consume },
      },
      admissionPolicy: { requireAdmission: vi.fn() },
      identityResolver: {
        resolve: vi.fn(async () => ({
          userId: "user-1",
          providerIdentityId: "identity-1",
          isNewUser: true,
          collisionCount: 0,
        })),
      },
      authorizationCodeStore: {
        issue: vi.fn(async () => ({
          code: `oi_code_${"a".repeat(43)}`,
          expiresAt: 1_800_000_060_000,
        })),
      },
    });

    await service.completeAuthorization("google", { state: STATE, code: "google-code" });

    expect(consume).toHaveBeenCalledWith(STATE);
    expect(exchange).toHaveBeenCalledWith("google-code");
  });

  it("rejects a missing provider code before consuming transaction state", async () => {
    const consumeFlow = vi.fn();
    const providers = providerRegistry();
    const flowStateStore = {
      consume: consumeFlow,
    } as unknown as OAuthFlowStateReader;
    const service = new OAuthProviderCallbackService({
      clients: { accepts: vi.fn(() => true) },
      providerHandlers: createOAuthProviderCallbackHandlers({ providers, flowStateStore }),
      admissionPolicy: { requireAdmission: vi.fn() },
      identityResolver: { resolve: vi.fn() },
      authorizationCodeStore: { issue: vi.fn() },
    });

    await expect(
      service.completeAuthorization("github", { state: STATE, code: "" })
    ).rejects.toEqual(expect.objectContaining({ name: "OAuthProviderCallbackRequestError" }));
    expect(consumeFlow).not.toHaveBeenCalled();
  });

  it("rejects an oversized provider code before consuming transaction state", async () => {
    const consumeFlow = vi.fn();
    const providers = providerRegistry();
    const flowStateStore = {
      consume: consumeFlow,
    } as unknown as OAuthFlowStateReader;
    const service = new OAuthProviderCallbackService({
      clients: { accepts: vi.fn(() => true) },
      providerHandlers: createOAuthProviderCallbackHandlers({ providers, flowStateStore }),
      admissionPolicy: { requireAdmission: vi.fn() },
      identityResolver: { resolve: vi.fn() },
      authorizationCodeStore: { issue: vi.fn() },
    });

    await expect(
      service.completeAuthorization("github", { state: STATE, code: "x".repeat(4_097) })
    ).rejects.toEqual(expect.objectContaining({ name: "OAuthProviderCallbackRequestError" }));
    expect(consumeFlow).not.toHaveBeenCalled();
  });

  it("turns a verified provider callback into a client-bound authorization code", async () => {
    const providers = providerRegistry();
    const consumeFlow = vi.fn(async () => ({
      flowId: "flow-1",
      provider: "github" as const,
      clientId: "web" as const,
      redirectUri: "https://web.example/api/auth/callback",
      clientCodeChallenge: CLIENT_CHALLENGE,
      providerPkceVerifier: PROVIDER_VERIFIER,
      oidcNonceHash: null,
    }));
    const flowStateStore = {
      consume: consumeFlow,
    } as unknown as OAuthFlowStateReader;
    const admissionPolicy = {
      requireAdmission: vi.fn(async () => ({ reason: "email_allowlist" as const })),
    };
    const identityResolver = {
      resolve: vi.fn(async () => ({
        userId: "user-1",
        providerIdentityId: "identity-1",
        isNewUser: true,
        collisionCount: 0,
      })),
    };
    const authorizationCodeStore = {
      issue: vi.fn(async () => ({
        code: `oi_code_${"a".repeat(43)}`,
        expiresAt: 1_800_000_060_000,
      })),
    };
    const service = new OAuthProviderCallbackService({
      clients: { accepts: vi.fn(() => true) },
      providerHandlers: createOAuthProviderCallbackHandlers({ providers, flowStateStore }),
      admissionPolicy,
      identityResolver,
      authorizationCodeStore,
    });

    await expect(
      service.completeAuthorization("github", {
        state: STATE,
        code: "github-code",
      })
    ).resolves.toEqual(
      new URL(`https://web.example/api/auth/callback?code=oi_code_${"a".repeat(43)}&state=${STATE}`)
    );
    expect(providers.github.exchangeAuthorizationCode).toHaveBeenCalledWith({
      code: "github-code",
      codeVerifier: PROVIDER_VERIFIER,
    });
    expect(admissionPolicy.requireAdmission).toHaveBeenCalledWith(
      expect.objectContaining({
        identity: expect.objectContaining({ subject: "github-subject" }),
      })
    );
    expect(identityResolver.resolve).toHaveBeenCalledWith({
      identity: expect.objectContaining({
        provider: "github",
        issuer: "https://github.com",
        subject: "github-subject",
      }),
      credential: expect.objectContaining({ accessToken: "ghu_token" }),
    });
    expect(authorizationCodeStore.issue).toHaveBeenCalledWith({
      userId: "user-1",
      providerIdentityId: "identity-1",
      clientId: "web",
      redirectUri: "https://web.example/api/auth/callback",
      codeChallenge: CLIENT_CHALLENGE,
    });
  });

  it("consumes provider-denied state and returns only a bounded client error", async () => {
    const providers = providerRegistry();
    const consumeFlow = vi.fn(async () => ({
      flowId: "flow-1",
      provider: "github" as const,
      clientId: "web" as const,
      redirectUri: "https://web.example/api/auth/callback",
      clientCodeChallenge: CLIENT_CHALLENGE,
      providerPkceVerifier: PROVIDER_VERIFIER,
      oidcNonceHash: null,
    }));
    const flowStateStore = {
      consume: consumeFlow,
    } as unknown as OAuthFlowStateReader;
    const service = new OAuthProviderCallbackService({
      clients: { accepts: vi.fn(() => true) },
      providerHandlers: createOAuthProviderCallbackHandlers({ providers, flowStateStore }),
      admissionPolicy: { requireAdmission: vi.fn() },
      identityResolver: { resolve: vi.fn() },
      authorizationCodeStore: { issue: vi.fn() },
    });

    await expect(service.completeDenial("github", STATE)).resolves.toEqual(
      new URL(`https://web.example/api/auth/callback?error=access_denied&state=${STATE}`)
    );
    expect(consumeFlow).toHaveBeenCalledWith(STATE, "github");
    expect(providers.github.exchangeAuthorizationCode).not.toHaveBeenCalled();
  });

  it("maps an identity collision to a bounded client callback failure", async () => {
    const consumeFlow = vi.fn(async () => ({
      flowId: "flow-1",
      provider: "github" as const,
      clientId: "web" as const,
      redirectUri: "https://web.example/api/auth/callback",
      clientCodeChallenge: CLIENT_CHALLENGE,
      providerPkceVerifier: PROVIDER_VERIFIER,
      oidcNonceHash: null,
    }));
    const providers = providerRegistry();
    const flowStateStore = {
      consume: consumeFlow,
    } as unknown as OAuthFlowStateReader;
    const service = new OAuthProviderCallbackService({
      clients: { accepts: vi.fn(() => true) },
      providerHandlers: createOAuthProviderCallbackHandlers({ providers, flowStateStore }),
      admissionPolicy: {
        requireAdmission: vi.fn(async () => ({ reason: "email_allowlist" })),
      },
      identityResolver: {
        resolve: vi.fn(async () => {
          throw new AccountLinkRequiredError(1);
        }),
      },
      authorizationCodeStore: { issue: vi.fn() },
    });

    let rejection: unknown;
    try {
      await service.completeAuthorization("github", {
        state: STATE,
        code: "github-code",
      });
    } catch (error) {
      rejection = error;
    }

    expect(rejection).toEqual(
      expect.objectContaining({
        name: "OAuthProviderCallbackError",
        failure: "account_link_required",
        redirectUri: "https://web.example/api/auth/callback",
      })
    );
    expect(rejection).not.toHaveProperty("state");
    expect(rejection).not.toHaveProperty("cause");
  });

  it("rejects a consumed flow whose client redirect binding is no longer registered", async () => {
    const providers = providerRegistry();
    const flowStateStore = {
      consume: vi.fn(async () => ({
        flowId: "flow-1",
        provider: "github" as const,
        clientId: "web" as const,
        redirectUri: "https://attacker.example/callback",
        clientCodeChallenge: CLIENT_CHALLENGE,
        providerPkceVerifier: PROVIDER_VERIFIER,
        oidcNonceHash: null,
      })),
    } as unknown as OAuthFlowStateReader;
    const service = new OAuthProviderCallbackService({
      clients: { accepts: vi.fn(() => false) },
      providerHandlers: createOAuthProviderCallbackHandlers({ providers, flowStateStore }),
      admissionPolicy: { requireAdmission: vi.fn() },
      identityResolver: { resolve: vi.fn() },
      authorizationCodeStore: { issue: vi.fn() },
    });

    await expect(
      service.completeAuthorization("github", {
        state: STATE,
        code: "github-code",
      })
    ).rejects.toEqual(expect.objectContaining({ name: "OAuthProviderCallbackBindingError" }));
    expect(providers.github.exchangeAuthorizationCode).not.toHaveBeenCalled();
  });

  it("carries the consumed Google nonce binding through verification without storing credentials", async () => {
    const providers = providerRegistry();
    vi.mocked(providers.google.exchangeAuthorizationCode).mockResolvedValue({
      identity: {
        provider: "google",
        issuer: "https://accounts.google.com",
        subject: "google-subject",
        verifiedEmails: ["person@example.com"],
        primaryEmail: "person@example.com",
      },
      credential: null,
    });
    const identityResolver = {
      resolve: vi.fn(async () => ({
        userId: "user-1",
        providerIdentityId: "identity-1",
        isNewUser: true,
        collisionCount: 0,
      })),
    };
    const flowStateStore = {
      consume: vi.fn(async () => ({
        flowId: "flow-1",
        provider: "google" as const,
        clientId: "web" as const,
        redirectUri: "https://web.example/api/auth/callback",
        clientCodeChallenge: CLIENT_CHALLENGE,
        providerPkceVerifier: PROVIDER_VERIFIER,
        oidcNonceHash: "f".repeat(64),
      })),
    } as unknown as OAuthFlowStateReader;
    const service = new OAuthProviderCallbackService({
      clients: { accepts: vi.fn(() => true) },
      providerHandlers: createOAuthProviderCallbackHandlers({ providers, flowStateStore }),
      admissionPolicy: {
        requireAdmission: vi.fn(async () => ({ reason: "email_allowlist" })),
      },
      identityResolver,
      authorizationCodeStore: {
        issue: vi.fn(async () => ({
          code: `oi_code_${"a".repeat(43)}`,
          expiresAt: 1_800_000_060_000,
        })),
      },
    });

    await service.completeAuthorization("google", {
      state: STATE,
      code: "google-code",
    });

    expect(providers.google.exchangeAuthorizationCode).toHaveBeenCalledWith({
      code: "google-code",
      codeVerifier: PROVIDER_VERIFIER,
      oidcNonceHash: "f".repeat(64),
    });
    expect(identityResolver.resolve).toHaveBeenCalledWith({
      identity: expect.objectContaining({
        provider: "google",
        subject: "google-subject",
      }),
      credential: null,
    });
  });

  it.each([
    [new AdmissionDeniedError(), "access_denied"],
    [new AdmissionUnavailableError(), "temporarily_unavailable"],
    [
      new OAuthProviderError("provider_unavailable", "provider unavailable"),
      "temporarily_unavailable",
    ],
    [new Error("unexpected internal detail"), "server_error"],
  ] as const)(
    "maps callback failures to the bounded OAuth error taxonomy",
    async (cause, failure) => {
      const providers = providerRegistry();
      if (cause instanceof OAuthProviderError) {
        vi.mocked(providers.github.exchangeAuthorizationCode).mockRejectedValue(cause);
      }
      const flowStateStore = {
        consume: vi.fn(async () => ({
          flowId: "flow-1",
          provider: "github" as const,
          clientId: "web" as const,
          redirectUri: "https://web.example/api/auth/callback",
          clientCodeChallenge: CLIENT_CHALLENGE,
          providerPkceVerifier: PROVIDER_VERIFIER,
          oidcNonceHash: null,
        })),
      } as unknown as OAuthFlowStateReader;
      const service = new OAuthProviderCallbackService({
        clients: { accepts: vi.fn(() => true) },
        providerHandlers: createOAuthProviderCallbackHandlers({ providers, flowStateStore }),
        admissionPolicy: {
          requireAdmission: vi.fn(async () => {
            if (!(cause instanceof OAuthProviderError)) throw cause;
          }),
        },
        identityResolver: { resolve: vi.fn() },
        authorizationCodeStore: { issue: vi.fn() },
      });

      await expect(
        service.completeAuthorization("github", {
          state: STATE,
          code: "github-code",
        })
      ).rejects.toEqual(
        expect.objectContaining({
          name: "OAuthProviderCallbackError",
          message: "OAuth provider callback could not be completed",
          failure,
        })
      );
    }
  );
});
