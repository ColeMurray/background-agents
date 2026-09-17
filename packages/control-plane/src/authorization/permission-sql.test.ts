import { describe, expect, it } from "vitest";
import { rolePermissionPredicate } from "./permission-sql";

describe("rolePermissionPredicate", () => {
  it("never grants ownership transfer through a custom role", () => {
    const predicate = rolePermissionPredicate("workspace.transfer_ownership");

    expect(predicate.sql).not.toContain("role_permissions");
    expect(predicate.values).toEqual(["owner"]);
  });
});
