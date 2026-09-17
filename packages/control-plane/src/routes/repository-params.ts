import { validateRepositoryPathSegments } from "@open-inspect/shared/types/repositories";
import { error } from "../http/responses";

/**
 * The repository a route's `:owner/:name` parameters name, or the 400 the
 * route answers when they are not a canonical pair. Hono decoded the
 * segments once before admission; the shared identity module owns the rule.
 */
export function repositoryParams(params: {
  owner: string;
  name: string;
}): { owner: string; name: string } | Response {
  const repository = validateRepositoryPathSegments(params.owner, params.name);
  if (!repository) {
    return error("Owner and name must be valid repository path segments", 400);
  }
  return { owner: repository.repoOwner, name: repository.repoName };
}
