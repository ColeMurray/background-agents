export interface GitHubOrganizationAccessParams {
  accessToken?: string;
  allowedOrganizations: string[];
  fetchImpl?: typeof fetch;
  userAgent?: string;
  timeoutMs?: number;
}

export const GITHUB_MEMBERSHIP_CHECK_TIMEOUT_MS = 10_000;

export type GitHubOrganizationAccessResult =
  | {
      allowed: true;
      reason: "active_membership";
      organization: string;
    }
  | {
      allowed: false;
      reason: "not_member" | "unavailable";
    };

function getMembershipState(data: unknown): unknown {
  return data && typeof data === "object" ? (data as { state?: unknown }).state : undefined;
}

/**
 * Check whether a GitHub user access token belongs to at least one allowed
 * organization. This is the sole, asynchronous source of truth for org-based
 * access — the synchronous allowlist policy in access-control.ts deliberately
 * does not evaluate org membership.
 *
 * Fails closed: any outcome other than a confirmed active membership denies. The
 * result distinguishes a definitive non-membership (`not_member`) from an
 * operational failure (`unavailable` — missing/blocked token, rate limit, GitHub
 * outage, or an unreadable membership response) so the caller can log why a
 * sign-in was rejected.
 */
export async function checkGitHubOrganizationAccess({
  accessToken,
  allowedOrganizations,
  fetchImpl = fetch,
  userAgent = "Open-Inspect",
  timeoutMs = GITHUB_MEMBERSHIP_CHECK_TIMEOUT_MS,
}: GitHubOrganizationAccessParams): Promise<GitHubOrganizationAccessResult> {
  if (allowedOrganizations.length === 0) {
    return { allowed: false, reason: "not_member" };
  }

  if (!accessToken) {
    console.warn("[github-org-access] membership check skipped", {
      reason: "missing_access_token",
      organizationCount: allowedOrganizations.length,
    });
    return { allowed: false, reason: "unavailable" };
  }

  let isUnavailable = false;

  for (const org of allowedOrganizations) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const startedAt = performance.now();

    try {
      const response = await fetchImpl(
        `https://api.github.com/user/memberships/orgs/${encodeURIComponent(org)}`,
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": userAgent,
          },
          signal: controller.signal,
        }
      );

      if (!response.ok) {
        console.warn("[github-org-access] membership request failed", {
          org,
          status: response.status,
          ...getGitHubResponseDiagnostics(response, startedAt),
          hint: getGitHubMembershipFailureHint(response.status),
        });
        if (isGitHubMembershipUnavailableStatus(response.status)) {
          isUnavailable = true;
        }
        continue;
      }

      const state = getMembershipState(await response.json());
      if (state === "active") {
        return { allowed: true, reason: "active_membership", organization: org };
      }

      if (state === "pending") {
        // Expected non-active state (invited, not yet joined): deny, but this is
        // not an outage, so leave isUnavailable untouched (reads as not_member).
        console.info("[github-org-access] membership not active", {
          org,
          state,
          ...getGitHubResponseDiagnostics(response, startedAt),
        });
      } else {
        // Missing or unrecognized state — fail closed AND flag unavailable, since
        // an unusable response can't prove non-membership. `state` in the payload
        // still distinguishes a null state from an unexpected literal.
        isUnavailable = true;
        console.warn("[github-org-access] membership response unusable state", {
          org,
          state: state ?? null,
          ...getGitHubResponseDiagnostics(response, startedAt),
        });
      }
    } catch (error) {
      isUnavailable = true;
      console.warn("[github-org-access] membership request error", {
        org,
        error: error instanceof Error ? error.name : "unknown",
        message: error instanceof Error ? error.message : String(error),
        elapsedMs: getElapsedMs(startedAt),
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  return { allowed: false, reason: isUnavailable ? "unavailable" : "not_member" };
}

function getGitHubMembershipFailureHint(status: number): string | undefined {
  if (status === 401) {
    return "GitHub rejected the OAuth token while checking organization membership.";
  }

  if (status === 403) {
    return "Verify the GitHub OAuth token has read:org access and any organization SAML requirements are satisfied. If this deployment also uses a GitHub App, make sure membership read permission changes were republished and approved.";
  }

  if (status === 429) {
    return "GitHub rate limited the organization membership check.";
  }

  if (status === 404) {
    return "GitHub returns 404 when the user is not an organization member or the token cannot read that membership.";
  }

  if (status >= 500) {
    return "GitHub returned a server error while checking organization membership.";
  }

  return undefined;
}

function isGitHubMembershipUnavailableStatus(status: number): boolean {
  return status !== 404;
}

function getGitHubResponseDiagnostics(response: Response, startedAt: number) {
  return {
    requestId: response.headers.get("x-github-request-id"),
    rateLimitLimit: response.headers.get("x-ratelimit-limit"),
    rateLimitRemaining: response.headers.get("x-ratelimit-remaining"),
    rateLimitReset: response.headers.get("x-ratelimit-reset"),
    retryAfter: response.headers.get("retry-after"),
    elapsedMs: getElapsedMs(startedAt),
  };
}

function getElapsedMs(startedAt: number): number {
  return Math.round(performance.now() - startedAt);
}
