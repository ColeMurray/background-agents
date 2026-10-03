import {
  checkSessionAccess,
  type SessionAccessRow,
  type SessionViewer,
} from "@open-inspect/shared";
import type { TeamRole } from "@open-inspect/shared/types/teams";
import { describe, expect, it } from "vitest";
import type { RequestContext } from "../http/request-context";
import {
  MAX_SHADOW_DENIAL_IDS,
  recordShadowBatchDenial,
  recordShadowListDenials,
  shadowListDenies,
} from "./session-shadow-audit";

const row: SessionAccessRow = {
  id: "session_one",
  ownerUserId: "creator",
  ownerTeamId: "team_one",
  visibility: "team",
  collaboratorIds: ["collaborator"],
};
const viewer: SessionViewer = {
  kind: "user",
  userId: "reader",
  roleKey: "member",
  permissions: ["sessions.read"],
  suspended: false,
  memberships: new Map(),
};

describe("list shadow observation", () => {
  it("matches the enforced read resolver across visibility, memberships, roles, and relationships", () => {
    for (const visibility of ["workspace", "team", "private"] as const) {
      for (const roleKey of ["owner", "administrator", "member", "viewer", null] as const) {
        for (const teamRole of [null, "member", "lead", "other-team"] as const) {
          for (const userId of ["reader", "creator", "collaborator"]) {
            const actor: SessionViewer = {
              ...viewer,
              userId,
              roleKey,
              memberships: new Map<string, TeamRole>(
                teamRole === null
                  ? []
                  : teamRole === "other-team"
                    ? [["team_other", "member"]]
                    : [["team_one", teamRole]]
              ),
            };
            const target = { ...row, visibility };
            const enforced = checkSessionAccess(actor, target, "read");
            // Private denials are already enforced, so only legacy-readable rows have a delta.
            expect(
              shadowListDenies(actor, target),
              `${visibility}/${roleKey}/${teamRole}/${userId}`
            ).toBe(!enforced.allowed && enforced.reason === "not_member");
          }
        }
      }
    }
  });

  it("matches enforced service reads and ignores trusted internal scopes", () => {
    for (const teamId of [null, "team_one", "team_other"]) {
      const actor: SessionViewer = { kind: "service", teamId };
      for (const visibility of ["workspace", "team", "private"] as const) {
        const target = { ...row, visibility };
        const enforced = checkSessionAccess(actor, target, "read");
        expect(shadowListDenies(actor, target)).toBe(
          !enforced.allowed && enforced.reason === "not_member"
        );
      }
    }
    expect(shadowListDenies({ kind: "internal", reason: "trusted" }, row)).toBe(false);
    expect(shadowListDenies(viewer, { ...row, ownerTeamId: null, visibility: "workspace" })).toBe(
      false
    );
  });

  it.each(["off", "on"] as const)("leaves %s mode unobserved", (mode) => {
    const ctx = {} as RequestContext;
    recordShadowListDenials(ctx, viewer, [row], mode);
    expect(ctx).toEqual({});
  });

  it("caps the sample across pages on the same request and keeps the total", () => {
    const ctx = {} as RequestContext;
    const rows = Array.from({ length: 75 }, (_, index) => ({ ...row, id: `session_${index}` }));
    recordShadowListDenials(ctx, viewer, rows.slice(0, 30), "shadow");
    recordShadowListDenials(ctx, viewer, rows.slice(30), "shadow");
    expect(ctx.shadowBatchDenialCount).toBe(rows.length);
    expect(ctx.shadowBatchDenials).toEqual(
      rows
        .slice(0, MAX_SHADOW_DENIAL_IDS)
        .map(({ id }) => ({ sessionId: id, reason: "not_member" }))
    );
    recordShadowBatchDenial(ctx, "batch-action", "not_owner_or_lead");
    expect(ctx.shadowBatchDenialCount).toBe(rows.length + 1);
    expect(ctx.shadowBatchDenials).toHaveLength(MAX_SHADOW_DENIAL_IDS);
  });
});
