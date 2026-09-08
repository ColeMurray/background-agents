import { describe, expect, it } from "vitest";
import {
  BUILT_IN_ROLE_KEYS,
  BUILT_IN_ROLE_REGISTRY,
  PERMISSION_IDS,
  SCOPED_PERMISSION_PAIRS,
  effectiveAuthorizationSchema,
  hasScopedPermission,
  permissionsForBuiltInRole,
  resolveScopedPermission,
  replaceMemberRoleInputSchema,
  replaceMemberStatusInputSchema,
  roleReferenceSchema,
} from "./rbac";

describe("RBAC registry", () => {
  it("defines stable built-in role identities", () => {
    expect(BUILT_IN_ROLE_REGISTRY).toEqual({
      owner: {
        id: "role_builtin_owner",
        key: "owner",
      },
      administrator: {
        id: "role_builtin_administrator",
        key: "administrator",
      },
      member: {
        id: "role_builtin_member",
        key: "member",
      },
      viewer: {
        id: "role_builtin_viewer",
        key: "viewer",
      },
    });
    expect(BUILT_IN_ROLE_KEYS).toEqual(
      Object.values(BUILT_IN_ROLE_REGISTRY).map((role) => role.key)
    );
    expect(new Set(Object.values(BUILT_IN_ROLE_REGISTRY).map((role) => role.id)).size).toBe(
      BUILT_IN_ROLE_KEYS.length
    );
  });

  it("binds built-in role IDs and keys into one canonical identity", () => {
    expect(
      roleReferenceSchema.parse({ id: "role_builtin_owner", key: "owner", name: "Owner" })
    ).toEqual({ id: "role_builtin_owner", key: "owner", name: "Owner" });
    expect(
      roleReferenceSchema.parse({ id: "role_custom_reviewer", key: null, name: "Reviewer" })
    ).toEqual({ id: "role_custom_reviewer", key: null, name: "Reviewer" });

    expect(() =>
      roleReferenceSchema.parse({ id: "role_other", key: "owner", name: "Owner" })
    ).toThrow();
    expect(() =>
      roleReferenceSchema.parse({ id: "role_builtin_owner", key: null, name: "Custom" })
    ).toThrow();
    expect(() =>
      roleReferenceSchema.parse({ id: "role_builtin_member", key: "viewer", name: "Viewer" })
    ).toThrow();
  });

  it("contains unique, sorted permission identifiers", () => {
    expect(PERMISSION_IDS).toHaveLength(43);
    expect(new Set(PERMISSION_IDS).size).toBe(PERMISSION_IDS.length);
    expect(PERMISSION_IDS).toEqual([...PERMISSION_IDS].sort());
  });

  it("owns every any/own permission pair and resolves any before own", () => {
    const scopedPermissions = Object.values(SCOPED_PERMISSION_PAIRS).flatMap(({ any, own }) => [
      any,
      own,
    ]);
    expect(new Set(scopedPermissions)).toEqual(
      new Set(PERMISSION_IDS.filter((permission) => /\.(any|own)$/.test(permission)))
    );
    expect(
      resolveScopedPermission("automations.manage", [
        "automations.manage.own",
        "automations.manage.any",
      ])
    ).toBe("any");
    expect(resolveScopedPermission("automations.manage", ["automations.manage.own"])).toBe("own");
    expect(resolveScopedPermission("automations.manage", [])).toBeNull();
    expect(hasScopedPermission("automations.manage", ["automations.manage.any"], false)).toBe(true);
    expect(hasScopedPermission("automations.manage", ["automations.manage.own"], true)).toBe(true);
    expect(hasScopedPermission("automations.manage", ["automations.manage.own"], false)).toBe(
      false
    );
  });

  it("assigns every permission explicitly to Owner", () => {
    expect(permissionsForBuiltInRole("owner")).toEqual(PERMISSION_IDS);
  });

  it("reserves ownership transfer for Owner", () => {
    for (const role of BUILT_IN_ROLE_KEYS) {
      expect(permissionsForBuiltInRole(role).includes("workspace.transfer_ownership")).toBe(
        role === "owner"
      );
    }
  });

  it("grants Members workspace-wide session operations", () => {
    const permissions = permissionsForBuiltInRole("member");
    expect(permissions).toEqual(
      expect.arrayContaining([
        "sessions.read",
        "sessions.collaborate",
        "sessions.create",
        "sessions.lifecycle",
        "sessions.sandbox_access",
        "sessions.delete",
      ])
    );
  });

  it("grants workspace analytics to Members and Viewers", () => {
    expect(permissionsForBuiltInRole("member")).toContain("analytics.read");
    expect(permissionsForBuiltInRole("viewer")).toContain("analytics.read");
  });

  it("reserves workspace audit reads for Owner, Administrator, and eligible custom roles", () => {
    expect(permissionsForBuiltInRole("owner")).toContain("workspace.audit.read");
    expect(permissionsForBuiltInRole("administrator")).toContain("workspace.audit.read");
    expect(permissionsForBuiltInRole("member")).not.toContain("workspace.audit.read");
    expect(permissionsForBuiltInRole("viewer")).not.toContain("workspace.audit.read");
  });

  it("makes Member a superset of Viewer", () => {
    expect(permissionsForBuiltInRole("member")).toEqual(
      expect.arrayContaining(permissionsForBuiltInRole("viewer"))
    );
  });

  it("reserves personal profile management for Member and above", () => {
    expect(permissionsForBuiltInRole("member")).toContain("skill_profiles.manage_own");
    expect(permissionsForBuiltInRole("viewer")).not.toContain("skill_profiles.manage_own");
  });

  it("requires an assigned role and uses suspension timestamps in public contracts", () => {
    expect(
      effectiveAuthorizationSchema.parse({
        userId: "11111111111111111111111111111111",
        suspendedAt: null,
        role: { id: "role_builtin_member", key: "member", name: "Member" },
        permissions: [],
      })
    ).toMatchObject({ suspendedAt: null });
    expect(() =>
      effectiveAuthorizationSchema.parse({
        userId: "11111111111111111111111111111111",
        suspendedAt: null,
        role: null,
        permissions: [],
      })
    ).toThrow();
    expect(replaceMemberRoleInputSchema.parse({ roleId: "role_custom" })).toEqual({
      roleId: "role_custom",
    });
    expect(replaceMemberStatusInputSchema.parse({ suspended: true })).toEqual({ suspended: true });
    expect(() =>
      replaceMemberStatusInputSchema.parse({ suspended: true, suspendedAt: 123 })
    ).toThrow();
  });
});
