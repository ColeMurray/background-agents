import { beforeEach, describe, expect, it } from "vitest";
import type { HarnessId } from "@open-inspect/shared/harnesses";
import type { SpawnSource } from "@open-inspect/shared/types/sessions";
import { SessionIndexStore } from "./session-index";
import type { SessionEntry } from "./session-index";

type SessionRow = {
  id: string;
  title: string | null;
  repo_owner: string | null;
  repo_name: string | null;
  harness: HarnessId;
  model: string;
  reasoning_effort: string | null;
  base_branch: string | null;
  status: string;
  parent_session_id: string | null;
  root_session_id: string;
  spawn_source: SpawnSource;
  spawn_depth: number;
  automation_id: string | null;
  automation_run_id: string | null;
  scm_login: string | null;
  user_id: string | null;
  total_cost: number;
  active_duration_ms: number;
  message_count: number;
  pr_count: number;
  input_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  environment_id: string | null;
  created_at: number;
  updated_at: number;
};

type SessionRepositoryRow = {
  session_id: string;
  position: number;
  repo_owner: string;
  repo_name: string;
  repo_id: number | null;
  base_branch: string;
};

const QUERY_PATTERNS = {
  INSERT_SESSION: /^INSERT INTO sessions/,
  INSERT_SESSION_REPO: /^INSERT INTO session_repositories/,
  SELECT_SESSION_REPOS: /^SELECT \* FROM session_repositories WHERE session_id IN/,
  SELECT_PR_SUMMARIES: /FROM session_pull_requests WHERE session_id IN/,
  DELETE_SESSION_REPOS: /^DELETE FROM session_repositories WHERE session_id = \?$/,
  SELECT_BY_ID: /^SELECT \* FROM sessions WHERE id = \?$/,
  SELECT_EXISTS: /^SELECT 1 AS ok FROM sessions WHERE id = \?$/,
  SELECT_COUNT: /^SELECT COUNT\(\*\) as count FROM sessions\b/,
  SELECT_LIST: /^SELECT \* FROM sessions\b.*ORDER BY updated_at DESC, id DESC LIMIT/,
  UPDATE_STATUS: /^UPDATE sessions SET status = \?/,
  UPDATE_TITLE:
    /^UPDATE sessions SET title = \?, updated_at = MAX\(updated_at, \?\) WHERE id = \?$/,
  DELETE_SESSION: /^DELETE FROM sessions WHERE id = \?$/,
} as const;

function normalizeQuery(query: string): string {
  return query.replace(/\s+/g, " ").trim();
}

class FakeD1Database {
  private rows = new Map<string, SessionRow>();
  readonly repositoryRows: SessionRepositoryRow[] = [];
  readonly preparedQueries: string[] = [];

  prepare(query: string) {
    this.preparedQueries.push(normalizeQuery(query));
    return new FakePreparedStatement(this, query);
  }

  updateRawSessionRow(id: string, updates: Record<string, unknown>) {
    const row = this.rows.get(id);
    if (!row) throw new Error(`Missing session row: ${id}`);
    Object.assign(row as Record<string, unknown>, updates);
  }

  async batch(statements: FakePreparedStatement[]) {
    const results = [];
    for (const statement of statements) {
      results.push(await statement.run());
    }
    return results;
  }

  first(query: string, args: unknown[]) {
    const normalized = normalizeQuery(query);

    if (QUERY_PATTERNS.SELECT_BY_ID.test(normalized)) {
      const id = args[0] as string;
      return this.rows.get(id) ?? null;
    }

    if (QUERY_PATTERNS.SELECT_EXISTS.test(normalized)) {
      const id = args[0] as string;
      return this.rows.has(id) ? { ok: 1 } : null;
    }

    throw new Error(`Unexpected first() query: ${query}`);
  }

