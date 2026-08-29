import { env } from "cloudflare:test";
import { PERMISSION_IDS, permissionsForBuiltInRole } from "@open-inspect/shared/rbac";
import { describe, expect, it } from "vitest";

describe("RBAC foundation migration", () => {
  it("seeds the built-in roles and exact permission projections", async () => {
    const roles = await env.DB.prepare(
      "SELECT id, key FROM roles WHERE is_system = 1 ORDER BY key"
    ).all<{ id: string; key: "administrator" | "member" | "owner" | "viewer" }>();

    expect(roles.results.map((role) => role.key)).toEqual([
      "administrator",
      "member",
      "owner",
      "viewer",
    ]);

    for (const role of roles.results) {
      const permissions = await env.DB.prepare(
        "SELECT permission_id FROM role_permissions WHERE role_id = ? ORDER BY permission_id"
      )
        .bind(role.id)
        .all<{ permission_id: string }>();
      expect(permissions.results.map((row) => row.permission_id)).toEqual(
        permissionsForBuiltInRole(role.key)
      );
    }

    expect(permissionsForBuiltInRole("owner")).toHaveLength(PERMISSION_IDS.length);
  });

  it("records the completed assignment migration boundary", async () => {
    const marker = await env.DB.prepare(
      "SELECT singleton, assignments_completed_at FROM rbac_migration_state WHERE singleton = 1"
    ).first<{ singleton: number; assignments_completed_at: number }>();

    expect(marker?.singleton).toBe(1);
    expect(marker?.assignments_completed_at).toBeGreaterThan(0);
  });
});
