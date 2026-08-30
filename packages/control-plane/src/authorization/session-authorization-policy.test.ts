import { describe, expect, it } from "vitest";
import type { EffectiveAuthorization } from "@open-inspect/shared/rbac";
import { sessionPermissionScope, sessionRequiredRelation } from "./session-authorization-policy";

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

  it("owns the relation required by each session operation", () => {
    expect(sessionRequiredRelation("read")).toBe("access");
    expect(sessionRequiredRelation("collaborate")).toBe("access");
    expect(sessionRequiredRelation("delete")).toBe("creator");
    expect(sessionRequiredRelation("participants.manage")).toBe("creator");
  });
});
