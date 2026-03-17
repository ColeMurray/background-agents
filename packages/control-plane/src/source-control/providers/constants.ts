/**
 * Provider constants.
 */

/** User-Agent header for API requests. */
export const USER_AGENT = "Open-Inspect";

/**
 * GitHub API base URL.
 *
 * @deprecated Use `resolveGitHubUrls()` from `../../github-urls` instead
 * to support GitHub Enterprise Server. This constant is kept for backward
 * compatibility but always points to github.com.
 */
export const GITHUB_API_BASE = "https://api.github.com";
