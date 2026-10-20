import { z } from "zod";
import { SIGN_IN_PROVIDER_ISSUERS } from "@open-inspect/shared/sign-in-provider";
import { createLogger, type Logger } from "../../../logger";
import { readBoundedBytes } from "../../../http/bounded-body";
import { DEFAULT_PROVIDER_REQUEST_TIMEOUT_MS } from "./constants";
import { assertCanonicalIssuer, OAuthProviderError, type VerifiedProviderIdentity } from "./types";

const GITHUB_API_URL = "https://api.github.com";
const GITHUB_API_VERSION = "2022-11-28";
const GITHUB_EMAILS_PER_PAGE = 100;
const GITHUB_EMAILS_MAX_PAGES = 10;
const GITHUB_NETWORK_REQUEST_ATTEMPTS = 2;
const GITHUB_ERROR_BODY_MAX_BYTES = 8 * 1024;
const GITHUB_ERROR_MESSAGE_MAX_LENGTH = 200;

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
    assertCanonicalIssuer(config.issuer, SIGN_IN_PROVIDER_ISSUERS.github);
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
      issuer: SIGN_IN_PROVIDER_ISSUERS.github,
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
    const { response } = await this.fetchWithTimeout(`${GITHUB_API_URL}/user`, {
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

      const { response, abort } = await this.fetchWithTimeout(pageUrl, {
        headers: this.apiHeaders(accessToken),
      });
      if (!response.ok) {
        // A 403 alone does not identify a missing permission. Require GitHub's
        // permission-denial message and exclude rate limits and later pages.
        const bodyMessage = await this.readGitHubErrorMessage(response, abort);
        const rateLimited =
          response.headers.get("x-ratelimit-remaining") === "0" ||
          response.headers.get("retry-after") !== null ||
          /rate.?limit|abuse/i.test(bodyMessage ?? "");
        const permissionHint =
          response.status === 403 &&
          page === 1 &&
          bodyMessage === "Resource not accessible by integration" &&
          !rateLimited
            ? "Grant the GitHub App the Account -> Email addresses: Read-only permission and approve the installation update (see docs/GETTING_STARTED.md step 7)"
            : undefined;
        this.logger.error("GitHub email lookup failed", {
          event: "auth.github_email_lookup_failed",
          status: response.status,
          ...(typeof bodyMessage === "string" ? { githubMessage: bodyMessage } : {}),
          ...(permissionHint ? { hint: permissionHint } : {}),
        });
        throw new OAuthProviderError(
          permissionHint ? "provider_rejected" : "provider_unavailable",
          `GitHub email lookup was not successful (status ${response.status}${
            permissionHint ? `; ${permissionHint}` : ""
          })`
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

  private async readGitHubErrorMessage(
    response: Response,
    abort: () => void
  ): Promise<string | undefined> {
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    try {
      const body = await Promise.race([
        readBoundedBytes(
          response.body,
          GITHUB_ERROR_BODY_MAX_BYTES,
          response.headers.get("Content-Length")
        ),
        new Promise<null>((resolve) => {
          timeoutId = setTimeout(() => resolve(null), this.requestTimeoutMs);
        }),
      ]);
      if (body === null) {
        abort();
        return undefined;
      }
      if (!body.ok) return undefined;
      const data: unknown = JSON.parse(new TextDecoder().decode(body.bytes));
      if (
        typeof data === "object" &&
        data !== null &&
        "message" in data &&
        typeof data.message === "string"
      ) {
        return data.message.slice(0, GITHUB_ERROR_MESSAGE_MAX_LENGTH);
      }
      return undefined;
    } catch {
      return undefined;
    } finally {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
    }
  }

  private async fetchWithTimeout(
    input: RequestInfo | URL,
    init: RequestInit
  ): Promise<{ response: Response; abort: () => void }> {
    let lastCause: unknown;
    for (let attempt = 1; attempt <= GITHUB_NETWORK_REQUEST_ATTEMPTS; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);
      try {
        const response = await this.fetchImpl(input, { ...init, signal: controller.signal });
        return { response, abort: () => controller.abort() };
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
