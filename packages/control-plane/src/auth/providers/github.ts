import { z } from "zod";
import type { ProviderCredentialInput } from "../provider-credential";
import { DEFAULT_PROVIDER_REQUEST_TIMEOUT_MS } from "./constants";
import {
  assertCanonicalIssuer,
  OAuthProviderError,
  type OAuthSignInProvider,
  type ProviderAuthorizationRequest,
  type ProviderCodeExchangeRequest,
  type ProviderCodeExchangeResult,
} from "./types";

const GITHUB_AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
const GITHUB_ISSUER = "https://github.com";
const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";
const GITHUB_API_URL = "https://api.github.com";
const GITHUB_API_VERSION = "2022-11-28";
const GITHUB_EMAILS_PER_PAGE = 100;
const GITHUB_EMAILS_MAX_PAGES = 10;

const githubTokenResponseSchema = z
  .object({
    access_token: z.string().min(1),
    token_type: z.string().transform((value, ctx) => {
      if (value.toLowerCase() !== "bearer") {
        ctx.addIssue({ code: "custom", message: "token_type must be bearer" });
        return z.NEVER;
      }
      return "bearer" as const;
    }),
    expires_in: z.number().int().positive().optional(),
    refresh_token: z.string().min(1).optional(),
    refresh_token_expires_in: z.number().int().positive().optional(),
  })
  .superRefine((value, ctx) => {
    if (value.refresh_token && value.expires_in === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["expires_in"],
        message: "refreshable credentials require access expiry",
      });
    }
    if (value.refresh_token_expires_in !== undefined && !value.refresh_token) {
      ctx.addIssue({
        code: "custom",
        path: ["refresh_token_expires_in"],
        message: "refresh expiry requires a refresh token",
      });
    }
  });

const githubOAuthErrorSchema = z.object({
  error: z.string().min(1),
  error_description: z.string().optional(),
});

const githubUserSchema = z.object({
  id: z.number().int().positive(),
  login: z.string().min(1),
  name: z.string().nullable().optional(),
  avatar_url: z.url().nullable().optional(),
});

const githubEmailSchema = z.object({
  email: z.email(),
  primary: z.boolean(),
  verified: z.boolean(),
  visibility: z.string().nullable(),
});

const githubEmailPageSchema = z.array(githubEmailSchema);

export interface GitHubOAuthProviderConfig {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly callbackUri: string;
  readonly issuer: string;
  readonly userAgent: string;
}

export interface GitHubOAuthProviderDependencies {
  readonly fetch?: typeof globalThis.fetch;
  readonly clock?: { now(): number };
  readonly requestTimeoutMs?: number;
}

export class GitHubOAuthProvider implements OAuthSignInProvider<"github"> {
  readonly provider = "github" as const;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly clock: { now(): number };
  private readonly requestTimeoutMs: number;

  constructor(
    private readonly config: GitHubOAuthProviderConfig,
    dependencies: GitHubOAuthProviderDependencies = {}
  ) {
    assertCanonicalIssuer(config.issuer, GITHUB_ISSUER);
    this.fetchImpl = dependencies.fetch ?? globalThis.fetch;
    this.clock = dependencies.clock ?? { now: () => Date.now() };
    this.requestTimeoutMs = dependencies.requestTimeoutMs ?? DEFAULT_PROVIDER_REQUEST_TIMEOUT_MS;
  }

  async createAuthorizationUrl(request: ProviderAuthorizationRequest<"github">): Promise<URL> {
    const url = new URL(GITHUB_AUTHORIZE_URL);
    url.searchParams.set("client_id", this.config.clientId);
    url.searchParams.set("redirect_uri", this.config.callbackUri);
    url.searchParams.set("state", request.state);
    url.searchParams.set("code_challenge", request.codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
    return url;
  }

  async exchangeAuthorizationCode(
    request: ProviderCodeExchangeRequest<"github">
  ): Promise<ProviderCodeExchangeResult<"github">> {
    const token = await this.exchangeCode(request);
    const [user, emailEntries] = await Promise.all([
      this.fetchGitHubUser(token.access_token),
      this.fetchVerifiedEmails(token.access_token),
    ]);
    const verifiedEmailEntries = emailEntries.filter((entry) => entry.verified);
    const verifiedEmails = [
      ...new Set(verifiedEmailEntries.map((entry) => entry.email.toLowerCase())),
    ];
    return {
      identity: {
        provider: this.provider,
        issuer: GITHUB_ISSUER,
        subject: String(user.id),
        login: user.login,
        displayName: user.name ?? user.login,
        ...(user.avatar_url ? { avatarUrl: user.avatar_url } : {}),
        verifiedEmails,
        primaryEmail:
          verifiedEmailEntries.find((entry) => entry.primary)?.email.toLowerCase() ?? null,
      },
      credential: this.toCredential(token),
    };
  }

  private async exchangeCode(
    request: ProviderCodeExchangeRequest<"github">
  ): Promise<z.infer<typeof githubTokenResponseSchema>> {
    const body = new URLSearchParams({
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      code: request.code,
      redirect_uri: this.config.callbackUri,
      code_verifier: request.codeVerifier,
    });
    const response = await this.fetchWithTimeout(GITHUB_TOKEN_URL, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
    });
    const raw = await this.parseJson(response, "GitHub token");
    const providerError = githubOAuthErrorSchema.safeParse(raw);
    if (!response.ok || providerError.success) {
      throw new OAuthProviderError("provider_rejected", "GitHub rejected the authorization code");
    }
    const parsed = githubTokenResponseSchema.safeParse(raw);
    if (!parsed.success) {
      throw new OAuthProviderError("malformed_response", "GitHub returned an invalid token");
    }
    return parsed.data;
  }

