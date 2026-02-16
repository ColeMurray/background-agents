/**
 * Git utilities for commit attribution and branch management.
 */

import type { GitUser } from "./types";

/**
 * Branch naming convention for Open-Inspect sessions.
 */
export const BRANCH_PREFIX = "wrench";

/**
 * Generate a branch name for a session.
 *
 * @param sessionId - Session ID
 * @param title - Optional title for the branch
 * @returns Branch name in format: open-inspect/{session-id}
 */
export function generateBranchName(sessionId: string, _title?: string): string {
  // Use just session ID to keep it short and unique
  return `${BRANCH_PREFIX}/${sessionId}`;
}

/**
 * Extract session ID from a branch name.
 *
 * @param branchName - Branch name
 * @returns Session ID or null if not an Open-Inspect branch
 */
export function extractSessionIdFromBranch(branchName: string): string | null {
  const prefix = `${BRANCH_PREFIX}/`;
  if (!branchName.startsWith(prefix)) {
    return null;
  }
  return branchName.slice(prefix.length);
}

/**
 * Check if a branch name is an Open-Inspect branch.
 */
export function isInspectBranch(branchName: string): boolean {
  return branchName.startsWith(`${BRANCH_PREFIX}/`);
}

/**
 * Generate a commit message for automated commits.
 *
 * @param action - What was done (e.g., "Add", "Update", "Fix")
 * @param description - Description of the change
 * @param sessionId - Session ID for traceability
 * @returns Formatted commit message
 */
export function generateCommitMessage(
  action: string,
  description: string,
  sessionId: string
): string {
  return `${action}: ${description}\n\nCo-authored-by: Open-Inspect <open-inspect@noreply.github.com>\nSession-ID: ${sessionId}`;
}

/**
 * Generate a noreply email for users who hide their email.
 *
 * @param githubId - GitHub user ID
 * @param githubLogin - GitHub username
 * @returns GitHub noreply email
 */
export function generateNoreplyEmail(githubId: number | string, githubLogin: string): string {
  return `${githubId}+${githubLogin}@users.noreply.github.com`;
}

/**
 * Get the best email for git commit attribution.
 *
 * Priority:
 * 1. User's public email from GitHub profile
 * 2. User's primary verified email (if accessible)
 * 3. GitHub noreply email
 *
 * @param publicEmail - User's public email (may be null)
 * @param githubId - GitHub user ID
 * @param githubLogin - GitHub username
 * @returns Email to use for commits
 */
export function getCommitEmail(
  publicEmail: string | null,
  githubId: number | string,
  githubLogin: string
): string {
  if (publicEmail) {
    return publicEmail;
  }
  return generateNoreplyEmail(githubId, githubLogin);
}

/**
 * Create GitUser from GitHub profile data.
 */
export function createGitUser(
  githubLogin: string,
  githubName: string | null,
  publicEmail: string | null,
  githubId: number | string
): GitUser {
  return {
    name: githubName || githubLogin,
    email: getCommitEmail(publicEmail, githubId, githubLogin),
  };
}

/**
 * Git environment variables for subprocess.
 */
export function getGitEnv(user: GitUser): Record<string, string> {
  return {
    GIT_AUTHOR_NAME: user.name,
    GIT_AUTHOR_EMAIL: user.email,
    GIT_COMMITTER_NAME: user.name,
    GIT_COMMITTER_EMAIL: user.email,
  };
}