  all(query: string, args: unknown[]) {
    const normalized = normalizeQuery(query);

    if (QUERY_PATTERNS.SELECT_LIST.test(normalized)) {
      // Parse WHERE conditions and LIMIT/OFFSET from args
      const whereArgs: unknown[] = [];
      let limit = 50;
      let offset = 0;

      // The last two args are always limit and offset
      const allArgs = [...args];
      offset = allArgs.pop() as number;
      limit = allArgs.pop() as number;
      whereArgs.push(...allArgs);

      const filtered = this.applyWhereConditions(normalized, whereArgs);
      const sorted = filtered.sort((a, b) => b.updated_at - a.updated_at);
      const paged = sorted.slice(offset, offset + limit);
      return paged;
    }

    if (QUERY_PATTERNS.SELECT_SESSION_REPOS.test(normalized)) {
      const ids = new Set(args as string[]);
      return this.repositoryRows
        .filter((r) => ids.has(r.session_id))
        .sort((a, b) => a.session_id.localeCompare(b.session_id) || a.position - b.position);
    }

    // PR summaries attach only for sessions with records; this fake has none.
    if (QUERY_PATTERNS.SELECT_PR_SUMMARIES.test(normalized)) {
      return [];
    }

    throw new Error(`Unexpected all() query: ${query}`);
  }

  run(query: string, args: unknown[]) {
    const normalized = normalizeQuery(query);

    if (QUERY_PATTERNS.INSERT_SESSION.test(normalized)) {
      if (this.rows.has(args[0] as string))
        throw new Error("UNIQUE constraint failed: sessions.id");
      const [
        id,
        title,
        repoOwner,
        repoName,
        harness,
        model,
        reasoningEffort,
        baseBranch,
        status,
        parentSessionId,
        rootParentId,
        topLevelRootId,
        parentRootLookupId,
        spawnSource,
        spawnDepth,
        automationId,
        automationRunId,
        scmLogin,
        userId,
        environmentId,
        createdAt,
        updatedAt,
      ] = args as [
        string,
        string | null,
        string | null,
        string | null,
        HarnessId,
        string,
        string | null,
        string | null,
        string,
        string | null,
        string | null,
        string,
        string | null,
        "user" | "agent" | "automation",
        number,
        string | null,
        string | null,
        string | null,
        string | null,
        string | null,
        number,
        number,
      ];
      // ON CONFLICT DO NOTHING — skip if exists
      const inserted = !this.rows.has(id);
      if (inserted) {
        const rootSessionId = rootParentId
          ? (this.rows.get(parentRootLookupId!)?.root_session_id ?? id)
          : topLevelRootId;
        this.rows.set(id, {
          id,
          title,
          repo_owner: repoOwner,
          repo_name: repoName,
          harness,
          model,
          reasoning_effort: reasoningEffort,
          base_branch: baseBranch,
          status,
          parent_session_id: parentSessionId,
          root_session_id: rootSessionId,
          spawn_source: spawnSource,
          spawn_depth: spawnDepth,
          automation_id: automationId,
          automation_run_id: automationRunId,
          scm_login: scmLogin,
          user_id: userId,
          total_cost: 0,
          active_duration_ms: 0,
          message_count: 0,
          pr_count: 0,
          input_tokens: 0,
          output_tokens: 0,
          reasoning_tokens: 0,
          cache_read_tokens: 0,
          cache_write_tokens: 0,
          environment_id: environmentId,
          created_at: createdAt,
          updated_at: updatedAt,
        });
      }
      return { meta: { changes: inserted ? 1 : 0 } };
    }

    if (QUERY_PATTERNS.UPDATE_STATUS.test(normalized)) {
      const [status, updatedAt, id] = args as [string, number, string];
      const row = this.rows.get(id);
      if (row) {
        row.status = status;
        row.updated_at = updatedAt;
        return { meta: { changes: 1 } };
      }
      return { meta: { changes: 0 } };
    }

    if (QUERY_PATTERNS.UPDATE_TITLE.test(normalized)) {
      const [title, updatedAt, id] = args as [string, number, string];
      const row = this.rows.get(id);
      if (row) {
        row.title = title;
        row.updated_at = Math.max(row.updated_at, updatedAt);
        return { meta: { changes: 1 } };
      }
      return { meta: { changes: 0 } };
    }

    if (QUERY_PATTERNS.INSERT_SESSION_REPO.test(normalized)) {
      const [sessionId, position, repoOwner, repoName, repoId, baseBranch] = args as [
        string,
        number,
        string,
        string,
        number | null,
        string,
      ];
      this.repositoryRows.push({
        session_id: sessionId,
        position,
        repo_owner: repoOwner,
        repo_name: repoName,
        repo_id: repoId,
        base_branch: baseBranch,
      });
      return { meta: { changes: 1 } };
    }

    if (QUERY_PATTERNS.DELETE_SESSION_REPOS.test(normalized)) {
      const id = args[0] as string;
      const before = this.repositoryRows.length;
      for (let i = this.repositoryRows.length - 1; i >= 0; i--) {
        if (this.repositoryRows[i].session_id === id) this.repositoryRows.splice(i, 1);
      }
      return { meta: { changes: before - this.repositoryRows.length } };
    }

    if (QUERY_PATTERNS.DELETE_SESSION.test(normalized)) {
      const id = args[0] as string;
      const existed = this.rows.delete(id);
      return { meta: { changes: existed ? 1 : 0 } };
    }

    throw new Error(`Unexpected mutation query: ${query}`);
  }

