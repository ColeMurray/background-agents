/**
 * Repository identifier helpers.
 */

/**
 * Split a repo full name into owner and name.
 *
 * Splits on the LAST slash: GitLab projects can live in nested groups
 * ("group/subgroup/project"), where everything before the final segment is
 * the owner namespace. GitHub "org/repo" names split identically.
 */
export function splitRepoFullName(fullName: string): { owner: string; name: string } {
  const idx = fullName.lastIndexOf("/");
  if (idx === -1) {
    return { owner: "", name: fullName };
  }
  return { owner: fullName.slice(0, idx), name: fullName.slice(idx + 1) };
}
