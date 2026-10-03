import { describe, expect, it, vi } from "vitest";
import { emptyStatement } from "../router.test-support";
import { AnalyticsStore, scopePredicate } from "./analytics-store";
import type { SessionReadScope } from "./session-visibility";
import type { SqlResult } from "./sql-database";

function result(results: unknown[]): SqlResult {
  return { results, meta: { changes: 0 } };
}

const owner: SessionReadScope = {
  kind: "user",
  userId: "owner",
  roleKey: "owner",
  permissions: [],
  suspended: false,
  memberships: new Map(),
};

describe("AnalyticsStore session origins", () => {
  const store = new AnalyticsStore({ prepare: vi.fn(), batch: vi.fn() }, owner, "on");

  it("decodes session origins without merging users or sources", () => {
    expect(
      store.decodeSessionOrigins(
        result([
          { source: "user", user_key: "user-1", display_name: "Ada", sessions: 2 },
          { source: "user", user_key: "user-2", display_name: "Ada", sessions: 1 },
          { source: "slack-bot", user_key: "user-1", display_name: "Ada", sessions: 3 },
          { source: "agent", user_key: "old-login", display_name: "old-login", sessions: 1 },
          {
            source: "automation",
            user_key: "__unknown__",
            display_name: "Unknown user",
            sessions: 1,
          },
        ])
      )
    ).toEqual([
      { source: "user", userKey: "user-1", displayName: "Ada", sessions: 2 },
      { source: "user", userKey: "user-2", displayName: "Ada", sessions: 1 },
      { source: "slack-bot", userKey: "user-1", displayName: "Ada", sessions: 3 },
      { source: "agent", userKey: "old-login", displayName: "old-login", sessions: 1 },
      { source: "automation", userKey: "__unknown__", displayName: "Unknown user", sessions: 1 },
    ]);
    expect(store.decodeSessionOrigins(result([]))).toEqual([]);
  });

  it.each([
    { source: "invalid" },
    { source: null },
    { user_key: null },
    { display_name: undefined },
    { sessions: "2" },
  ])("rejects malformed session origin fields: %j", (overrides) => {
    expect(() =>
      store.decodeSessionOrigins(
        result([
          {
            source: "user",
            user_key: "user-1",
            display_name: "Ada",
            sessions: 2,
            ...overrides,
          },
        ])
      )
    ).toThrow("Invalid analytics session origin row");
  });

  it("filters origins before labeling users and binds visibility after the window and source", () => {
    const statement = emptyStatement();
    const bind = vi.spyOn(statement, "bind");
    const db = { prepare: vi.fn((_sql: string) => statement), batch: vi.fn() };
    const store = new AnalyticsStore(db, { ...owner, roleKey: "member" }, "on");

    store.prepareSessionOrigins({ startAt: 10, endAt: 20, scope: "agent" });
    const sql = db.prepare.mock.calls[0][0];
    expect(sql).toContain("WHERE s.created_at >= ? AND s.created_at < ?");
    expect(sql).toContain("AND s.spawn_source IN (?)");
    expect(sql).toContain("tm.team_id = s.owner_team_id AND tm.user_id = ?");
    expect(sql).not.toContain("s.visibility = 'private'");
    expect(sql).toContain(
      "COALESCE(s.user_id, NULLIF(s.scm_login, ''), '__unknown__') AS user_key"
    );
    expect(sql).toContain("FROM filtered_sessions s");
    expect(sql).toContain("JOIN user_labels u ON s.user_key = u.user_key");
    expect(sql).toContain("GROUP BY s.spawn_source, s.user_key, u.display_name");
    expect(sql).toContain("ORDER BY sessions DESC, source ASC, u.display_name ASC, s.user_key ASC");
    expect(bind).toHaveBeenLastCalledWith(10, 20, "agent", 0, "owner");

    store.prepareSessionOrigins({ startAt: 10, endAt: 20, scope: "all" });
    expect(db.prepare.mock.calls[1][0]).not.toContain("AND s.spawn_source IN");
    expect(bind).toHaveBeenLastCalledWith(10, 20, 0, "owner");
  });
});

describe("AnalyticsStore query boundaries", () => {
  it("uses the exact scoped populations and no predicate for all", () => {
    expect(scopePredicate("human", "s.spawn_source")).toEqual({
      sql: "AND s.spawn_source IN (?, ?, ?, ?)",
      binds: ["user", "slack-bot", "linear-bot", "github-bot"],
    });
    expect(scopePredicate("agent", "spawn_source")).toEqual({
      sql: "AND spawn_source IN (?)",
      binds: ["agent"],
    });
    expect(scopePredicate("automation", "s.spawn_source")).toEqual({
      sql: "AND s.spawn_source IN (?)",
      binds: ["automation"],
    });
    expect(scopePredicate("all", "s.spawn_source")).toEqual({ sql: "", binds: [] });
  });

  it("binds privileged private cost to the same window and scope without granting service access", () => {
    const statement = emptyStatement();
    const bind = vi.spyOn(statement, "bind");
    const db = { prepare: vi.fn((_sql: string) => statement), batch: vi.fn() };
    const filters = { startAt: 10, endAt: 20, scope: "agent" as const };

    new AnalyticsStore(db, owner, "on").prepareSummary(filters);
    expect(db.prepare.mock.calls[0][0]).toContain("private.spawn_source IN (?)");
    expect(bind).toHaveBeenLastCalledWith(10, 20, "agent", 10, 20, "agent", 1, "owner");

    const service = new AnalyticsStore(db, { kind: "service", teamId: null }, "on");
    service.prepareSummary(filters);
    expect(db.prepare.mock.calls[1][0]).toContain("NULL AS private_sessions_cost");
    expect(bind).toHaveBeenLastCalledWith(10, 20, "agent");
    expect(service.decodeSummary(result([])).privateSessionsCostUsd).toBeNull();

    new AnalyticsStore(db, { kind: "internal", reason: "audit all costs" }, "on").prepareSummary(
      filters
    );
    expect(db.prepare.mock.calls[2][0]).not.toContain("visibility");
    expect(bind).toHaveBeenLastCalledWith(10, 20, "agent");
  });

  it("qualifies billing source filters and prepares both provider queries with positional binds", () => {
    const statement = emptyStatement();
    const bind = vi.spyOn(statement, "bind");
    const db = { prepare: vi.fn((_sql: string) => statement), batch: vi.fn() };
    const store = new AnalyticsStore(db, { kind: "internal", reason: "verify billing" }, "on");

    store.prepareBilling({ startAt: 10, endAt: 20, scope: "agent" });
    expect(db.prepare.mock.calls[0][0]).toContain(
      "JOIN session_model_provider_auth a ON a.session_id = s.id AND a.auth_mode = 'provider_account'"
    );
    expect(db.prepare.mock.calls[0][0]).toContain("AND s.spawn_source IN (?)");
    expect(bind).toHaveBeenLastCalledWith(10, 20, "agent");

    store.prepareBilling({ startAt: 10, endAt: 20, scope: "all" });
    expect(db.prepare.mock.calls[1][0]).not.toContain("s.spawn_source");
    expect(bind).toHaveBeenLastCalledWith(10, 20);

    expect(store.prepareProviderBreakdown({ startAt: 10, endAt: 20, scope: "agent" })).toHaveLength(
      2
    );
    expect(db.prepare.mock.calls[2][0]).toContain("s.model AS key");
    expect(db.prepare.mock.calls[3][0]).toContain("JOIN session_model_provider_auth a");
    expect(bind.mock.calls.slice(-2)).toEqual([
      [10, 20, "agent"],
      [10, 20, "agent"],
    ]);
  });
});
