import { describe, expect, it, vi } from "vitest";
import {
  OAuthAuthorizationRequestError,
  OAuthAuthorizationService,
  StaticOAuthClientRegistry,
  WebCryptoOpaqueValueGenerator,
} from "./oauth-authorization-service";
import type { CreateOAuthFlowStateInput } from "./oauth-flow-state";
import type {
  OAuthSignInProvider,
  ProviderAuthorizationRequest,
  ProviderCodeExchangeRequest,
  ProviderCodeExchangeResult,
} from "./providers/types";
import type { SignInProvider } from "./sign-in-provider";

class FakeProvider<P extends SignInProvider> implements OAuthSignInProvider<P> {
  readonly createAuthorizationUrl = vi.fn(
    async (request: ProviderAuthorizationRequest<P>): Promise<URL> => {
      const url = new URL(`https://${this.provider}.example/authorize`);
      url.searchParams.set("state", request.state);
      return url;
    }
  );

  constructor(readonly provider: P) {}

  exchangeAuthorizationCode(
    _request: ProviderCodeExchangeRequest<P>
  ): Promise<ProviderCodeExchangeResult<P>> {
    throw new Error("not used");
  }
}

describe("OAuthAuthorizationService", () => {
  it("generates independent 32-byte base64url values for upstream secrets", () => {
    const generator = new WebCryptoOpaqueValueGenerator();

    const first = generator.generate();
    const second = generator.generate();

    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(second).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(second).not.toBe(first);
  });

  it("validates the web client and persists a GitHub flow before returning its redirect", async () => {
    const github = new FakeProvider("github");
    const google = new FakeProvider("google");
    const create = vi.fn(async (_input: CreateOAuthFlowStateInput) => ({ flowId: "flow-1" }));
    const verifier = "v".repeat(43);
    const service = new OAuthAuthorizationService({
      clients: new StaticOAuthClientRegistry(["https://web.example.com/api/auth/callback"]),
      providers: { github, google },
      flowStateStore: { create },
      opaqueValueGenerator: { generate: () => verifier },
    });

    const redirect = await service.authorize({
      responseType: "code",
      clientId: "web",
      redirectUri: "https://web.example.com/api/auth/callback",
      state: "s".repeat(43),
      codeChallenge: "c".repeat(43),
      codeChallengeMethod: "S256",
      provider: "github",
    });

    expect(redirect.toString()).toBe(`https://github.example/authorize?state=${"s".repeat(43)}`);
    expect(create).toHaveBeenCalledWith({
      state: "s".repeat(43),
      provider: "github",
      clientId: "web",
      redirectUri: "https://web.example.com/api/auth/callback",
      clientCodeChallenge: "c".repeat(43),
      providerPkceVerifier: verifier,
    });
    expect(github.createAuthorizationUrl).toHaveBeenCalledWith({
      state: "s".repeat(43),
      codeChallenge: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
    });
    expect(google.createAuthorizationUrl).not.toHaveBeenCalled();
  });

  it("rejects an unregistered redirect before provider or storage work", async () => {
    const github = new FakeProvider("github");
    const google = new FakeProvider("google");
    const create = vi.fn();
    const generate = vi.fn(() => "v".repeat(43));
    const service = new OAuthAuthorizationService({
      clients: new StaticOAuthClientRegistry(["https://web.example.com/api/auth/callback"]),
      providers: { github, google },
      flowStateStore: { create },
      opaqueValueGenerator: { generate },
    });

    const rejection = service.authorize({
      responseType: "code",
      clientId: "web",
      redirectUri: "https://attacker.example/callback",
      state: "s".repeat(43),
      codeChallenge: "c".repeat(43),
      codeChallengeMethod: "S256",
      provider: "github",
    });
    const error = await rejection.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(OAuthAuthorizationRequestError);
    expect(error).toMatchObject({
      name: "OAuthAuthorizationRequestError",
      code: "invalid_request",
    });
    expect(generate).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(github.createAuthorizationUrl).not.toHaveBeenCalled();
  });

  it.each([
    ["unsupported response type", { responseType: "token" }, "unsupported_response_type"],
    ["unknown client", { clientId: "cli" }, "invalid_client"],
    ["short state", { state: "short" }, "invalid_request"],
    ["plain PKCE", { codeChallengeMethod: "plain" }, "invalid_request"],
    ["malformed challenge", { codeChallenge: "short" }, "invalid_request"],
    ["unknown provider", { provider: "okta" }, "invalid_request"],
  ] as const)("rejects %s before generating or persisting flow state", async (_, patch, code) => {
    const github = new FakeProvider("github");
    const google = new FakeProvider("google");
    const create = vi.fn();
    const generate = vi.fn(() => "v".repeat(43));
    const service = new OAuthAuthorizationService({
      clients: new StaticOAuthClientRegistry(["https://web.example.com/api/auth/callback"]),
      providers: { github, google },
      flowStateStore: { create },
      opaqueValueGenerator: { generate },
    });

    await expect(
      service.authorize({
        responseType: "code",
        clientId: "web",
        redirectUri: "https://web.example.com/api/auth/callback",
        state: "s".repeat(43),
        codeChallenge: "c".repeat(43),
        codeChallengeMethod: "S256",
        provider: "github",
        ...patch,
      })
    ).rejects.toMatchObject({ code });
    expect(generate).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(github.createAuthorizationUrl).not.toHaveBeenCalled();
    expect(google.createAuthorizationUrl).not.toHaveBeenCalled();
  });

  it("persists the generated Google nonce for hash-only storage", async () => {
    const github = new FakeProvider("github");
    const google = new FakeProvider("google");
    const create = vi.fn(async (_input: CreateOAuthFlowStateInput) => ({ flowId: "flow-1" }));
    const verifier = "v".repeat(43);
    const nonce = "n".repeat(43);
    const generate = vi.fn<() => string>().mockReturnValueOnce(verifier).mockReturnValueOnce(nonce);
    const service = new OAuthAuthorizationService({
      clients: new StaticOAuthClientRegistry(["https://web.example.com/api/auth/callback"]),
      providers: { github, google },
      flowStateStore: { create },
      opaqueValueGenerator: { generate },
    });

    await service.authorize({
      responseType: "code",
      clientId: "web",
      redirectUri: "https://web.example.com/api/auth/callback",
      state: "s".repeat(43),
      codeChallenge: "c".repeat(43),
      codeChallengeMethod: "S256",
      provider: "google",
    });

    expect(google.createAuthorizationUrl).toHaveBeenCalledWith({
      state: "s".repeat(43),
      codeChallenge: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      oidcNonce: nonce,
    });
    expect(create).toHaveBeenCalledWith({
      state: "s".repeat(43),
      provider: "google",
      clientId: "web",
      redirectUri: "https://web.example.com/api/auth/callback",
      clientCodeChallenge: "c".repeat(43),
      providerPkceVerifier: verifier,
      oidcNonce: nonce,
    });
  });
});
