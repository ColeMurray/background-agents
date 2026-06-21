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
}

export type AccessAllowReason =
  | "unsafe_allow_all"
  | "username_allowlist"
  | "email_allowlist"
  | "email_domain_allowlist";

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
 * Boolean convenience over getAccessAllowReason: true when any synchronous
 * allowlist admits the user. Does NOT cover GitHub organization membership, which
 * is resolved asynchronously (see checkGitHubOrganizationAccess).
 */
export function checkAccessAllowed(
  config: AccessControlConfig,
  params: AccessCheckParams
): boolean {
  return getAccessAllowReason(config, params) !== null;
}

/**
 * Resolve which allowlist (if any) admits a sign-in, or null to deny.
 *
 * Matching is OR-based across the username, exact-email, and email-domain lists.
 * GitHub organization membership is deliberately NOT evaluated here — it requires
 * an async GitHub API call and is owned entirely by checkGitHubOrganizationAccess,
 * which the sign-in callback applies as a fallback when this returns null.
 * `allowedOrganizations` still participates in the empty-allowlist guard below so
 * an org-only configuration does not collapse into unsafe allow-all.
 */
export function getAccessAllowReason(
  config: AccessControlConfig,
  params: AccessCheckParams
): AccessAllowReason | null {
  const { allowedDomains, allowedUsers, allowedEmails, unsafeAllowAllUsers } = config;
  const allowedOrganizations = config.allowedOrganizations ?? [];
  const { githubUsername, email } = params;

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

  return null;
}
