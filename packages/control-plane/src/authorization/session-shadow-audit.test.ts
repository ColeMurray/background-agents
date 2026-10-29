import {
  checkSessionAccess,
  type SessionAccessRow,
  type SessionViewer,
} from "@open-inspect/shared";
import type { TeamRole } from "@open-inspect/shared/types/teams";
import { describe, expect, it } from "vitest";
import type { RequestContext } from "../http/request-context";
import {
  recordShadowListDenialCount,
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

  it("keeps the exact count across returned pages without retaining session IDs", () => {
    const ctx = {} as RequestContext;
    const rows = Array.from({ length: 75 }, (_, index) => ({ ...row, id: `session_${index}` }));
    recordShadowListDenials(ctx, viewer, rows.slice(0, 30), "shadow");
    recordShadowListDenials(ctx, viewer, rows.slice(30), "shadow");
    expect(ctx).toEqual({ shadowListDenialCount: rows.length });
    expect(ctx).not.toHaveProperty("shadowBatchDenials");
  });

  it("counts only eligible rows without requiring row IDs", () => {
    const ctx = {} as RequestContext;
    recordShadowListDenials(
      ctx,
      viewer,
      [
        { ownerTeamId: row.ownerTeamId, visibility: "team" },
        { ownerTeamId: null, visibility: "workspace" },
        { ownerTeamId: row.ownerTeamId, visibility: "private" },
      ],
      "shadow"
    );
    expect(ctx).toEqual({ shadowListDenialCount: 1 });
  });

  it("leaves zero observations unrecorded", () => {
    const ctx = {} as RequestContext;
    recordShadowListDenialCount(ctx, 0);
    recordShadowListDenials(ctx, viewer, [], "shadow");
    recordShadowListDenials(ctx, viewer, [{ ...row, visibility: "workspace" }], "shadow");
    expect(ctx).toEqual({});
  });

  it("adds positive counts without changing item or explicit body-ID mutation evidence", () => {
    const shadowBatchDenials = [{ sessionId: "batch-action", reason: "not_owner_or_lead" }];
    const ctx = {
      shadowSessionDenial: "not_member",
      shadowBatchDenials,
    } as RequestContext;
    recordShadowListDenialCount(ctx, 30);
    recordShadowListDenialCount(ctx, 44);
    recordShadowListDenials(ctx, viewer, [row], "shadow");
    recordShadowListDenialCount(ctx, 0);
    expect(ctx).toEqual({
      shadowSessionDenial: "not_member",
      shadowBatchDenials: [{ sessionId: "batch-action", reason: "not_owner_or_lead" }],
      shadowListDenialCount: 75,
    });
    expect(ctx.shadowBatchDenials).toBe(shadowBatchDenials);
  });
});
