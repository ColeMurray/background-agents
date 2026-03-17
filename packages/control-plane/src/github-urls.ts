/**
 * GitHub URL utilities for supporting both GitHub.com and GitHub Enterprise Server (GHES).
 *
 * All GitHub URLs in the codebase should be derived from these helpers rather than
 * hardcoded. Set the GITHUB_HOSTNAME environment variable to your GHES hostname
 * (e.g. "github.example.com") to target an enterprise instance. When unset or set
 * to "github.com", standard GitHub.com URLs are used.
 *
 * GHES API convention: https://<hostname>/api/v3
 * GitHub.com API:       https://api.github.com
 */

/** Default hostname when no override is configured. */
const DEFAULT_HOSTNAME = "github.com";

/**
 * Resolved set of GitHub URLs derived from a single hostname.
 */
export interface GitHubUrls {
  /** The hostname, e.g. "github.com" or "github.example.com". */
  hostname: string;

  /** Base URL for REST API calls (no trailing slash). */
  apiBase: string;

  /** Base URL for browser / OAuth endpoints (no trailing slash). */
  webBase: string;

  /** Host used in git remote URLs, e.g. "github.com" or "github.example.com". */
  gitHost: string;

  /** Domain suffix for noreply email addresses. */
  noreplyDomain: string;

  /** Whether this is a GitHub Enterprise Server instance. */
  isEnterprise: boolean;
}

/**
 * Resolve all GitHub URLs from a hostname.
 *
 * @param hostname - e.g. "github.com" or "github.example.com". Defaults to "github.com".
 */
export function resolveGitHubUrls(hostname?: string): GitHubUrls {
  const host = (hostname || DEFAULT_HOSTNAME).toLowerCase().replace(/\/+$/, "");
  const isEnterprise = host !== DEFAULT_HOSTNAME;

  return {
    hostname: host,
    apiBase: isEnterprise ? `https://${host}/api/v3` : "https://api.github.com",
    webBase: `https://${host}`,
    gitHost: host,
    noreplyDomain: isEnterprise ? `users.noreply.${host}` : "users.noreply.github.com",
    isEnterprise,
  };
}