  private applyWhereConditions(query: string, args: unknown[]): SessionRow[] {
    let rows = Array.from(this.rows.values());
    let argIdx = 0;

    // Parse WHERE conditions
    const whereMatch = query.match(/WHERE (.+?)(?:ORDER|LIMIT|$)/);
    if (whereMatch) {
      const conditions = whereMatch[1].trim();

      if (conditions.includes("status = ?")) {
        const statusVal = args[argIdx++] as string;
        rows = rows.filter((r) => r.status === statusVal);
      }

      if (conditions.includes("status != ?")) {
        const statusVal = args[argIdx++] as string;
        rows = rows.filter((r) => r.status !== statusVal);
      }

      if (conditions.includes("automation_id IS NULL")) {
        rows = rows.filter(
          (row) => row.automation_id === null && row.spawn_source !== "automation"
        );
      }

      const userIdMatch = conditions.match(/user_id IN \(([^)]+)\)/);
      if (userIdMatch) {
        const userIdCount = userIdMatch[1].split(",").length;
        const userIds = new Set(args.slice(argIdx, argIdx + userIdCount) as string[]);
        argIdx += userIdCount;
        rows = rows.filter((r) => r.user_id !== null && userIds.has(r.user_id));
      }
    }

    return rows;
  }
}

class FakePreparedStatement {
  private bound: unknown[] = [];

  constructor(
    private db: FakeD1Database,
    private query: string
  ) {}

  bind(...args: unknown[]) {
    this.bound = args;
    return this;
  }

  async first<T>() {
    return this.db.first(this.query, this.bound) as T | null;
  }

  async all<T>() {
    return { results: this.db.all(this.query, this.bound) as T[] };
  }

  async run() {
    return this.db.run(this.query, this.bound);
  }
}

function makeSession(overrides: Partial<SessionEntry> = {}): SessionEntry {
  return {
    id: "test-id",
    title: "Test Session",
    repoOwner: "owner",
    repoName: "repo",
    model: "anthropic/claude-haiku-4-5",
    reasoningEffort: null,
    baseBranch: null,
    status: "created",
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  };
}

