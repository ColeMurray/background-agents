import { describe, expect, it } from "vitest";
import {
  BUILT_IN_ROLE_KEYS,
  BUILT_IN_ROLE_REGISTRY,
  PERMISSION_IDS,
  SCOPED_PERMISSION_PAIRS,
  effectiveAuthorizationSchema,
  permissionsForBuiltInRole,
  resolveScopedPermission,
  replaceMemberRoleInputSchema,
  replaceMemberStatusInputSchema,
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

  it("contains unique, sorted permission identifiers", () => {
    expect(PERMISSION_IDS).toHaveLength(49);
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
      resolveScopedPermission("sessions.read", ["sessions.read.own", "sessions.read.any"])
    ).toBe("any");
    expect(resolveScopedPermission("sessions.read", ["sessions.read.own"])).toBe("own");
    expect(resolveScopedPermission("sessions.read", [])).toBeNull();
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

  it("preserves open read and collaboration for built-in Members", () => {
    const permissions = permissionsForBuiltInRole("member");
    expect(permissions).toContain("sessions.read.any");
    expect(permissions).toContain("sessions.collaborate.any");
    expect(permissions).not.toContain("sessions.delete.any");
    expect(permissions).not.toContain("sessions.participants.manage.any");
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
