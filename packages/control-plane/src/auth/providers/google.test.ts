import { describe, expect, it, vi } from "vitest";
import { hashToken } from "../crypto";
import { base64UrlEncode } from "../encoding";
import { GoogleOidcProvider } from "./google";

const discoveryDocument = {
  issuer: "https://accounts.google.com",
  authorization_endpoint: "https://accounts.google.com/o/oauth2/v2/auth",
  token_endpoint: "https://oauth2.googleapis.com/token",
  jwks_uri: "https://www.googleapis.com/oauth2/v3/certs",
  response_types_supported: ["code"],
  subject_types_supported: ["public"],
  id_token_signing_alg_values_supported: ["RS256"],
  token_endpoint_auth_methods_supported: ["client_secret_post"],
  code_challenge_methods_supported: ["S256"],
};

const config = {
  clientId: "google-client",
  clientSecret: "google-secret",
  callbackUri: "https://cp.example.com/oauth/callback/google",
  issuer: "https://accounts.google.com",
};

async function createSignedIdToken(
  claims: Record<string, unknown>
): Promise<{ idToken: string; publicJwk: Record<string, unknown> }> {
  const keyPair = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"]
  )) as CryptoKeyPair;
  const header = base64UrlEncode(JSON.stringify({ alg: "RS256", kid: "test-key", typ: "JWT" }));
  const payload = base64UrlEncode(JSON.stringify(claims));
  const signingInput = `${header}.${payload}`;
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    keyPair.privateKey,
    new TextEncoder().encode(signingInput)
  );
  const publicJwk = (await crypto.subtle.exportKey("jwk", keyPair.publicKey)) as unknown as Record<
    string,
    unknown
  >;
  return {
    idToken: `${signingInput}.${base64UrlEncode(new Uint8Array(signature))}`,
    publicJwk: { ...publicJwk, kid: "test-key", alg: "RS256", use: "sig" },
  };
}

async function expectSignedTokenRejection(
  claims: Record<string, unknown>,
  failure = "malformed_response"
): Promise<void> {
  const { idToken, publicJwk } = await createSignedIdToken(claims);
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(Response.json(discoveryDocument))
    .mockResolvedValueOnce(
      Response.json({
        access_token: "google-access",
        token_type: "Bearer",
        id_token: idToken,
      })
    )
    .mockResolvedValueOnce(Response.json({ keys: [publicJwk] }));
  const provider = new GoogleOidcProvider(config, { fetch });

  await expect(
    provider.exchangeAuthorizationCode({
      code: "google-code",
      codeVerifier: "v".repeat(43),
      oidcNonceHash: await hashToken("nonce-value"),
    })
  ).rejects.toMatchObject({
    name: "OAuthProviderError",
    failure,
  });
}

