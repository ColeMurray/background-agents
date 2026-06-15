export interface AccessControlConfig {
  allowedDomains: string[];
  allowedUsers: string[];
  allowedEmails: string[];
  unsafeAllowAllUsers: boolean;
}

export interface AccessCheckParams {
  githubUsername?: string;
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
 *
 * Logic is OR-based: matching any list grants access.
 */
export function checkAccessAllowed(
  config: AccessControlConfig,
  params: AccessCheckParams
): boolean {
  const { allowedDomains, allowedUsers, allowedEmails, unsafeAllowAllUsers } = config;
  const { githubUsername, email } = params;

  // Empty allowlists only permit sign-in when explicitly enabled.
  if (allowedDomains.length === 0 && allowedUsers.length === 0 && allowedEmails.length === 0) {
    return unsafeAllowAllUsers;
  }

  // Check explicit user allowlist (GitHub username)
  if (githubUsername && allowedUsers.includes(githubUsername.toLowerCase())) {
    return true;
  }

  // Check exact email allowlist. Provider-agnostic, and the only way to admit a
  // specific address on a shared domain (e.g. one gmail.com user) without
  // domain-allowing every gmail.com account.
  if (email && allowedEmails.includes(email.toLowerCase())) {
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
