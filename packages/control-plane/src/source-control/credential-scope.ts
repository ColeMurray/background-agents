/**
 * Per-call scope for deployment-level credentials; providers are shared across sessions.
 * GitHub honors this scope when minting installation tokens. GitLab uses a
 * deployment-wide PAT and does not narrow its credentials by scope.
 * GitHub refuses an empty repository scope rather than granting installation-wide access.
 */
export type CredentialScope = { kind: "all" } | { kind: "repositories"; repositoryIds: number[] };
