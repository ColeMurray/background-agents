import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("migration 0074: audit event list index", () => {
  it("creates the descending occurred-at and ID index", async () => {
    const indexes = await env.DB.prepare("PRAGMA index_list('authorization_audit_events')").all<{
      name: string;
    }>();
    expect(indexes.results.map((index) => index.name)).toContain(
      "idx_authorization_audit_events_occurred_at_id"
    );

    const columns = await env.DB.prepare(
      "PRAGMA index_xinfo('idx_authorization_audit_events_occurred_at_id')"
    ).all<{ name: string | null; desc: number; key: number }>();
    expect(columns.results.filter((column) => column.key === 1)).toMatchObject([
      { name: "occurred_at", desc: 1 },
      { name: "id", desc: 1 },
    ]);
  });

  it("uses the index to seek from a pagination cursor", async () => {
    const plan = await env.DB.prepare(
      `EXPLAIN QUERY PLAN
       SELECT * FROM authorization_audit_events
       WHERE (occurred_at, id) < (?, ?)
       ORDER BY occurred_at DESC, id DESC LIMIT ?`
    )
      .bind(100, "event-1", 25)
      .all<{ detail: string }>();

    expect(plan.results.map((step) => step.detail).join("\n")).toMatch(
      /SEARCH authorization_audit_events USING INDEX idx_authorization_audit_events_occurred_at_id/
    );
  });
});
