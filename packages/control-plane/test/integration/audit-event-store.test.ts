import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuditEventStore } from "../../src/db/audit-event-store";
import { cleanD1Tables } from "./cleanup";
import { sqlDatabase } from "./helpers";

function insertEvent(id: string, occurredAt: number, metadata: Record<string, unknown> = {}) {
  return env.DB.prepare(
    `INSERT INTO authorization_audit_events
      (id, occurred_at, request_id, principal_kind, action, resource_type,
       reason_code, operation_result, metadata_json)
     VALUES (?, ?, ?, 'service', 'test.event', 'workspace', 'test', 'applied', ?)`
  )
    .bind(id, occurredAt, `request-${id}`, JSON.stringify({ legacy: true, ...metadata }))
    .run();
}

describe("AuditEventStore integration", () => {
  beforeEach(cleanD1Tables);
  afterEach(cleanD1Tables);

  it("lists newest-first and paginates timestamp ties without gaps", async () => {
    await insertEvent("event-a", 100, { sequence: "a" });
    await insertEvent("event-b", 100, { sequence: "b" });
    await insertEvent("event-c", 100, { sequence: "c" });
    await insertEvent("event-newest", 200, { sequence: "newest" });
    const store = new AuditEventStore(sqlDatabase(env.DB));

    const first = await store.list({ limit: 2, cursor: null });
    expect(first.rows.map((event) => event.id)).toEqual(["event-newest", "event-c"]);
    expect(first.hasMore).toBe(true);
    expect(first.nextCursor).toEqual({ occurredAt: 100, id: "event-c" });

    const second = await store.list({ limit: 2, cursor: first.nextCursor });
    expect(second.rows.map((event) => event.id)).toEqual(["event-b", "event-a"]);
    expect(second).toMatchObject({ hasMore: false, nextCursor: null });
  });
});
