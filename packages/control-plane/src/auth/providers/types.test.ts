import { describe, expect, it } from "vitest";
import type {
  OAuthSignInProvider,
  OAuthSignInProviderRegistry,
  ProviderAuthorizationRequest,
  ProviderCodeExchangeRequest,
} from "./types";

describe("OAuth provider contracts", () => {
  it("requires Google nonce bindings and excludes them from GitHub requests", () => {
    const googleAuthorization: ProviderAuthorizationRequest<"google"> = {
      state: "state",
      codeChallenge: "challenge",
      oidcNonce: "nonce",
    };
    const githubAuthorization: ProviderAuthorizationRequest<"github"> = {
      state: "state",
      codeChallenge: "challenge",
    };
    const googleExchange: ProviderCodeExchangeRequest<"google"> = {
      code: "code",
      codeVerifier: "verifier",
      oidcNonceHash: "nonce-hash",
    };
    const githubExchange: ProviderCodeExchangeRequest<"github"> = {
      code: "code",
      codeVerifier: "verifier",
    };

    // @ts-expect-error Google authorization requires an OIDC nonce.
    const googleWithoutNonce: ProviderAuthorizationRequest<"google"> = {
      state: "state",
      codeChallenge: "challenge",
    };
    const githubWithNonce: ProviderAuthorizationRequest<"github"> = {
      state: "state",
      codeChallenge: "challenge",
      // @ts-expect-error GitHub authorization cannot carry an OIDC nonce.
      oidcNonce: "nonce",
    };
    // @ts-expect-error Google exchange requires the persisted OIDC nonce hash.
    const googleExchangeWithoutNonce: ProviderCodeExchangeRequest<"google"> = {
      code: "code",
      codeVerifier: "verifier",
    };
    const githubExchangeWithNonce: ProviderCodeExchangeRequest<"github"> = {
      code: "code",
      codeVerifier: "verifier",
      // @ts-expect-error GitHub exchange cannot carry an OIDC nonce hash.
      oidcNonceHash: "nonce-hash",
    };

    expect(googleAuthorization.oidcNonce).toBe("nonce");
    expect(githubAuthorization).not.toHaveProperty("oidcNonce");
    expect(googleExchange.oidcNonceHash).toBe("nonce-hash");
    expect(githubExchange).not.toHaveProperty("oidcNonceHash");
    void googleWithoutNonce;
    void githubWithNonce;
    void googleExchangeWithoutNonce;
    void githubExchangeWithNonce;
  });

  it("prevents provider adapters from being registered under another provider key", () => {
    const googleProvider: OAuthSignInProvider<"google"> = {
      provider: "google",
      async createAuthorizationUrl() {
        return new URL("https://google.example/authorize");
      },
      async exchangeAuthorizationCode() {
        throw new Error("not used");
      },
    };
    const registry: OAuthSignInProviderRegistry = {
      // @ts-expect-error The GitHub key cannot hold a Google adapter.
      github: googleProvider,
      google: googleProvider,
    };

    void registry;
  });
});
