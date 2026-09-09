import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanD1Tables } from "./cleanup";

const migration = () => {
  const entry = env.TEST_MIGRATIONS.find((candidate) => candidate.name.startsWith("0073"));
  if (!entry) throw new Error("Migration 0073 not found in TEST_MIGRATIONS");
  return entry;
};

beforeEach(cleanD1Tables);
afterEach(async () => {
  await cleanD1Tables();
  await env.DB.batch(migration().queries.map((query) => env.DB.prepare(query)));
});

describe("migration 0073: RBAC audit decision outcomes", () => {
  it("preserves structured events and admits denied and rejected decisions", async () => {
    await env.DB.batch([
      env.DB.prepare("DROP TRIGGER assign_default_role_after_user_insert"),
      env.DB.prepare(
        "ALTER TABLE authorization_audit_events RENAME TO authorization_audit_events_latest"
      ),
      env.DB.prepare(
        `CREATE TABLE authorization_audit_events (
          id TEXT PRIMARY KEY,
          occurred_at INTEGER NOT NULL,
          request_id TEXT NOT NULL,
          principal_kind TEXT NOT NULL,
          actor_user_id_snapshot TEXT,
          actor_service_snapshot TEXT,
          action TEXT NOT NULL,
          resource_type TEXT NOT NULL,
          resource_id TEXT,
          target_user_id_snapshot TEXT,
          reason_code TEXT NOT NULL,
          operation_result TEXT NOT NULL CHECK (operation_result IN ('applied', 'no_op')),
          metadata_json TEXT NOT NULL CHECK (json_type(metadata_json) = 'object')
        )`
      ),
      env.DB.prepare(
        `INSERT INTO authorization_audit_events
          (id, occurred_at, request_id, principal_kind, action, resource_type,
           reason_code, operation_result, metadata_json)
         VALUES ('existing', 1, 'existing', 'service', 'existing', 'workspace',
           'existing', 'applied', '{"legacy":true}')`
      ),
      env.DB.prepare("DROP TABLE authorization_audit_events_latest"),
    ]);

    await env.DB.batch(migration().queries.map((query) => env.DB.prepare(query)));

    expect(
      await env.DB.prepare(
        "SELECT operation_result, metadata_json FROM authorization_audit_events WHERE id = 'existing'"
      ).first()
    ).toEqual({ operation_result: "applied", metadata_json: '{"legacy":true}' });

    for (const outcome of ["denied", "rejected"]) {
      const metadata = JSON.stringify({
        schema: "authorization_decision.v1",
        httpMethod: "POST",
        httpPath: "/members",
        httpStatus: 403,
        requirements: [],
      });
      await expect(
        env.DB.prepare(
          `INSERT INTO authorization_audit_events
            (id, occurred_at, request_id, principal_kind, action, resource_type,
             reason_code, operation_result, metadata_json)
           VALUES (?, 2, ?, 'user', 'authorization.request_denied', 'http_route',
             ?, ?, ?)`
        )
          .bind(outcome, outcome, outcome, outcome, metadata)
          .run()
      ).resolves.toMatchObject({ meta: { changes: 1 } });
    }

    await env.DB.prepare(
      `INSERT INTO users
        (id, display_name, email, email_verified, avatar_url, created_at, updated_at)
       VALUES ('55555555555555555555555555555555', 'New User', NULL, 0, NULL, 500, 500)`
    ).run();
    expect(
      await env.DB.prepare(
        `SELECT operation_result FROM authorization_audit_events
         WHERE request_id = 'default-role:55555555555555555555555555555555'`
      ).first()
    ).toEqual({ operation_result: "applied" });
  });
});
