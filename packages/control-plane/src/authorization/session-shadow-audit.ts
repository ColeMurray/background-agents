import type { SessionAccessRow } from "@open-inspect/shared";
import { isWorkspaceAdmin } from "@open-inspect/shared/rbac";
import type { SessionReadScope } from "../db/session-visibility";
import type { RequestContext } from "../http/request-context";
import type { TeamsEnforcementMode } from "./teams-enforcement";

export const MAX_SHADOW_DENIAL_IDS = 50;
type VisibilityRow = Pick<SessionAccessRow, "ownerTeamId" | "visibility">;

/** Only the team clause differs between legacy and enforced list visibility. */
export function shadowListDenies(viewer: SessionReadScope, row: VisibilityRow): boolean {
  if (viewer.kind === "internal" || row.visibility !== "team") return false;
  return viewer.kind === "service"
    ? viewer.teamId !== null && viewer.teamId !== row.ownerTeamId
    : !isWorkspaceAdmin(viewer.roleKey) &&
        (row.ownerTeamId === null || !viewer.memberships.has(row.ownerTeamId));
}

export function recordShadowBatchDenial(
  ctx: RequestContext,
  sessionId: string,
  reason: string
): void {
  ctx.shadowBatchDenialCount = (ctx.shadowBatchDenialCount ?? 0) + 1;
  const denials = (ctx.shadowBatchDenials ??= []);
  if (denials.length < MAX_SHADOW_DENIAL_IDS) denials.push({ sessionId, reason });
}

/** Observe only returned rows, without changing the response or reading D1 again. */
export function recordShadowListDenials(
  ctx: RequestContext,
  viewer: SessionReadScope,
  rows: readonly (VisibilityRow & { id: string })[],
  mode: TeamsEnforcementMode
): void {
  if (mode !== "shadow" || viewer.kind === "internal") return;
  for (const row of rows) {
    if (shadowListDenies(viewer, row)) recordShadowBatchDenial(ctx, row.id, "not_member");
  }
}
