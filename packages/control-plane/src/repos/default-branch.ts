/**
 * Last-resort base branch, assumed only when neither the caller nor the SCM
 * provider's repository metadata supplies one (e.g. repository rows persisted
 * before base_branch was stored). Configured per-repo defaults always win.
 */
export const DEFAULT_BASE_BRANCH = "main";
