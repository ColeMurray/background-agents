import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuditEventStore, toAuditEvent } from "../../src/db/audit-event-store";
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

  it("filters by team through pagination without filtering actions", async () => {
    await env.DB.prepare(
      "INSERT INTO teams (id, slug, name, created_at, updated_at) VALUES ('team_alpha', 'alpha', 'Alpha', 1, 1), ('team_beta', 'beta', 'Beta', 1, 1)"
    ).run();
    for (const [id, teamId, action] of [
      ["a", "team_alpha", "team.updated"],
      ["b", "team_alpha", "team.updated"],
      ["c", "team_beta", "team.updated"],
      ["d", "team_alpha", "team.archived"],
    ]) {
      await insertEvent(id, 100);
      await env.DB.prepare(
        "UPDATE authorization_audit_events SET team_id = ?, action = ? WHERE id = ?"
      )
        .bind(teamId, action, id)
        .run();
    }
    const options = { limit: 1, cursor: null, teamId: "team_alpha" };
    const store = new AuditEventStore(sqlDatabase(env.DB));
    const first = await store.list(options);
    expect(first.rows.map(({ id, action }) => ({ id, action }))).toEqual([
      { id: "d", action: "team.archived" },
    ]);
    expect(first.hasMore).toBe(true);
    const second = await store.list({ ...options, cursor: first.nextCursor });
    expect(second.rows.map(({ id }) => id)).toEqual(["b"]);
    expect(second.hasMore).toBe(true);
    const third = await store.list({ ...options, cursor: second.nextCursor });
    expect(third.rows.map(({ id }) => id)).toEqual(["a"]);
    expect(third).toMatchObject({ hasMore: false, nextCursor: null });
  });

  it("keeps non-session team audit rows with a nullable resource ID", async () => {
    await env.DB.prepare(
      "INSERT INTO teams (id, slug, name, created_at, updated_at) VALUES ('team_alpha', 'alpha', 'Alpha', 1, 1)"
    ).run();
    await insertEvent("team-no-resource", 100);
    await env.DB.prepare(
      "UPDATE authorization_audit_events SET team_id = 'team_alpha', resource_type = 'team', resource_id = NULL WHERE id = 'team-no-resource'"
    ).run();
    const result = await new AuditEventStore(sqlDatabase(env.DB)).list({
      limit: 1,
      cursor: null,
      teamId: "team_alpha",
    });
    expect(result.rows.map(({ id }) => id)).toEqual(["team-no-resource"]);
    expect(toAuditEvent(result.rows[0]).resourceId).toBeNull();
    expect(result).toMatchObject({ hasMore: false, nextCursor: null });
  });

  it("retains HTTP decisions and private-session evidence in team-filtered workspace audit", async () => {
    await env.DB.prepare(
      "INSERT INTO teams (id, slug, name, created_at, updated_at) VALUES ('team_alpha', 'alpha', 'Alpha', 1, 1)"
    ).run();
    await insertEvent("team-event", 1);
    await env.DB.prepare(
      "UPDATE authorization_audit_events SET team_id = 'team_alpha', resource_type = 'team', action = 'team.updated' WHERE id = 'team-event'"
    ).run();
    const historicalMetadata = {
      before: {},
      requested: {},
      after: {
        teamId: "team_alpha",
        userId: "other",
        role: "member",
        source: "manual",
        createdAt: 1,
        displayName: "Ada",
        email: "historical@example.com",
        avatarUrl: "https://example.com/ada.png",
      },
    };
    await insertEvent("historical-membership", 1, historicalMetadata);
    await env.DB.prepare(
      "UPDATE authorization_audit_events SET team_id = 'team_alpha', resource_type = 'team', action = 'team.member_added' WHERE id = 'historical-membership'"
    ).run();
    await env.DB.prepare(
      "INSERT INTO users (id, created_at, updated_at) VALUES ('other', 1, 1)"
    ).run();
    await env.DB.prepare(
      "INSERT INTO sessions (id, user_id, owner_team_id, visibility, created_at, updated_at) VALUES ('private', 'other', 'team_alpha', 'private', 1, 1)"
    ).run();
    const privateMetadata = {
      before: { title: "Historical private title", visibility: "workspace" },
      after: { visibility: "private" },
    };
    await insertEvent("private-event", 1, privateMetadata);
    await env.DB.prepare(
      "UPDATE authorization_audit_events SET team_id = 'team_alpha', resource_type = 'session', resource_id = 'private', action = 'session.visibility_changed' WHERE id = 'private-event'"
    ).run();
    const paths = [
      "/sessions",
      "/sessions/private/scope",
      "/teams/team_alpha/members",
      "/repos",
      "/future/alias",
      null,
    ];
    for (const [index, path] of paths.entries()) {
      const id = `http-${index}`;
      await insertEvent(id, index + 2, {
        shadowDenials: [{ sessionId: "private", reason: "private" }],
      });
      await env.DB.prepare(
        "UPDATE authorization_audit_events SET team_id = 'team_alpha', resource_type = 'http_route', resource_id = ?, action = 'authorization.request_denied' WHERE id = ?"
      )
        .bind(path, id)
        .run();
    }
    const store = new AuditEventStore(sqlDatabase(env.DB));
    const workspace = await store.list({ limit: 100, cursor: null, teamId: "team_alpha" });
    const events = workspace.rows.map(toAuditEvent);
    expect(events).toHaveLength(paths.length + 3);
    const httpEvents = events.filter(({ resourceType }) => resourceType === "http_route");
    expect(httpEvents.map(({ resourceId }) => resourceId)).toEqual([...paths].reverse());
    for (const event of httpEvents) {
      expect(event.action).toBe("authorization.request_denied");
      expect(event.metadata).toEqual({
        legacy: true,
        shadowDenials: [{ sessionId: "private", reason: "private" }],
      });
    }
    expect(events.find(({ id }) => id === "private-event")).toMatchObject({
      action: "session.visibility_changed",
      resourceType: "session",
      resourceId: "private",
      metadata: { legacy: true, ...privateMetadata },
    });
    expect(events.find(({ id }) => id === "historical-membership")?.metadata).toEqual({
      legacy: true,
      ...historicalMetadata,
    });
  });
});
