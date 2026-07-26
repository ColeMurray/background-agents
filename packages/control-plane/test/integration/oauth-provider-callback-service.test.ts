import { beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { AdmissionPolicy } from "../../src/auth/admission-policy";
import { hashToken } from "../../src/auth/crypto";
import { BrowserSignInIdentityResolver } from "../../src/auth/browser-sign-in-identity";
import { StaticOAuthClientRegistry } from "../../src/auth/oauth-authorization-service";
import { createOAuthProviderCallbackHandlers } from "../../src/auth/oauth-provider-callback-handler";
import { OAuthProviderCallbackService } from "../../src/auth/oauth-provider-callback-service";
import { createPkceS256Challenge } from "../../src/auth/pkce";
import type {
  OAuthFlowVerifierBinding,
  OAuthFlowVerifierCipher,
} from "../../src/auth/oauth-flow-verifier";
import type {
  ProviderCredentialCipherBinding,
  ProviderCredentialCipherPort,
} from "../../src/auth/provider-credential-cipher";
import type { OAuthSignInProviderRegistry } from "../../src/auth/providers/types";
import { BrowserAuthSessionStore } from "../../src/db/browser-auth-sessions";
import { BrowserSignInIdentityStore } from "../../src/db/browser-sign-in-identities";
import { OAuthAuthorizationCodeStore } from "../../src/db/oauth-authorization-codes";
import { OAuthFlowStateStore } from "../../src/db/oauth-flow-state";
import { ProviderCredentialStore } from "../../src/db/provider-credentials";
import { cleanD1Tables } from "./cleanup";

const NOW_MS = 1_800_000_000_000;
const STATE = "s".repeat(43);
const CLIENT_VERIFIER = "c".repeat(43);
const PROVIDER_VERIFIER = "p".repeat(43);
const REDIRECT_URI = "https://web.example/api/auth/callback";

function testCipher<TBinding>(): {
  encrypt(plaintext: string, binding: TBinding): Promise<string>;
  decrypt(ciphertext: string, binding: TBinding): Promise<string>;
} {
  return {
    encrypt: async (plaintext, binding) => btoa(JSON.stringify({ plaintext, binding })),
    decrypt: async (ciphertext, binding) => {
      const parsed = JSON.parse(atob(ciphertext)) as {
        plaintext: string;
        binding: TBinding;
      };
      expect(parsed.binding).toEqual(binding);
      return parsed.plaintext;
    },
  };
}

describe("OAuth provider callback transaction", () => {
  beforeEach(cleanD1Tables);

  it("persists the exact identity and credential redeemed into the browser session", async () => {
    const clock = { now: () => NOW_MS };
    const flowStore = new OAuthFlowStateStore(
      env.DB,
      testCipher<OAuthFlowVerifierBinding>() satisfies OAuthFlowVerifierCipher,
      {
        clock,
        idGenerator: { generate: () => "flow-1" },
        tokenHasher: { hash: hashToken },
      }
    );
    const providerCredentialStore = new ProviderCredentialStore(
      env.DB,
      testCipher<ProviderCredentialCipherBinding>() satisfies ProviderCredentialCipherPort,
      clock
    );
    const identityIds = ["user-1", "identity-1"];
    const identityResolver = new BrowserSignInIdentityResolver({
      clock,
      idGenerator: {
        generate: () => identityIds.shift() ?? "unexpected-identity-id",
      },
      store: new BrowserSignInIdentityStore(env.DB, providerCredentialStore),
    });
    const authorizationCodeIds = ["authorization-code-1", "browser-session-1"];
    const authorizationCodeStore = new OAuthAuthorizationCodeStore(env.DB, {
      clock,
      tokenHasher: { hash: hashToken },
      authorizationCodeGenerator: {
        generate: () => `oi_code_${"a".repeat(43)}`,
      },
      browserCredentialGenerator: {
        generate: () => `oi_bsess_${"b".repeat(43)}`,
      },
      idGenerator: {
        generate: () => authorizationCodeIds.shift() ?? "unexpected-authorization-code-id",
      },
    });
    const providers = {
      github: {
        provider: "github" as const,
        createAuthorizationUrl: async () => new URL("https://github.com/login/oauth/authorize"),
        exchangeAuthorizationCode: async () => ({
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
        }),
      },
      google: {
        provider: "google" as const,
        createAuthorizationUrl: async () => new URL("https://accounts.google.com/o/oauth2/v2/auth"),
        exchangeAuthorizationCode: async () => {
          throw new Error("Google provider was not selected");
        },
      },
    } satisfies OAuthSignInProviderRegistry;
    const callbackService = new OAuthProviderCallbackService({
      clients: new StaticOAuthClientRegistry([REDIRECT_URI]),
      providerHandlers: createOAuthProviderCallbackHandlers({
        providers,
        flowStateStore: flowStore,
      }),
      admissionPolicy: new AdmissionPolicy({
        allowedGitHubUsers: [],
        allowedEmails: ["person@example.com"],
        allowedEmailDomains: [],
        allowedGitHubOrganizations: [],
        unsafeAllowAllUsers: false,
      }),
      identityResolver,
      authorizationCodeStore,
    });

    await flowStore.create({
      state: STATE,
      provider: "github",
      clientId: "web",
      redirectUri: REDIRECT_URI,
      clientCodeChallenge: await createPkceS256Challenge(CLIENT_VERIFIER),
      providerPkceVerifier: PROVIDER_VERIFIER,
    });
    const redirect = await callbackService.completeAuthorization("github", {
      state: STATE,
      code: "provider-code",
    });
    const code = redirect.searchParams.get("code");
    if (code === null) throw new Error("Callback did not return an authorization code");

    const browserSession = await authorizationCodeStore.redeem({
      code,
      clientId: "web",
      redirectUri: REDIRECT_URI,
      codeVerifier: CLIENT_VERIFIER,
    });
    const authenticated = await new BrowserAuthSessionStore(env.DB, {
      clock,
      credentialGenerator: { generate: () => "unused" },
      idGenerator: { generate: () => "unused" },
      tokenHasher: { hash: hashToken },
    }).authenticate(browserSession.credential);

    expect(authenticated).toMatchObject({
      userId: "user-1",
      providerIdentityId: "identity-1",
    });
    await expect(providerCredentialStore.get("identity-1")).resolves.toMatchObject({
      kind: "access_only_nonexpiring",
      accessToken: "ghu_token",
      rowVersion: 1,
    });
  });
});
