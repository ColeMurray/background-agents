import { isWorkspaceAdmin } from "@open-inspect/shared/rbac";
import { resolveTeamAccess } from "@open-inspect/shared/types/team-access";
import { viewerFromContext } from "../authorization/session-admission";
import { TeamMembershipStore } from "../db/team-memberships";
import { TeamStore } from "../db/teams";
import type { RequestContext } from "../http/request-context";
import { error, json } from "../http/responses";
import type { RouteParams } from "../routes/shared";
import {
  authorizationDenial,
  authorizationUnavailable,
  type AuthorizationEvidence,
  type AuthorizationFailure,
} from "./authorization-evidence";

/** Route authorization needs are closed independently of presentation capabilities. */
export type TeamAdmissionNeed =
  | "read"
  | "member"
  | "canJoin"
  | "canLeave"
  | "canEditMetadata"
  | "canManageMembers"
  | "canManageRepositories"
  | "canManageBindings"
  | "canManageAutomations"
  | "canManageEnvironments"
  | "canManageSecrets"
  | "canArchive"
  | "removeMember";

export type TeamAdmissionRequirement =
  | { kind: "team"; teamIdParam: string; need: Exclude<TeamAdmissionNeed, "removeMember"> }
  | { kind: "team"; teamIdParam: string; need: "removeMember"; targetUserIdParam: string };

export async function enforceTeamRequirement(
  requirement: TeamAdmissionRequirement,
  params: RouteParams,
  ctx: RequestContext,
  evidence: AuthorizationEvidence
): Promise<AuthorizationFailure | null> {
  if (ctx.principal?.kind !== "user") {
    return authorizationDenial(
      json({ error: "Forbidden", code: "service_capability_required" }, 403),
      evidence,
      requirement,
      "service_capability_required",
      "Forbidden"
    );
  }
  const teamId = params[requirement.teamIdParam];
  if (!teamId) return { response: json({ error: "Invalid team route" }, 400) };
  try {
    const team = await new TeamStore(ctx.db).getById(teamId);
    if (!team)
      return authorizationDenial(
        error("Team not found", 404),
        evidence,
        requirement,
        "team_not_visible",
        "Team not found"
      );
    const memberships = new TeamMembershipStore(ctx.db);
    const viewer = viewerFromContext(
      ctx,
      (ctx.sessionMemberships ??= await memberships.listForUser(ctx.principal.userId))
    );
    if (viewer.kind !== "user") throw new Error("Missing team viewer");
    const isAdmin = isWorkspaceAdmin(viewer.roleKey);
    const isMember = isAdmin || viewer.memberships.has(teamId);
    if (
      !isMember &&
      (requirement.need === "member" ||
        requirement.need === "removeMember" ||
        (requirement.need === "read" && team.archivedAt !== null))
    )
      return authorizationDenial(
        error("Team not found", 404),
        evidence,
        requirement,
        "team_not_visible",
        "Team not found"
      );
    const access = resolveTeamAccess(viewer, {
      ...team,
      leadCount: await memberships.countLeads(teamId),
    });
    let capabilityDenied: boolean;
    if (requirement.need === "removeMember") {
      const targetUserId = params[requirement.targetUserIdParam];
      if (!targetUserId) return { response: error("Invalid team member route", 400) };
      capabilityDenied = targetUserId !== viewer.userId && !access.canManageMembers;
      // Preserve the existing 404 for an absent target membership.
      if (
        capabilityDenied &&
        !(await memberships.listMembers(teamId)).some((member) => member.userId === targetUserId)
      ) {
        return { response: error("Team membership not found", 404) };
      }
    } else {
      capabilityDenied =
        requirement.need !== "read" && requirement.need !== "member" && !access[requirement.need];
    }
    if (capabilityDenied) {
      const reasonCode =
        requirement.need === "canJoin"
          ? team.archivedAt !== null
            ? "team_archived"
            : team.joinPolicy === "invite_only"
              ? "invite_only"
              : "already_member"
          : "team_capability_required";
      return authorizationDenial(
        json({ error: "Forbidden", code: reasonCode, reason_code: reasonCode }, 403),
        evidence,
        requirement,
        reasonCode,
        "Forbidden"
      );
    }
    evidence.requirements.push(requirement);
    ctx.teamAdmission = { team, access };
    return null;
  } catch {
    return authorizationUnavailable();
  }
}
