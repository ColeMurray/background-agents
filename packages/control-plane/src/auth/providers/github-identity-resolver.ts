import { z } from "zod";
import { DEFAULT_PROVIDER_REQUEST_TIMEOUT_MS } from "./constants";
import { assertCanonicalIssuer, OAuthProviderError, type VerifiedProviderIdentity } from "./types";

const GITHUB_ISSUER = "https://github.com";
const GITHUB_API_URL = "https://api.github.com";
const GITHUB_API_VERSION = "2022-11-28";
const GITHUB_EMAILS_PER_PAGE = 100;
const GITHUB_EMAILS_MAX_PAGES = 10;

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

export interface GitHubProviderIdentityResolverConfig {
  readonly issuer: string;
  readonly userAgent: string;
}

export interface GitHubProviderIdentityResolverDependencies {
  readonly fetch?: typeof globalThis.fetch;
  readonly requestTimeoutMs?: number;
}

/**
 * Resolves GitHub identity evidence from an access token exchanged and owned
 * by Better Auth. This boundary deliberately implements no OAuth protocol.
 */
export class GitHubProviderIdentityResolver {
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly requestTimeoutMs: number;

  constructor(
    private readonly config: GitHubProviderIdentityResolverConfig,
    dependencies: GitHubProviderIdentityResolverDependencies = {}
  ) {
    assertCanonicalIssuer(config.issuer, GITHUB_ISSUER);
    this.fetchImpl = dependencies.fetch ?? globalThis.fetch;
    this.requestTimeoutMs = dependencies.requestTimeoutMs ?? DEFAULT_PROVIDER_REQUEST_TIMEOUT_MS;
  }

  async resolveIdentity(accessToken: string): Promise<VerifiedProviderIdentity<"github">> {
    const [user, emailEntries] = await Promise.all([
      this.fetchGitHubUser(accessToken),
      this.fetchVerifiedEmails(accessToken),
    ]);
    const verifiedEmailEntries = emailEntries.filter((entry) => entry.verified);
    const verifiedEmails = [
      ...new Set(verifiedEmailEntries.map((entry) => entry.email.toLowerCase())),
    ];
    return {
      provider: "github",
      issuer: GITHUB_ISSUER,
      subject: String(user.id),
      login: user.login,
      displayName: user.name ?? user.login,
      ...(user.avatar_url ? { avatarUrl: user.avatar_url } : {}),
      verifiedEmails,
      primaryEmail:
        verifiedEmailEntries.find((entry) => entry.primary)?.email.toLowerCase() ?? null,
    };
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

      const response = await this.fetchWithTimeout(currentUrl, {
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
