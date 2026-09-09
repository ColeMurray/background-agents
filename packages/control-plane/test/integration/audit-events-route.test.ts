import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanD1Tables } from "./cleanup";
import { serviceFetch } from "./helpers";

const BROWSER_USER_ID = "11111111111111111111111111111111";

async function assignRole(roleId: string): Promise<void> {
  await env.DB.prepare("UPDATE user_role_assignments SET role_id = ? WHERE user_id = ?")
    .bind(roleId, BROWSER_USER_ID)
    .run();
}

describe("GET /audit-events", () => {
  beforeEach(cleanD1Tables);
  afterEach(cleanD1Tables);

  it("allows Owner, Administrator, and a granted custom role but denies Member and Viewer", async () => {
    expect((await serviceFetch("https://cp.test/audit-events")).status).toBe(200);

    await assignRole("role_builtin_administrator");
    expect((await serviceFetch("https://cp.test/audit-events")).status).toBe(200);

    await assignRole("role_builtin_member");
    expect((await serviceFetch("https://cp.test/audit-events")).status).toBe(403);

    await assignRole("role_builtin_viewer");
    expect((await serviceFetch("https://cp.test/audit-events")).status).toBe(403);

    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO roles (id, key, name, normalized_name, description, is_system)
         VALUES ('role_custom_auditor', NULL, 'Auditor', 'auditor', NULL, 0)`
      ),
      env.DB.prepare(
        `INSERT INTO role_permissions (role_id, permission_id)
         VALUES ('role_custom_auditor', 'workspace.audit.read')`
      ),
    ]);
    await assignRole("role_custom_auditor");
    expect((await serviceFetch("https://cp.test/audit-events")).status).toBe(200);
  });

  it("uses strict query parsing, defaults to 25, caps at 100, and prevents caching", async () => {
    await env.DB.batch(
      Array.from({ length: 26 }, (_, index) =>
        env.DB.prepare(
          `INSERT INTO authorization_audit_events
            (id, occurred_at, request_id, principal_kind, action, resource_type,
             reason_code, operation_result, metadata_json)
           VALUES (?, ?, ?, 'service', 'test.event', 'workspace', 'test', 'applied', '{"legacy":true}')`
        ).bind(`event-${String(index).padStart(2, "0")}`, index, `request-${index}`)
      )
    );
    const response = await serviceFetch("https://cp.test/audit-events");
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    const body = await response.json<{ events: unknown[]; hasMore: boolean; nextCursor: string }>();
    expect(body).toMatchObject({
      hasMore: true,
      nextCursor: expect.any(String),
    });
    expect(body.events).toHaveLength(25);
    expect((await serviceFetch("https://cp.test/audit-events?limit=100")).status).toBe(200);

    for (const query of [
      "limit=0",
      "limit=101",
      "limit=1.5",
      "limit=1e2",
      "limit=1&limit=2",
      "cursor=",
      "cursor=not-a-cursor",
      "cursor=one&cursor=two",
    ]) {
      const invalid = await serviceFetch(`https://cp.test/audit-events?${query}`);
      expect(invalid.status, query).toBe(400);
      expect(invalid.headers.get("Cache-Control"), query).toBe("private, no-store");
    }
  });

  it("does not audit successful reads and records denied read authorization", async () => {
    expect((await serviceFetch("https://cp.test/audit-events")).status).toBe(200);
    expect(
      await env.DB.prepare(
        `SELECT COUNT(*) AS count FROM authorization_audit_events
         WHERE action = 'authorization.request_allowed' AND resource_id = '/audit-events'`
      ).first()
    ).toEqual({ count: 0 });

    await assignRole("role_builtin_member");
    expect((await serviceFetch("https://cp.test/audit-events")).status).toBe(403);
    const denied = await env.DB.prepare(
      `SELECT principal_kind, action, resource_type, resource_id, reason_code,
              operation_result, metadata_json
       FROM authorization_audit_events
       WHERE action = 'authorization.request_denied' AND resource_id = '/audit-events'`
    ).first<{
      principal_kind: string;
      action: string;
      resource_type: string;
      resource_id: string;
      reason_code: string;
      operation_result: string;
      metadata_json: string;
    }>();
    expect(denied).toMatchObject({
      principal_kind: "user",
      action: "authorization.request_denied",
      resource_type: "http_route",
      resource_id: "/audit-events",
      reason_code: "permission_required",
      operation_result: "denied",
    });
    expect(JSON.parse(denied!.metadata_json)).toMatchObject({
      httpMethod: "GET",
      httpPath: "/audit-events",
      requiredPermission: "workspace.audit.read",
    });
  });
});
