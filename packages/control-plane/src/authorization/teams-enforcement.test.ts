import { describe, expect, it } from "vitest";
import { SESSION_ACTIONS, type SessionAccessRow, type SessionViewer } from "@open-inspect/shared";
import { permissionsForBuiltInRole } from "@open-inspect/shared/rbac";
import { effectiveSessionCapabilities } from "./session-admission";
import {
  legacyPermissionForAction,
  parseTeamsEnforcementMode,
  resolverDecides,
} from "./teams-enforcement";

describe("teams enforcement", () => {
  it("defaults to shadow and accepts only the three modes", () => {
    expect(parseTeamsEnforcementMode(undefined)).toBe("shadow");
    expect(parseTeamsEnforcementMode("off")).toBe("off");
    expect(parseTeamsEnforcementMode("shadow")).toBe("shadow");
    expect(parseTeamsEnforcementMode("on")).toBe("on");
    expect(() => parseTeamsEnforcementMode("enabled")).toThrow();
  });

  it("maps every resolver action to its pre-enforcement permission", () => {
    expect(SESSION_ACTIONS.map((action) => legacyPermissionForAction(action))).toEqual([
      "sessions.read",
      "sessions.collaborate",
      "sessions.lifecycle",
      "sessions.delete",
      "sessions.sandbox_access",
      "sessions.lifecycle",
      "sessions.lifecycle",
    ]);
  });

  it.each(["off", "shadow", "on"] as const)(
    "uses the resolver for private rows and team-owned actions in %s mode",
    (mode) => {
      for (const ownerTeamId of [null, "team_one"]) {
        for (const visibility of ["workspace", "private", "team"] as const) {
          if (ownerTeamId === null && visibility === "team") continue;
          for (const action of SESSION_ACTIONS) {
            expect(resolverDecides(mode, { ownerTeamId, visibility }, action)).toBe(
              mode === "on" ||
                visibility === "private" ||
                (ownerTeamId !== null && action !== "read")
            );
          }
        }
      }
    }
  );

  it.each(["off", "shadow", "on"] as const)(
    "keeps non-member team capabilities read-only in %s mode",
    (mode) => {
      const row: SessionAccessRow = {
        id: "session_one",
        ownerTeamId: "team_one",
        ownerUserId: "user_one",
        visibility: "workspace",
        collaboratorIds: [],
      };
      for (const roleKey of ["member", "administrator", "owner"] as const) {
        const viewer: SessionViewer = {
          kind: "user",
          userId: "user_one",
          roleKey,
          permissions: permissionsForBuiltInRole(roleKey),
          suspended: false,
          memberships: new Map(),
        };
        expect(effectiveSessionCapabilities(viewer, row, mode)).toEqual({
          canRead: true,
          canCollaborate: false,
          canManageLifecycle: false,
          canDelete: false,
          canSandbox: false,
          canManageCollaborators: false,
          canChangeVisibility: false,
        });
        expect(
          effectiveSessionCapabilities(viewer, { ...row, ownerTeamId: null }, mode)
        ).toMatchObject({
          canRead: true,
          canCollaborate: true,
          canManageLifecycle: true,
          canDelete: true,
          canSandbox: true,
          canManageCollaborators: true,
          canChangeVisibility: true,
        });
      }
    }
  );
});
