import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuditEventStore } from "../../src/db/audit-event-store";
import type { SessionViewer } from "@open-inspect/shared";
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

  it("filters by team and action before pagination", async () => {
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
    const options = { limit: 1, cursor: null, teamId: "team_alpha", action: "team.updated" };
    const store = new AuditEventStore(sqlDatabase(env.DB));
    const first = await store.list(options);
    expect(first.rows.map(({ id }) => id)).toEqual(["b"]);
    const second = await store.list({ ...options, cursor: first.nextCursor });
    expect(second.rows.map(({ id }) => id)).toEqual(["a"]);
    expect(second).toMatchObject({ hasMore: false, nextCursor: null });
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
      visibilityScope: {
        viewer: {
          kind: "user",
          userId: "viewer",
          roleKey: "member",
          permissions: ["sessions.read"],
          suspended: false,
          memberships: new Map(),
        },
        mode: "on",
      },
    });
    expect(result.rows.map(({ id }) => id)).toEqual(["team-no-resource"]);
    expect(result).toMatchObject({ hasMore: false, nextCursor: null });
  });

  it("omits all HTTP decisions from scoped activity before pagination but preserves workspace audit", async () => {
    await env.DB.prepare(
      "INSERT INTO teams (id, slug, name, created_at, updated_at) VALUES ('team_alpha', 'alpha', 'Alpha', 1, 1)"
    ).run();
    await insertEvent("team-event", 1);
    await env.DB.prepare(
      "UPDATE authorization_audit_events SET team_id = 'team_alpha', resource_type = 'team', action = 'team.updated' WHERE id = 'team-event'"
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
      await insertEvent(id, index + 2);
      await env.DB.prepare(
        "UPDATE authorization_audit_events SET team_id = 'team_alpha', resource_type = 'http_route', resource_id = ?, action = 'authorization.request_denied' WHERE id = ?"
      )
        .bind(path, id)
        .run();
    }
    const store = new AuditEventStore(sqlDatabase(env.DB));
    const options = { limit: 1, cursor: null, teamId: "team_alpha" };
    const visibilityScope = {
      viewer: {
        kind: "user",
        userId: "viewer",
        roleKey: "member",
        permissions: ["sessions.read"],
        suspended: false,
        memberships: new Map(),
      } satisfies SessionViewer,
      mode: "on" as const,
    };
    const scoped = await store.list({ ...options, visibilityScope });
    expect(scoped.rows.map(({ id }) => id)).toEqual(["team-event"]);
    expect(scoped).toMatchObject({ hasMore: false, nextCursor: null });
    expect(
      (await store.list({ ...options, visibilityScope, action: "authorization.request_denied" }))
        .rows
    ).toEqual([]);
    const workspace = await store.list({ ...options, limit: 100 });
    expect(workspace.rows).toHaveLength(paths.length + 1);
    expect(
      workspace.rows.filter(({ resource_type }) => resource_type === "http_route")
    ).toHaveLength(paths.length);
  });

  it.each(["off", "shadow", "on"] as const)(
    "filters session evidence by current visibility before paging in %s, without owner break-glass",
    async (mode) => {
      await env.DB.prepare(
        "INSERT INTO users (id, created_at, updated_at) VALUES ('viewer', 1, 1), ('other', 1, 1)"
      ).run();
      await env.DB.prepare(
        "INSERT INTO teams (id, slug, name, created_at, updated_at) VALUES ('team_alpha', 'alpha', 'Alpha', 1, 1), ('team_beta', 'beta', 'Beta', 1, 1)"
      ).run();
      await env.DB.prepare(
        `INSERT INTO sessions (id, user_id, owner_team_id, visibility, created_at, updated_at)
       VALUES ('visible', 'other', 'team_alpha', 'workspace', 1, 1),
              ('private', 'other', 'team_alpha', 'private', 1, 1),
              ('shared', 'other', 'team_alpha', 'private', 1, 1),
              ('owned', 'viewer', 'team_alpha', 'private', 1, 1),
              ('moved', 'other', 'team_beta', 'team', 1, 1)`
      ).run();
      await env.DB.prepare(
        "INSERT INTO session_collaborators (session_id, user_id, added_by, created_at) VALUES ('shared', 'viewer', 'other', 1)"
      ).run();
      for (const [index, [id, resourceType, resourceId]] of [
        ["visible-event", "session", "visible"],
        ["shared-event", "session", "shared"],
        ["owned-event", "session", "owned"],
        ["team-event", "team", "team_alpha"],
        ["moved-event", "session", "moved"],
        ["private-event", "session", "private"],
        ["deleted-event", "session", "deleted"],
        ["private-http-event", "http_route", "/sessions/private/visibility"],
        ["cascade-http-event", "http_route", "/sessions/visible/scope"],
        ["team-http-event", "http_route", "/teams/team_alpha/members"],
      ].entries()) {
        await insertEvent(
          id,
          100 + index,
          id === "cascade-http-event"
            ? { shadowDenials: [{ sessionId: "private", reason: "private" }] }
            : {}
        );
        await env.DB.prepare(
          "UPDATE authorization_audit_events SET team_id = 'team_alpha', resource_type = ?, resource_id = ? WHERE id = ?"
        )
          .bind(resourceType, resourceId, id)
          .run();
      }
      const viewer: SessionViewer = {
        kind: "user",
        userId: "viewer",
        roleKey: "member",
        suspended: false,
        permissions: ["sessions.read"],
        memberships: new Map(),
      };
      const store = new AuditEventStore(sqlDatabase(env.DB));
      const options = {
        limit: 1,
        cursor: null,
        teamId: "team_alpha",
        visibilityScope: { viewer, mode },
      };
      const ids: string[] = [];
      let page = await store.list(options);
      while (true) {
        ids.push(...page.rows.map(({ id }) => id));
        if (!page.hasMore) break;
        page = await store.list({ ...options, cursor: page.nextCursor });
      }
      expect(ids).toEqual([
        ...(mode === "on" ? [] : ["moved-event"]),
        "team-event",
        "owned-event",
        "shared-event",
        "visible-event",
      ]);
      const ownerOptions = {
        ...options,
        limit: 100,
        visibilityScope: { viewer: { ...viewer, roleKey: "owner" as const }, mode },
      };
      const owner = await store.list(ownerOptions);
      expect(owner.rows.map(({ id }) => id)).not.toContain("private-event");
      expect(owner.rows.map(({ id }) => id)).toContain("moved-event");
      expect(
        (await store.list({ limit: 100, cursor: null, teamId: "team_alpha" })).rows
      ).toHaveLength(10);
    }
  );
});
