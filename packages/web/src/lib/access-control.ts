export interface AccessControlConfig {
  allowedDomains: string[];
  allowedUsers: string[];
  allowedOrgs: string[];
}

export interface AccessCheckParams {
  githubUsername?: string;
  email?: string;
  githubOrgs?: string[];
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

/**
 * Check if a user is allowed to sign in based on access control configuration.
 *
 * Returns true if:
 * - All allowlists are empty (no restrictions)
 * - User's GitHub username is in allowedUsers
 * - User's email domain is in allowedDomains
 * - User belongs to an org in allowedOrgs
 *
 * Logic is OR-based: matching any list grants access.
 */
export function checkAccessAllowed(
  config: AccessControlConfig,
  params: AccessCheckParams
): boolean {
  const { allowedDomains, allowedUsers, allowedOrgs } = config;
  const { githubUsername, email, githubOrgs } = params;

  // No restrictions if all lists are empty
  if (allowedDomains.length === 0 && allowedUsers.length === 0 && allowedOrgs.length === 0) {
    return true;
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

  // Check GitHub org membership
  if (githubOrgs && githubOrgs.length > 0) {
    const userOrgsLower = githubOrgs.map((o) => o.toLowerCase());
    if (allowedOrgs.some((org) => userOrgsLower.includes(org))) {
      return true;
    }
  }

  return false;
}

/**
 * Fetch the GitHub orgs the user belongs to using their OAuth access token.
 */
export async function fetchGitHubOrgs(accessToken: string): Promise<string[]> {
  const res = await fetch("https://api.github.com/user/orgs?per_page=100", {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/vnd.github+json",
    },
  });
  if (!res.ok) return [];
  const orgs = (await res.json()) as Array<{ login: string }>;
  return orgs.map((o) => o.login);
}