describe("GoogleOidcProvider", () => {
  it("rejects a non-canonical Google issuer before discovery", () => {
    const fetch = vi.fn<typeof globalThis.fetch>();

    expect(
      () =>
        new GoogleOidcProvider(
          {
            ...config,
            issuer: "https://accounts.google.com.attacker.example",
          },
          { fetch }
        )
    ).toThrow(expect.objectContaining({ failure: "invalid_configuration" }));
    expect(fetch).not.toHaveBeenCalled();
  });

  it("discovers Google and creates an OIDC authorization URL with PKCE and nonce", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(Response.json(discoveryDocument));
    const provider = new GoogleOidcProvider(config, { fetch });

    const authorizationUrl = await provider.createAuthorizationUrl({
      state: "state-value",
      codeChallenge: "a".repeat(43),
      oidcNonce: "nonce-value",
    });

    expect(authorizationUrl.origin + authorizationUrl.pathname).toBe(
      "https://accounts.google.com/o/oauth2/v2/auth"
    );
    expect(Object.fromEntries(authorizationUrl.searchParams)).toEqual({
      client_id: "google-client",
      redirect_uri: "https://cp.example.com/oauth/callback/google",
      response_type: "code",
      scope: "openid email profile",
      state: "state-value",
      code_challenge: "a".repeat(43),
      code_challenge_method: "S256",
      nonce: "nonce-value",
    });
    expect(String(fetch.mock.calls[0][0])).toBe(
      "https://accounts.google.com/.well-known/openid-configuration"
    );
  });

  it("validates the signed ID token and binds its nonce through the persisted hash", async () => {
    const nowEpochSeconds = Math.floor(Date.now() / 1000);
    const nonce = "nonce-value";
    const { idToken, publicJwk } = await createSignedIdToken({
      iss: "https://accounts.google.com",
      sub: "google-subject",
      aud: "google-client",
      azp: "google-client",
      exp: nowEpochSeconds + 300,
      iat: nowEpochSeconds,
      nonce,
      email: "person@example.com",
      email_verified: true,
      name: "A Person",
      picture: "https://images.example/person",
    });
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(Response.json(discoveryDocument))
      .mockResolvedValueOnce(
        Response.json({
          access_token: "google-access",
          token_type: "Bearer",
          expires_in: 3_600,
          id_token: idToken,
        })
      )
      .mockResolvedValueOnce(Response.json({ keys: [publicJwk] }));
    const provider = new GoogleOidcProvider(config, { fetch });

    await expect(
      provider.exchangeAuthorizationCode({
        code: "google-code",
        codeVerifier: "v".repeat(43),
        oidcNonceHash: await hashToken(nonce),
      })
    ).resolves.toEqual({
      identity: {
        provider: "google",
        issuer: "https://accounts.google.com",
        subject: "google-subject",
        displayName: "A Person",
        avatarUrl: "https://images.example/person",
        verifiedEmails: ["person@example.com"],
        primaryEmail: "person@example.com",
      },
      credential: null,
    });

    expect(String(fetch.mock.calls[1][0])).toBe("https://oauth2.googleapis.com/token");
    const tokenBody = new URLSearchParams(String(fetch.mock.calls[1][1]?.body));
    expect(Object.fromEntries(tokenBody)).toEqual({
      redirect_uri: "https://cp.example.com/oauth/callback/google",
      code: "google-code",
      code_verifier: "v".repeat(43),
      grant_type: "authorization_code",
      client_id: "google-client",
      client_secret: "google-secret",
    });
    expect(String(fetch.mock.calls[2][0])).toBe("https://www.googleapis.com/oauth2/v3/certs");
  });

  it("rejects an ID token that does not verify against the discovered JWKS", async () => {
    const nowEpochSeconds = Math.floor(Date.now() / 1000);
    const { idToken, publicJwk } = await createSignedIdToken({
      iss: "https://accounts.google.com",
      sub: "google-subject",
      aud: "google-client",
      exp: nowEpochSeconds + 300,
      iat: nowEpochSeconds,
      nonce: "nonce-value",
    });
    const [header, payload, signature] = idToken.split(".");
    const forgedIdToken = `${header}.${payload}.${signature.startsWith("A") ? "B" : "A"}${signature.slice(1)}`;
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(Response.json(discoveryDocument))
      .mockResolvedValueOnce(
        Response.json({
          access_token: "google-access",
          token_type: "Bearer",
          id_token: forgedIdToken,
        })
      )
      .mockResolvedValueOnce(Response.json({ keys: [publicJwk] }));
    const provider = new GoogleOidcProvider(config, { fetch });

    await expect(
      provider.exchangeAuthorizationCode({
        code: "google-code",
        codeVerifier: "v".repeat(43),
        oidcNonceHash: await hashToken("nonce-value"),
      })
    ).rejects.toMatchObject({
      name: "OAuthProviderError",
      failure: "malformed_response",
    });
  });

  it("rejects a valid signed token whose nonce does not match the consumed flow", async () => {
    const nowEpochSeconds = Math.floor(Date.now() / 1000);
    const { idToken, publicJwk } = await createSignedIdToken({
      iss: "https://accounts.google.com",
      sub: "google-subject",
      aud: "google-client",
      exp: nowEpochSeconds + 300,
      iat: nowEpochSeconds,
      nonce: "attacker-nonce",
    });
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(Response.json(discoveryDocument))
      .mockResolvedValueOnce(
        Response.json({
          access_token: "google-access",
          token_type: "Bearer",
          id_token: idToken,
        })
      )
      .mockResolvedValueOnce(Response.json({ keys: [publicJwk] }));
    const provider = new GoogleOidcProvider(config, { fetch });

    await expect(
      provider.exchangeAuthorizationCode({
        code: "google-code",
        codeVerifier: "v".repeat(43),
        oidcNonceHash: await hashToken("expected-nonce"),
      })
    ).rejects.toMatchObject({
      name: "OAuthProviderError",
      failure: "provider_rejected",
    });
  });

  it("rejects a signed token with an unexpected authorized party", async () => {
    const nowEpochSeconds = Math.floor(Date.now() / 1000);
    await expectSignedTokenRejection({
      iss: "https://accounts.google.com",
      sub: "google-subject",
      aud: "google-client",
      azp: "another-client",
      exp: nowEpochSeconds + 300,
      iat: nowEpochSeconds,
      nonce: "nonce-value",
    });
  });

  it("rejects a signed token issued for a different audience", async () => {
    const nowEpochSeconds = Math.floor(Date.now() / 1000);
    await expectSignedTokenRejection({
      iss: "https://accounts.google.com",
      sub: "google-subject",
      aud: "another-client",
      exp: nowEpochSeconds + 300,
      iat: nowEpochSeconds,
      nonce: "nonce-value",
    });
  });

  it("rejects an expired signed token", async () => {
    const nowEpochSeconds = Math.floor(Date.now() / 1000);
    await expectSignedTokenRejection({
      iss: "https://accounts.google.com",
      sub: "google-subject",
      aud: "google-client",
      exp: nowEpochSeconds - 300,
      iat: nowEpochSeconds - 600,
      nonce: "nonce-value",
    });
  });
});
