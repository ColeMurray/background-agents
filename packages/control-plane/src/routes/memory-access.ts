import type { MemoryRecord, MemoryScope } from "@open-inspect/shared/types/memories";
import {
  evaluateEnvironmentAdmission,
  ownedResourceAdmissionResponse,
} from "../authorization/owned-resource-admission";
import { createLogger } from "../logger";
import { error, resolveRepoOrError, type UserRouteContext } from "./shared";
import { authorizeWorkspaceRepositories } from "./workspace-repository-authorization";

const logger = createLogger("memories");

/** Management remains owner-only even when the owner has included content in a shared session. */
export async function authorizeMemoryScope(
  ctx: UserRouteContext,
  env: Parameters<typeof resolveRepoOrError>[0],
  scope: MemoryScope,
  write: boolean,
  record?: MemoryRecord
): Promise<{ repoId: number | null; canManage: boolean } | Response> {
  if (scope.type === "personal") {
    if (record && record.ownerUserId !== ctx.principal.userId)
      return error("Memory not found", 404);
    if (!ctx.authorization?.permissions.includes("memories.manage_own"))
      return error("Personal memory permission required", 403);
    return { repoId: null, canManage: true };
  }
  if (scope.type === "environment") {
    const read = await evaluateEnvironmentAdmission(ctx, scope.environmentId, "read");
    if (read.kind !== "allowed") return ownedResourceAdmissionResponse(read);
    const manage = await evaluateEnvironmentAdmission(ctx, scope.environmentId, "manage");
    const canManage =
      manage.kind === "allowed" &&
      !!ctx.authorization?.permissions.includes("environments.settings.manage");
    return write && !canManage
      ? error("Environment memory management permission required", 403)
      : { repoId: null, canManage };
  }
  if (!ctx.authorization?.permissions.includes("repositories.read"))
    return error("Repository read permission required", 403);
  const repo = await resolveRepoOrError(env, scope.repoOwner, scope.repoName, ctx, logger);
  const repositories = [{ owner: repo.repoOwner, name: repo.repoName, repoId: repo.repoId }];
  const denied = await authorizeWorkspaceRepositories(ctx, { repositories });
  if (denied) return denied;
  const canManage =
    !!ctx.authorization.permissions.includes("repositories.settings.manage") &&
    !(await authorizeWorkspaceRepositories(ctx, { repositories, requireLead: true }));
  return write && !canManage
    ? error("Repository memory management permission required", 403)
    : { repoId: repo.repoId, canManage };
}