describe("SessionIndexStore", () => {
  let db: FakeD1Database;
  let store: SessionIndexStore;

  beforeEach(() => {
    db = new FakeD1Database();
    store = new SessionIndexStore(db as unknown as D1Database);
  });

  describe("create", () => {
    it("inserts a new session", async () => {
      const session = makeSession();
      await store.create(session);

      const result = await store.get("test-id");
      expect(result).toEqual({
        ...session,
        // Defaults applied for missing optional fields
        harness: "opencode",
        parentSessionId: null,
        spawnSource: "user",
        spawnDepth: 0,
        automationId: null,
        automationRunId: null,
        scmLogin: null,
        userId: null,
        totalCost: 0,
        activeDurationMs: 0,
        messageCount: 0,
        prCount: 0,
        inputTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        environmentId: null,
      });
    });

    it("trims and lowercases repoOwner and repoName", async () => {
      const session = makeSession({ repoOwner: "  Owner  ", repoName: "  Repo  " });
      await store.create(session);

      const result = await store.get("test-id");
      expect(result?.repoOwner).toBe("owner");
      expect(result?.repoName).toBe("repo");
    });

    it("stores blank repoOwner and repoName as null", async () => {
      const session = makeSession({ repoOwner: "   ", repoName: "", baseBranch: "main" });
      await store.create(session);

      const result = await store.get("test-id");
      expect(result?.repoOwner).toBeNull();
      expect(result?.repoName).toBeNull();
      expect(result?.baseBranch).toBeNull();
    });

    it("rejects partial repository fields", async () => {
      await expect(store.create(makeSession({ repoName: null }))).rejects.toThrow(
        "Session repository must include repoOwner and repoName together"
      );
    });

    it("rejects invalid or duplicate provider auth before writing the session batch", async () => {
      await expect(
        store.create(
          makeSession({
            providerAuth: [
              {
                provider: "other" as never,
                authMode: "api_key",
                selectionSource: "explicit",
              },
            ],
          })
        )
      ).rejects.toThrow("Unsupported model provider");
      await expect(
        store.create(
          makeSession({
            providerAuth: [
              { provider: "openai", authMode: "api_key", selectionSource: "explicit" },
              { provider: "openai", authMode: "api_key", selectionSource: "explicit" },
            ],
          })
        )
      ).rejects.toThrow("Duplicate provider auth: openai");
      await expect(
        store.create(
          makeSession({
            providerAuth: [
              { provider: "openai", authMode: "api_key", selectionSource: "explicit" },
            ],
          })
        )
      ).rejects.toThrow("must include every subscription provider");
      expect(await store.exists("test-id")).toBe(false);
    });

    it("throws instead of silently skipping a duplicate insert", async () => {
      const session = makeSession();
      await store.create(session);

      await expect(store.create(makeSession({ title: "Different Title" }))).rejects.toThrow(
        "UNIQUE constraint failed"
      );

      const result = await store.get("test-id");
      expect(result?.title).toBe("Test Session");
    });
  });

  describe("get", () => {
    it("returns session when found", async () => {
      await store.create(makeSession());
      const result = await store.get("test-id");
      expect(result).not.toBeNull();
      expect(result?.id).toBe("test-id");
    });

    it.each([
      ["status", { status: "unknown" }],
      ["spawn source", { spawn_source: "cron" }],
    ])("rejects a persisted session row with invalid %s", async (_field, updates) => {
      await store.create(makeSession());
      db.updateRawSessionRow("test-id", updates);

      await expect(store.get("test-id")).rejects.toThrow("Malformed persisted session index row");
    });

    it("rejects a partial persisted session row", async () => {
      await store.create(makeSession());
      db.updateRawSessionRow("test-id", { model: undefined });

      await expect(store.get("test-id")).rejects.toThrow("Malformed persisted session index row");
    });

    it("returns null when not found", async () => {
      const result = await store.get("nonexistent");
      expect(result).toBeNull();
    });
  });

  describe("exists", () => {
    it("returns whether the session exists without loading it", async () => {
      await store.create(makeSession());

      await expect(store.exists("test-id")).resolves.toBe(true);
      await expect(store.exists("nonexistent")).resolves.toBe(false);
    });
  });

  describe("list", () => {
    it("returns sessions sorted by updatedAt descending", async () => {
      await store.create(makeSession({ id: "old", updatedAt: 1000 }));
      await store.create(makeSession({ id: "new", updatedAt: 3000 }));
      await store.create(makeSession({ id: "mid", updatedAt: 2000 }));

      const result = await store.list();
      expect(result.sessions.map((s) => s.id)).toEqual(["new", "mid", "old"]);
      expect(result.hasMore).toBe(false);
    });

    it("filters by status", async () => {
      await store.create(makeSession({ id: "a", status: "active" }));
      await store.create(makeSession({ id: "b", status: "archived" }));

      const result = await store.list({ status: "active" });
      expect(result.sessions).toHaveLength(1);
      expect(result.sessions[0].id).toBe("a");
    });

    it("filters by excludeStatus", async () => {
      await store.create(makeSession({ id: "a", status: "active", updatedAt: 2000 }));
      await store.create(makeSession({ id: "b", status: "archived", updatedAt: 1000 }));
      await store.create(makeSession({ id: "c", status: "created", updatedAt: 3000 }));

      const result = await store.list({ excludeStatus: "archived" });
      expect(result.sessions).toHaveLength(2);
      expect(result.sessions.map((s) => s.id)).toEqual(["c", "a"]);
    });

    it("filters by creator user ids", async () => {
      await store.create(makeSession({ id: "alice-old", userId: "alice", updatedAt: 1000 }));
      await store.create(makeSession({ id: "bob", userId: "bob", updatedAt: 3000 }));
      await store.create(makeSession({ id: "alice-new", userId: "alice", updatedAt: 4000 }));
      await store.create(makeSession({ id: "historical", userId: null, updatedAt: 5000 }));

      const result = await store.list({ createdByUserIds: ["alice"] });

      expect(result.sessions.map((s) => s.id)).toEqual(["alice-new", "alice-old"]);
      expect(result.hasMore).toBe(false);
    });

    it("filters automation lineage before pagination", async () => {
      await store.create(makeSession({ id: "manual-new", spawnSource: "user", updatedAt: 4000 }));
      await store.create(
        makeSession({
          id: "automation",
          spawnSource: "automation",
          automationId: "automation-1",
          automationRunId: "run-1",
          updatedAt: 3000,
        })
      );
      await store.create(
        makeSession({
          id: "automation-child",
          parentSessionId: "automation",
          spawnSource: "agent",
          automationId: "automation-1",
          automationRunId: "run-1",
          updatedAt: 3500,
        })
      );
      await store.create(makeSession({ id: "manual-old", spawnSource: "user", updatedAt: 2000 }));
      await store.delete("automation");

      const result = await store.list({ excludeAutomationLineage: true, limit: 2 });

      expect(result.sessions.map((session) => session.id)).toEqual(["manual-new", "manual-old"]);
      expect(result.hasMore).toBe(false);
    });

    it("supports multiple creator user ids", async () => {
      await store.create(makeSession({ id: "alice", userId: "alice", updatedAt: 1000 }));
      await store.create(makeSession({ id: "bob", userId: "bob", updatedAt: 3000 }));
      await store.create(makeSession({ id: "carol", userId: "carol", updatedAt: 4000 }));

      const result = await store.list({ createdByUserIds: ["alice", "bob"] });

      expect(result.sessions.map((s) => s.id)).toEqual(["bob", "alice"]);
    });

    it("supports pagination with limit and offset", async () => {
      for (let i = 0; i < 5; i++) {
        await store.create(makeSession({ id: `s${i}`, updatedAt: i * 1000 }));
      }

      const page1 = await store.list({ limit: 2, offset: 0 });
      expect(page1.sessions).toHaveLength(2);
      expect(page1.hasMore).toBe(true);

      const page2 = await store.list({ limit: 2, offset: 2 });
      expect(page2.sessions).toHaveLength(2);
      expect(page2.hasMore).toBe(true);

      const page3 = await store.list({ limit: 2, offset: 4 });
      expect(page3.sessions).toHaveLength(1);
      expect(page3.hasMore).toBe(false);
    });

    it("derives hasMore without counting", async () => {
      for (let i = 0; i < 3; i++) {
        await store.create(makeSession({ id: `s${i}`, updatedAt: i * 1000 }));
      }
      db.preparedQueries.length = 0;

      const result = await store.list({ limit: 2 });

      expect(result.sessions.map((s) => s.id)).toEqual(["s2", "s1"]);
      expect(result.hasMore).toBe(true);
      expect(db.preparedQueries.some((query) => QUERY_PATTERNS.SELECT_COUNT.test(query))).toBe(
        false
      );
    });
  });

  describe("updateStatus", () => {
    it("updates status of an existing session", async () => {
      await store.create(makeSession());
      const updated = await store.updateStatus("test-id", "archived");
      expect(updated).toBe(true);

      const session = await store.get("test-id");
      expect(session?.status).toBe("archived");
    });

    it("returns false when session not found", async () => {
      const updated = await store.updateStatus("nonexistent", "archived");
      expect(updated).toBe(false);
    });
  });

  describe("updateTitle", () => {
    it("updates the title when the write is current", async () => {
      await store.create(makeSession({ updatedAt: 1000 }));

      const updated = await store.updateTitle("test-id", "Generated Title", 2000);
      expect(updated).toBe(true);

      const session = await store.get("test-id");
      expect(session?.title).toBe("Generated Title");
      expect(session?.updatedAt).toBe(2000);
    });

    it("updates the title without lowering newer activity recency", async () => {
      await store.create(makeSession({ title: "Manual Title", updatedAt: 2000 }));

      const updated = await store.updateTitle("test-id", "Generated Title", 1500);
      expect(updated).toBe(true);

      const session = await store.get("test-id");
      expect(session?.title).toBe("Generated Title");
      expect(session?.updatedAt).toBe(2000);
    });
  });
});
