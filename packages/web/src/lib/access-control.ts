export interface AccessControlConfig {
  allowedDomains: string[];
  allowedUsers: string[];
}

export interface AccessCheckParams {
  scmUsername?: string;
  email?: string;
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
 * - Both allowlists are empty (no restrictions)
 * - User's SCM username is in allowedUsers
 * - User's email domain is in allowedDomains
 *
 * Logic is OR-based: matching either list grants access.
 */
export function checkAccessAllowed(
  config: AccessControlConfig,
  params: AccessCheckParams
): boolean {
  const { allowedDomains, allowedUsers } = config;
  const { scmUsername, email } = params;

  // No restrictions if both lists are empty
  if (allowedDomains.length === 0 && allowedUsers.length === 0) {
    return true;
  }

  if (scmUsername && allowedUsers.includes(scmUsername.toLowerCase())) {
    return true;
  }

  // Check email domain allowlist
  if (email) {
    const domain = email.toLowerCase().split("@")[1];
    if (domain && allowedDomains.includes(domain)) {
      return true;
    }
  }

  return false;
}