  private async fetchGitHubUser(accessToken: string): Promise<z.infer<typeof githubUserSchema>> {
    const response = await this.fetchWithTimeout(`${GITHUB_API_URL}/user`, {
      headers: this.apiHeaders(accessToken),
    });
    if (!response.ok) {
      throw new OAuthProviderError("provider_unavailable", "GitHub user lookup was not successful");
    }
    const parsed = githubUserSchema.safeParse(await this.parseJson(response, "GitHub user"));
    if (!parsed.success) {
      throw new OAuthProviderError("malformed_response", "GitHub returned an invalid user");
    }
    return parsed.data;
  }

  private async fetchVerifiedEmails(
    accessToken: string
  ): Promise<Array<z.infer<typeof githubEmailSchema>>> {
    let nextUrl: URL | null = new URL(`${GITHUB_API_URL}/user/emails`);
    nextUrl.searchParams.set("per_page", String(GITHUB_EMAILS_PER_PAGE));
    nextUrl.searchParams.set("page", "1");
    const seenUrls = new Set<string>();
    const entries: Array<z.infer<typeof githubEmailSchema>> = [];

    for (let page = 1; nextUrl !== null && page <= GITHUB_EMAILS_MAX_PAGES; page += 1) {
      const currentUrl: URL = nextUrl;
      const serializedUrl = currentUrl.toString();
      if (seenUrls.has(serializedUrl)) {
        throw new OAuthProviderError(
          "malformed_response",
          "GitHub repeated an email pagination page"
        );
      }
      seenUrls.add(serializedUrl);

      const response: Response = await this.fetchWithTimeout(currentUrl, {
        headers: this.apiHeaders(accessToken),
      });
      if (!response.ok) {
        throw new OAuthProviderError(
          "provider_unavailable",
          "GitHub email lookup was not successful"
        );
      }
      const parsed = githubEmailPageSchema.safeParse(
        await this.parseJson(response, "GitHub emails")
      );
      if (!parsed.success) {
        throw new OAuthProviderError("malformed_response", "GitHub returned invalid emails");
      }
      entries.push(...parsed.data);

      nextUrl = this.parseEmailNextPage(response.headers.get("Link"));
      if (nextUrl !== null && page === GITHUB_EMAILS_MAX_PAGES) {
        throw new OAuthProviderError(
          "malformed_response",
          "GitHub email pagination exceeded its limit"
        );
      }
    }
    return entries;
  }

  private parseEmailNextPage(linkHeader: string | null): URL | null {
    if (!linkHeader) return null;
    const links = linkHeader
      .split(",")
      .map((value) => value.trim().match(/^<([^>]+)>;\s*rel="([^"]+)"$/));
    if (links.some((match) => match === null)) {
      throw new OAuthProviderError(
        "malformed_response",
        "GitHub returned malformed email pagination"
      );
    }
    const nextLinks = links
      .filter((match): match is RegExpMatchArray => match !== null)
      .filter((match) => match[2].split(/\s+/).includes("next"));
    if (nextLinks.length === 0) return null;
    if (nextLinks.length !== 1) {
      throw new OAuthProviderError(
        "malformed_response",
        "GitHub returned ambiguous email pagination"
      );
    }

    let url: URL;
    try {
      url = new URL(nextLinks[0][1]);
    } catch {
      throw new OAuthProviderError(
        "malformed_response",
        "GitHub returned invalid email pagination"
      );
    }
    if (
      url.origin !== GITHUB_API_URL ||
      url.pathname !== "/user/emails" ||
      url.searchParams.get("per_page") !== String(GITHUB_EMAILS_PER_PAGE) ||
      !/^[1-9]\d*$/.test(url.searchParams.get("page") ?? "")
    ) {
      throw new OAuthProviderError(
        "malformed_response",
        "GitHub returned invalid email pagination"
      );
    }
    return url;
  }

  private apiHeaders(accessToken: string): HeadersInit {
    return {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": GITHUB_API_VERSION,
      "User-Agent": this.config.userAgent,
    };
  }

  private toCredential(token: z.infer<typeof githubTokenResponseSchema>): ProviderCredentialInput {
    const now = this.clock.now();
    if (token.refresh_token && token.expires_in !== undefined) {
      return {
        kind: "refreshable",
        accessToken: token.access_token,
        accessExpiresAt: now + token.expires_in * 1000,
        refreshToken: token.refresh_token,
        refreshExpiresAt:
          token.refresh_token_expires_in === undefined
            ? null
            : now + token.refresh_token_expires_in * 1000,
      };
    }
    if (token.expires_in !== undefined) {
      return {
        kind: "access_only_expiring",
        accessToken: token.access_token,
        accessExpiresAt: now + token.expires_in * 1000,
      };
    }
    return { kind: "access_only_nonexpiring", accessToken: token.access_token };
  }

  private async parseJson(response: Response, context: string): Promise<unknown> {
    try {
      return await response.json();
    } catch {
      throw new OAuthProviderError("malformed_response", `${context} response was not JSON`);
    }
  }

  private async fetchWithTimeout(input: RequestInfo | URL, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    try {
      return await this.fetchImpl(input, { ...init, signal: controller.signal });
    } catch {
      throw new OAuthProviderError("provider_unavailable", "GitHub request failed");
    } finally {
      clearTimeout(timeout);
    }
  }
}
