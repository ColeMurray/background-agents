import { describe, expect, it } from "vitest";
import {
  BUILT_IN_ROLE_KEYS,
  PERMISSION_IDS,
  createRoleInputSchema,
  normalizeRoleName,
  permissionsForBuiltInRole,
} from "./rbac";

describe("RBAC registry", () => {
  it("contains unique, sorted permission identifiers", () => {
    expect(PERMISSION_IDS).toHaveLength(52);
    expect(new Set(PERMISSION_IDS).size).toBe(PERMISSION_IDS.length);
    expect(PERMISSION_IDS).toEqual([...PERMISSION_IDS].sort());
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

  it("rejects ownership transfer in custom roles", () => {
    expect(() =>
      createRoleInputSchema.parse({
        name: "Operators",
        permissions: ["workspace.transfer_ownership"],
      })
    ).toThrow();
  });

  it("normalizes role names consistently", () => {
    expect(normalizeRoleName("  Release Managers  ")).toBe("release managers");
    expect(normalizeRoleName("OPERATORS")).toBe(normalizeRoleName("operators"));
  });

  it("rejects role names outside the deterministic normalization set", () => {
    expect(() =>
      createRoleInputSchema.parse({ name: "Release Managers!", permissions: [] })
    ).toThrow();
  });
});
