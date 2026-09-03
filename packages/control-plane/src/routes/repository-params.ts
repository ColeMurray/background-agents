import {
  formatRepositoryFullName,
  parseRepositoryFullName,
} from "@open-inspect/shared/types/repositories";
import { error } from "../http/responses";

/**
 * The repository a route's `:owner/:name` parameters name, or the 400 the
 * route answers when they are not a valid pair. Hono decoded the segments
 * once before admission; nothing here decodes them again.
 */
export function repositoryParams(params: {
  owner: string;
  name: string;
}): { owner: string; name: string } | Response {
  const repository = parseRepositoryFullName(
    formatRepositoryFullName({ repoOwner: params.owner, repoName: params.name })
  );
  if (!repository || repository.repoOwner !== params.owner || repository.repoName !== params.name) {
    return error("Owner and name must be valid repository path segments", 400);
  }
  return { owner: repository.repoOwner, name: repository.repoName };
}
