/**
 * Repository allowlist matching for the opt-in repo access gate
 * (ENFORCE_REPO_ACL). Patterns come from the REPO_ACL_ALLOWLIST env var as a
 * comma-separated `owner/name` list where either segment may be a wildcard:
 *
 *   "acme/api,acme/star,star/docs,star"  — exact repo, any repo of an owner,
 *                                          any owner's named repo, or
 *                                          everything (star = the `*` glyph).
 *
 * A bare `*` entry means "allow every repository" (the gate then only guards
 * against future removal of the entry, so it is rarely useful — but it keeps
 * the grammar uniform).
 *
 * Owners may be nested namespaces (GitLab subgroups), so an entry is split on
 * the LAST "/" — `group/sub/*` allows every repo under the `group/sub`
 * namespace. Matching is case-insensitive because both GitHub and GitLab treat
 * repository paths as case-insensitive.
 */

export interface RepoAclPattern {
  owner: string;
  name: string;
}

/**
 * Parses a REPO_ACL_ALLOWLIST value. Whitespace around entries is ignored,
 * empty entries are skipped, and `undefined`/empty input yields an empty
 * allowlist (the gate denies everything — parseRepoAclConfig turns that into a
 * startup error when enforcement is on).
 */
export function parseRepoAclAllowlist(raw: string | undefined): readonly RepoAclPattern[] {
  if (!raw) return [];
  const patterns: RepoAclPattern[] = [];
  for (const entry of raw.split(",")) {
    const trimmed = entry.trim();
    if (trimmed === "") continue;
    if (trimmed === "*") {
      patterns.push({ owner: "*", name: "*" });
      continue;
    }
    const separator = trimmed.lastIndexOf("/");
    if (separator === -1) {
      throw new Error(
        `REPO_ACL_ALLOWLIST entry "${trimmed}" is malformed; expected owner/name where either segment may be *`
      );
    }
    const owner = trimmed.slice(0, separator);
    const name = trimmed.slice(separator + 1);
    if (owner === "" || name === "") {
      throw new Error(
        `REPO_ACL_ALLOWLIST entry "${trimmed}" is malformed; expected owner/name where either segment may be *`
      );
    }
    patterns.push({ owner: owner.toLowerCase(), name: name.toLowerCase() });
  }
  return patterns;
}

/** Tests one `owner/name` pair against the parsed allowlist. */
export function isRepoAllowed(
  patterns: readonly RepoAclPattern[],
  repoOwner: string,
  repoName: string
): boolean {
  const owner = repoOwner.toLowerCase();
  const name = repoName.toLowerCase();
  return patterns.some(
    (pattern) =>
      (pattern.owner === "*" || pattern.owner === owner) &&
      (pattern.name === "*" || pattern.name === name)
  );
}
