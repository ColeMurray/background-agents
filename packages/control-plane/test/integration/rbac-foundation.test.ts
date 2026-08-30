import { env } from "cloudflare:test";
import {
  BUILT_IN_ROLE_REGISTRY,
  PERMISSION_IDS,
  permissionsForBuiltInRole,
} from "@open-inspect/shared/rbac";
import { describe, expect, it } from "vitest";

describe("RBAC foundation migration", () => {
  it("seeds built-in roles without persisting their code-owned permissions", async () => {
    const roles = await env.DB.prepare(
      "SELECT id, key, name, description FROM roles WHERE is_system = 1 ORDER BY key"
    ).all<{ id: string; key: string; name: string; description: string }>();

    expect(roles.results).toEqual(
      Object.values(BUILT_IN_ROLE_REGISTRY).sort((left, right) => left.key.localeCompare(right.key))
    );

    expect(
      await env.DB.prepare(
        `SELECT COUNT(*) AS count FROM role_permissions rp
         JOIN roles r ON r.id = rp.role_id WHERE r.is_system = 1`
      ).first()
    ).toEqual({ count: 0 });
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
