import type { SessionAccessRow } from "@open-inspect/shared";
import { isWorkspaceAdmin } from "@open-inspect/shared/rbac";
import type { SessionReadScope } from "../db/session-visibility";
import type { RequestContext } from "../http/request-context";
import type { TeamsEnforcementMode } from "./teams-enforcement";

type VisibilityRow = Pick<SessionAccessRow, "ownerTeamId" | "visibility">;

/** Only the team clause differs between legacy and enforced list visibility. */
export function shadowListDenies(viewer: SessionReadScope, row: VisibilityRow): boolean {
  if (viewer.kind === "internal" || row.visibility !== "team") return false;
  return viewer.kind === "service"
    ? viewer.teamId !== null && viewer.teamId !== row.ownerTeamId
    : !isWorkspaceAdmin(viewer.roleKey) &&
        (row.ownerTeamId === null || !viewer.memberships.has(row.ownerTeamId));
}

export function recordShadowListDenialCount(ctx: RequestContext, count: number): void {
  if (count > 0) ctx.shadowListDenialCount = (ctx.shadowListDenialCount ?? 0) + count;
}

/** Observe only returned rows, without changing the response or reading D1 again. */
export function recordShadowListDenials(
  ctx: RequestContext,
  viewer: SessionReadScope,
  rows: readonly VisibilityRow[],
  mode: TeamsEnforcementMode
): void {
  if (mode !== "shadow" || viewer.kind === "internal") return;
  const count = rows.reduce((total, row) => total + (shadowListDenies(viewer, row) ? 1 : 0), 0);
  recordShadowListDenialCount(ctx, count);
}
