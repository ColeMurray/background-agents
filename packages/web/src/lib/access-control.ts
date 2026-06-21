export interface AccessControlConfig {
  allowedDomains: string[];
  allowedUsers: string[];
  allowedEmails: string[];
  allowedOrganizations?: string[];
  unsafeAllowAllUsers: boolean;
}

export interface AccessCheckParams {
  githubUsername?: string;
  email?: string;
  activeOrganizations?: string[];
}

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

export type AccessAllowReason =
  | "unsafe_allow_all"
  | "username_allowlist"
  | "email_allowlist"
  | "email_domain_allowlist"
  | "org_membership";

/**
 * Parse comma-separated environment variable into a lowercase, trimmed array
 */
export function parseAllowlist(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

export function parseBooleanEnv(value: string | undefined): boolean {
  return value?.trim().toLowerCase() === "true";
}

/**
 * Check if a user is allowed to sign in based on access control configuration.
 *
 * Returns true if:
 * - All allowlists are empty and unsafeAllowAllUsers is true
 * - User's GitHub username is in allowedUsers
 * - User's exact email is in allowedEmails
 * - User's email domain is in allowedDomains
 * - User has active membership in an allowed GitHub organization
 *
 * Logic is OR-based: matching any list grants access.
 */
export function checkAccessAllowed(
  config: AccessControlConfig,
  params: AccessCheckParams
): boolean {
  return getAccessAllowReason(config, params) !== null;
}

export function getAccessAllowReason(
  config: AccessControlConfig,
  params: AccessCheckParams
): AccessAllowReason | null {
  const { allowedDomains, allowedUsers, allowedEmails, unsafeAllowAllUsers } = config;
  const allowedOrganizations = (config.allowedOrganizations ?? []).map((org) => org.toLowerCase());
  const { githubUsername, email, activeOrganizations } = params;

  // Empty allowlists only permit sign-in when explicitly enabled.
  if (
    allowedDomains.length === 0 &&
    allowedUsers.length === 0 &&
    allowedEmails.length === 0 &&
    allowedOrganizations.length === 0
  ) {
    return unsafeAllowAllUsers ? "unsafe_allow_all" : null;
  }

  // Check explicit user allowlist (GitHub username)
  if (githubUsername && allowedUsers.includes(githubUsername.toLowerCase())) {
    return "username_allowlist";
  }

  // Check exact email allowlist. Provider-agnostic, and the only way to admit a
  // specific address on a shared domain (e.g. one gmail.com user) without
  // domain-allowing every gmail.com account.
  if (email && allowedEmails.includes(email.toLowerCase())) {
    return "email_allowlist";
  }

  // Check email domain allowlist
  if (email) {
    const domain = email.toLowerCase().split("@")[1];
    if (domain && allowedDomains.includes(domain)) {
      return "email_domain_allowlist";
    }
  }

  // Check GitHub organization membership allowlist
  if (activeOrganizations) {
    const normalizedActiveOrganizations = activeOrganizations.map((org) => org.toLowerCase());
    if (allowedOrganizations.some((org) => normalizedActiveOrganizations.includes(org))) {
      return "org_membership";
    }
  }

  return null;
}

/**
 * Check if a GitHub user access token belongs to at least one allowed organization.
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

      const membership = (await response.json()) as { state?: string | null };
      if (membership.state === "active") {
        return { allowed: true, reason: "active_membership", organization: org };
      }

      if (membership.state == null) {
        isUnavailable = true;
        console.warn("[github-org-access] membership response missing state", {
          org,
          state: membership.state ?? null,
          ...getGitHubResponseDiagnostics(response, startedAt),
        });
      } else if (membership.state === "pending") {
        console.info("[github-org-access] membership not active", {
          org,
          state: membership.state,
          ...getGitHubResponseDiagnostics(response, startedAt),
        });
      } else {
        isUnavailable = true;
        console.warn("[github-org-access] membership response unexpected state", {
          org,
          state: membership.state,
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
