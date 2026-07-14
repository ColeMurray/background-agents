/**
 * Resolve a full repository name against the supervisor's repository manifest.
 * Owners may contain slashes; the repository name is always the final segment.
 */
export function resolveRepositoryTarget(repo, repositories) {
  const requested = String(repo || "").trim();

  if (repositories.length > 0) {
    const normalized = requested.toLowerCase();
    return (
      repositories.find(
        (repository) => `${repository.owner}/${repository.name}`.toLowerCase() === normalized
      ) || null
    );
  }

  const separator = requested.lastIndexOf("/");
  if (separator <= 0 || separator === requested.length - 1) {
    return null;
  }

  const owner = requested.slice(0, separator);
  const name = requested.slice(separator + 1);
  if (owner.split("/").some((segment) => !segment)) {
    return null;
  }

  return { owner, name };
}
