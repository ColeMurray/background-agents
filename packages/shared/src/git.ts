/**
 * Git utilities for branch management.
 */

/**
 * Branch naming convention for Background Agents sessions.
 */
export const BRANCH_PREFIX = "agent";

/**
 * Generate a branch name for a session.
 *
 * @param sessionId - Session ID
 * @returns Branch name in format: agent/{session-id}
 */
export function generateBranchName(sessionId: string, _title?: string): string {
  return `${BRANCH_PREFIX}/${sessionId}`;
}

/**
 * Extract session ID from a branch name.
 *
 * @param branchName - Branch name
 * @returns Session ID or null if not an agent branch
 */
export function extractSessionIdFromBranch(branchName: string): string | null {
  const prefix = `${BRANCH_PREFIX}/`;
  if (!branchName.startsWith(prefix)) {
    return null;
  }
  return branchName.slice(prefix.length);
}

/**
 * Check if a branch name is an agent branch.
 */
export function isAgentBranch(branchName: string): boolean {
  return branchName.startsWith(`${BRANCH_PREFIX}/`);
}
