export interface AccessControlConfig {
  allowedDomains: string[];
  allowedUsers: string[];
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
}

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
 * - User's email domain is in allowedDomains
 * - User has active membership in an allowed GitHub organization
 *
 * Logic is OR-based: matching either list grants access.
 */
export function checkAccessAllowed(
  config: AccessControlConfig,
  params: AccessCheckParams
): boolean {
  const { allowedDomains, allowedUsers, unsafeAllowAllUsers } = config;
  const allowedOrganizations = (config.allowedOrganizations ?? []).map((org) => org.toLowerCase());
  const { githubUsername, email, activeOrganizations } = params;

  // Empty allowlists only permit sign-in when explicitly enabled.
  if (
    allowedDomains.length === 0 &&
    allowedUsers.length === 0 &&
    allowedOrganizations.length === 0
  ) {
    return unsafeAllowAllUsers;
  }

  // Check explicit user allowlist (GitHub username)
  if (githubUsername && allowedUsers.includes(githubUsername.toLowerCase())) {
    return true;
  }

  // Check email domain allowlist
  if (email) {
    const domain = email.toLowerCase().split("@")[1];
    if (domain && allowedDomains.includes(domain)) {
      return true;
    }
  }

  // Check GitHub organization membership allowlist
  if (activeOrganizations) {
    const normalizedActiveOrganizations = activeOrganizations.map((org) => org.toLowerCase());
    if (allowedOrganizations.some((org) => normalizedActiveOrganizations.includes(org))) {
      return true;
    }
  }

  return false;
}

/**
 * Check if a GitHub user access token belongs to at least one allowed organization.
 */
export async function checkGitHubOrganizationAccess({
  accessToken,
  allowedOrganizations,
  fetchImpl = fetch,
  userAgent = "Open-Inspect",
}: GitHubOrganizationAccessParams): Promise<boolean> {
  if (!accessToken || allowedOrganizations.length === 0) {
    return false;
  }

  const checks = allowedOrganizations.map(async (org) => {
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
        }
      );

      if (!response.ok) {
        return false;
      }

      const membership = (await response.json()) as { state?: string };
      return membership.state === "active";
    } catch {
      return false;
    }
  });

  return (await Promise.all(checks)).some(Boolean);
}
