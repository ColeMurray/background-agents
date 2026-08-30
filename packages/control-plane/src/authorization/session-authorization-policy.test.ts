import { describe, expect, it, vi } from "vitest";
import type { EffectiveAuthorization } from "@open-inspect/shared/rbac";
import {
  getSessionRelation,
  sessionAccessPredicate,
  sessionPermissionScope,
  sessionRelationshipDecision,
} from "./session-authorization-policy";

function authorization(permissions: EffectiveAuthorization["permissions"]): EffectiveAuthorization {
  return {
    userId: "user-1",
    suspendedAt: null,
    role: { id: "role-1", key: "member", name: "Member" },
    permissions,
  };
}

describe("session authorization policy", () => {
  it("resolves any before own and returns null without either permission", () => {
    expect(sessionPermissionScope(authorization(["sessions.read.own"]), "read")).toBe("own");
    expect(
      sessionPermissionScope(authorization(["sessions.read.own", "sessions.read.any"]), "read")
    ).toBe("any");
    expect(sessionPermissionScope(authorization([]), "read")).toBeNull();
  });

  it("allows participants for relationship-scoped operations", () => {
    expect(sessionRelationshipDecision("read", "own", "participant")).toEqual({ allowed: true });
    expect(sessionRelationshipDecision("lifecycle", "own", "participant")).toEqual({
      allowed: true,
    });
  });

  it("uses stable creator-only and general access errors", () => {
    expect(sessionRelationshipDecision("delete", "own", "participant")).toEqual({
      allowed: false,
      code: "creator_required",
    });
    expect(sessionRelationshipDecision("participants.manage", "own", null)).toEqual({
      allowed: false,
      code: "creator_required",
    });
    expect(sessionRelationshipDecision("read", "own", null)).toEqual({
      allowed: false,
      code: "session_access_required",
    });
  });

  it("bypasses relationships for any scope", () => {
    expect(sessionRelationshipDecision("delete", "any", null)).toEqual({ allowed: true });
  });

  it("builds the reusable relationship predicate", () => {
    expect(sessionAccessPredicate("sessions", "user-1", "any")).toEqual({
      sql: "1 = 1",
      params: [],
    });
    expect(sessionAccessPredicate("candidate", "user-1", "own")).toEqual({
      sql: expect.stringContaining("access.session_id = candidate.id"),
      params: ["user-1"],
    });
  });

  it("loads one relationship by session and user", async () => {
    const first = vi.fn(async () => ({ relation: "participant" as const }));
    const bind = vi.fn(() => ({ first }));
    const prepare = vi.fn(() => ({ bind }));

    await expect(getSessionRelation({ prepare } as never, "session-1", "user-1")).resolves.toBe(
      "participant"
    );
    expect(bind).toHaveBeenCalledWith("session-1", "user-1");
  });
});
