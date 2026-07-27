import { z } from "zod";
import { createLogger, type Logger } from "../../../logger";
import { DEFAULT_PROVIDER_REQUEST_TIMEOUT_MS } from "./constants";
import { assertCanonicalIssuer, OAuthProviderError, type VerifiedProviderIdentity } from "./types";

const GITHUB_ISSUER = "https://github.com";
const GITHUB_API_URL = "https://api.github.com";
const GITHUB_API_VERSION = "2022-11-28";
const GITHUB_EMAILS_PER_PAGE = 100;
const GITHUB_EMAILS_MAX_PAGES = 10;
const GITHUB_NETWORK_REQUEST_ATTEMPTS = 2;

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
  readonly logger?: Pick<Logger, "error">;
}

/**
 * Resolves GitHub identity evidence from an access token exchanged and owned
 * by Better Auth. This boundary deliberately implements no OAuth protocol.
 */
export class GitHubProviderIdentityResolver {
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly requestTimeoutMs: number;
  private readonly logger: Pick<Logger, "error">;

  constructor(
    private readonly config: GitHubProviderIdentityResolverConfig,
    dependencies: GitHubProviderIdentityResolverDependencies = {}
  ) {
    assertCanonicalIssuer(config.issuer, GITHUB_ISSUER);
    this.fetchImpl = dependencies.fetch ?? globalThis.fetch.bind(globalThis);
    this.requestTimeoutMs = dependencies.requestTimeoutMs ?? DEFAULT_PROVIDER_REQUEST_TIMEOUT_MS;
    this.logger = dependencies.logger ?? createLogger("github-provider-identity");
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
    const entries: Array<z.infer<typeof githubEmailSchema>> = [];

    for (let page = 1; page <= GITHUB_EMAILS_MAX_PAGES; page += 1) {
      const pageUrl = new URL(`${GITHUB_API_URL}/user/emails`);
      pageUrl.searchParams.set("per_page", String(GITHUB_EMAILS_PER_PAGE));
      pageUrl.searchParams.set("page", String(page));

      const response = await this.fetchWithTimeout(pageUrl, {
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

      const hasNextPage = response.headers.get("Link")?.includes('rel="next"') ?? false;
      if (!hasNextPage) {
        return entries;
      }
    }
    throw new OAuthProviderError(
      "malformed_response",
      "GitHub email pagination exceeded its limit"
    );
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
    let lastCause: unknown;
    for (let attempt = 1; attempt <= GITHUB_NETWORK_REQUEST_ATTEMPTS; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);
      try {
        return await this.fetchImpl(input, { ...init, signal: controller.signal });
      } catch (cause) {
        lastCause = cause;
      } finally {
        clearTimeout(timeout);
      }
    }
    this.logger.error("GitHub provider request failed", {
      event: "auth.github_provider_request_failed",
      attempts: GITHUB_NETWORK_REQUEST_ATTEMPTS,
      error: lastCause instanceof Error ? lastCause : new Error(String(lastCause)),
    });
    throw new OAuthProviderError("provider_unavailable", "GitHub request failed", {
      cause: lastCause,
    });
  }
}
