import { beforeEach, describe, expect, it } from "vitest";
import { SessionIndexStore } from "./session-index";
import type { SessionEntry } from "./session-index";

type SessionRow = {
  id: string;
  title: string | null;
  repo_owner: string;
  repo_name: string;
  model: string;
  reasoning_effort: string | null;
  base_branch: string | null;
  status: string;
  parent_session_id: string | null;
  spawn_source: "user" | "agent";
  spawn_depth: number;
  created_at: number;
  updated_at: number;
};

const QUERY_PATTERNS = {
  INSERT_SESSION: /^INSERT OR IGNORE INTO sessions/,
  SELECT_BY_ID: /^SELECT \* FROM sessions WHERE id = \?$/,
  SELECT_COUNT: /^SELECT COUNT\(\*\) as count FROM sessions\b/,
  SELECT_LIST: /^SELECT \* FROM sessions\b.*ORDER BY updated_at DESC LIMIT/,
  UPDATE_STATUS: /^UPDATE sessions SET status = \?/,
  UPDATE_UPDATED_AT: /^UPDATE sessions SET updated_at = \?/,
  DELETE_SESSION: /^DELETE FROM sessions WHERE id = \?$/,
  SELECT_BY_PARENT:
    /^SELECT \* FROM sessions WHERE parent_session_id = \? ORDER BY created_at DESC$/,
  SELECT_1_CHILD: /^SELECT 1 FROM sessions WHERE id = \? AND parent_session_id = \?$/,
  SELECT_SPAWN_DEPTH: /^SELECT spawn_depth FROM sessions WHERE id = \?$/,
} as const;

function normalizeQuery(query: string): string {
  return query.replace(/\s+/g, " ").trim();
}

class FakeD1Database {
  private rows = new Map<string, SessionRow>();

  prepare(query: string) {
    return new FakePreparedStatement(this, query);
  }

  first(query: string, args: unknown[]) {
    const normalized = normalizeQuery(query);

    if (QUERY_PATTERNS.SELECT_BY_ID.test(normalized)) {
      const id = args[0] as string;
      return this.rows.get(id) ?? null;
    }

    if (QUERY_PATTERNS.SELECT_COUNT.test(normalized)) {
      const filtered = this.applyWhereConditions(normalized, args);
      return { count: filtered.length };
    }

    if (QUERY_PATTERNS.SELECT_1_CHILD.test(normalized)) {
      const [childId, parentId] = args as [string, string];
      const row = this.rows.get(childId);
      if (row && row.parent_session_id === parentId) {
        return { "1": 1 };
      }
      return null;
    }

    if (QUERY_PATTERNS.SELECT_SPAWN_DEPTH.test(normalized)) {
      const id = args[0] as string;
      const row = this.rows.get(id);
      return row ? { spawn_depth: row.spawn_depth } : null;
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

    if (QUERY_PATTERNS.SELECT_BY_PARENT.test(normalized)) {
      const parentId = args[0] as string;
      const children = Array.from(this.rows.values())
        .filter((r) => r.parent_session_id === parentId)
        .sort((a, b) => b.created_at - a.created_at);
      return children;
    }

    throw new Error(`Unexpected all() query: ${query}`);
  }

  run(query: string, args: unknown[]) {
    const normalized = normalizeQuery(query);

    if (QUERY_PATTERNS.INSERT_SESSION.test(normalized)) {
      const [
        id,
        title,
        repoOwner,
        repoName,
        model,
        reasoningEffort,
        baseBranch,
        status,
        parentSessionId,
        spawnSource,
        spawnDepth,
        createdAt,
        updatedAt,
      ] = args as [
        string,
        string | null,
        string,
        string,
        string,
        string | null,
        string | null,
        string,
        string | null,
        "user" | "agent",
        number,
        number,
        number,
      ];
      // INSERT OR IGNORE — skip if exists
      if (!this.rows.has(id)) {
        this.rows.set(id, {
          id,
          title,
          repo_owner: repoOwner,
          repo_name: repoName,
          model,
          reasoning_effort: reasoningEffort,
          base_branch: baseBranch,
          status,
          parent_session_id: parentSessionId,
          spawn_source: spawnSource,
          spawn_depth: spawnDepth,
          created_at: createdAt,
          updated_at: updatedAt,
        });
      }
      return { meta: { changes: this.rows.has(id) ? 1 : 0 } };
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

    if (QUERY_PATTERNS.DELETE_SESSION.test(normalized)) {
      const id = args[0] as string;
      const existed = this.rows.delete(id);
      return { meta: { changes: existed ? 1 : 0 } };
    }

    if (QUERY_PATTERNS.UPDATE_UPDATED_AT.test(normalized)) {
      const [updatedAt, id] = args as [number, string];
      const row = this.rows.get(id);
      if (row) {
        row.updated_at = updatedAt;
        return { meta: { changes: 1 } };
      }
      return { meta: { changes: 0 } };
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

      if (conditions.includes("parent_session_id = ?")) {
        const parentId = args[argIdx++] as string;
        rows = rows.filter((r) => r.parent_session_id === parentId);
      }

      if (conditions.includes("status NOT IN")) {
        rows = rows.filter((r) => !["completed", "archived", "cancelled"].includes(r.status));
      }

      if (conditions.includes("status = ?")) {
        const statusVal = args[argIdx++] as string;
        rows = rows.filter((r) => r.status === statusVal);
      }

      if (conditions.includes("status != ?")) {
        const statusVal = args[argIdx++] as string;
        rows = rows.filter((r) => r.status !== statusVal);
      }

      if (conditions.includes("repo_owner = ?")) {
        const ownerVal = args[argIdx++] as string;
        rows = rows.filter((r) => r.repo_owner === ownerVal);
      }

      if (conditions.includes("repo_name = ?")) {
        const nameVal = args[argIdx++] as string;
        rows = rows.filter((r) => r.repo_name === nameVal);
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
        // Defaults applied for missing parent fields
        parentSessionId: null,
        spawnSource: "user",
        spawnDepth: 0,
      });
    });

    it("normalizes repoOwner and repoName to lowercase", async () => {
      const session = makeSession({ repoOwner: "Owner", repoName: "Repo" });
      await store.create(session);

      const result = await store.get("test-id");
      expect(result?.repoOwner).toBe("owner");
      expect(result?.repoName).toBe("repo");
    });

    it("ignores duplicate inserts (INSERT OR IGNORE)", async () => {
      const session = makeSession();
      await store.create(session);
      await store.create(makeSession({ title: "Different Title" }));

      const result = await store.get("test-id");
      expect(result?.title).toBe("Test Session");
    });

    it("stores parent fields when provided", async () => {
      const session = makeSession({
        id: "child-1",
        parentSessionId: "parent-1",
        spawnSource: "agent",
        spawnDepth: 1,
      });
      await store.create(session);

      const result = await store.get("child-1");
      expect(result?.parentSessionId).toBe("parent-1");
      expect(result?.spawnSource).toBe("agent");
      expect(result?.spawnDepth).toBe(1);
    });
  });

  describe("get", () => {
    it("returns session when found", async () => {
      await store.create(makeSession());
      const result = await store.get("test-id");
      expect(result).not.toBeNull();
      expect(result?.id).toBe("test-id");
    });

    it("returns null when not found", async () => {
      const result = await store.get("nonexistent");
      expect(result).toBeNull();
    });
  });

  describe("list", () => {
    it("returns sessions sorted by updatedAt descending", async () => {
      await store.create(makeSession({ id: "old", updatedAt: 1000 }));
      await store.create(makeSession({ id: "new", updatedAt: 3000 }));
      await store.create(makeSession({ id: "mid", updatedAt: 2000 }));

      const result = await store.list();
      expect(result.sessions.map((s) => s.id)).toEqual(["new", "mid", "old"]);
      expect(result.total).toBe(3);
      expect(result.hasMore).toBe(false);
    });

    it("filters by status", async () => {
      await store.create(makeSession({ id: "a", status: "active" }));
      await store.create(makeSession({ id: "b", status: "archived" }));

      const result = await store.list({ status: "active" });
      expect(result.sessions).toHaveLength(1);
      expect(result.sessions[0].id).toBe("a");
      expect(result.total).toBe(1);
    });

    it("filters by excludeStatus", async () => {
      await store.create(makeSession({ id: "a", status: "active", updatedAt: 2000 }));
      await store.create(makeSession({ id: "b", status: "archived", updatedAt: 1000 }));
      await store.create(makeSession({ id: "c", status: "created", updatedAt: 3000 }));

      const result = await store.list({ excludeStatus: "archived" });
      expect(result.sessions).toHaveLength(2);
      expect(result.sessions.map((s) => s.id)).toEqual(["c", "a"]);
      expect(result.total).toBe(2);
    });

    it("supports pagination with limit and offset", async () => {
      for (let i = 0; i < 5; i++) {
        await store.create(makeSession({ id: `s${i}`, updatedAt: i * 1000 }));
      }

      const page1 = await store.list({ limit: 2, offset: 0 });
      expect(page1.sessions).toHaveLength(2);
      expect(page1.total).toBe(5);
      expect(page1.hasMore).toBe(true);

      const page2 = await store.list({ limit: 2, offset: 2 });
      expect(page2.sessions).toHaveLength(2);
      expect(page2.hasMore).toBe(true);

      const page3 = await store.list({ limit: 2, offset: 4 });
      expect(page3.sessions).toHaveLength(1);
      expect(page3.hasMore).toBe(false);
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

  describe("delete", () => {
    it("deletes an existing session", async () => {
      await store.create(makeSession());
      const deleted = await store.delete("test-id");
      expect(deleted).toBe(true);

      const session = await store.get("test-id");
      expect(session).toBeNull();
    });

    it("returns false when session not found", async () => {
      const deleted = await store.delete("nonexistent");
      expect(deleted).toBe(false);
    });
  });

  describe("parent/child queries", () => {
    const parentId = "parent-1";

    beforeEach(async () => {
      // Seed parent
      await store.create(
        makeSession({
          id: parentId,
          title: "Parent",
          parentSessionId: null,
          spawnSource: "user",
          spawnDepth: 0,
        })
      );
      // Seed active child
      await store.create(
        makeSession({
          id: "child-1",
          title: "Child 1",
          status: "created",
          parentSessionId: parentId,
          spawnSource: "agent",
          spawnDepth: 1,
          createdAt: 1000,
        })
      );
      // Seed completed child
      await store.create(
        makeSession({
          id: "child-2",
          title: "Child 2",
          status: "completed",
          parentSessionId: parentId,
          spawnSource: "agent",
          spawnDepth: 1,
          createdAt: 2000,
        })
      );
    });

    describe("listByParent", () => {
      it("returns children newest-first", async () => {
        const children = await store.listByParent(parentId);
        expect(children).toHaveLength(2);
        expect(children[0].id).toBe("child-2");
        expect(children[1].id).toBe("child-1");
      });

      it("returns empty array when no children exist", async () => {
        const children = await store.listByParent("no-children");
        expect(children).toEqual([]);
      });
    });

    describe("countActiveChildren", () => {
      it("excludes completed/archived/cancelled", async () => {
        const count = await store.countActiveChildren(parentId);
        expect(count).toBe(1); // child-1 is "created", child-2 is "completed"
      });

      it("returns 0 when no children exist", async () => {
        const count = await store.countActiveChildren("no-children");
        expect(count).toBe(0);
      });
    });

    describe("countTotalChildren", () => {
      it("counts all children regardless of status", async () => {
        const count = await store.countTotalChildren(parentId);
        expect(count).toBe(2);
      });

      it("returns 0 when no children exist", async () => {
        const count = await store.countTotalChildren("no-children");
        expect(count).toBe(0);
      });
    });

    describe("isChildOf", () => {
      it("returns true for valid parent-child pair", async () => {
        const result = await store.isChildOf("child-1", parentId);
        expect(result).toBe(true);
      });

      it("returns false for unrelated sessions", async () => {
        const result = await store.isChildOf("child-1", "wrong-parent");
        expect(result).toBe(false);
      });

      it("returns false for reversed parent-child", async () => {
        const result = await store.isChildOf(parentId, "child-1");
        expect(result).toBe(false);
      });

      it("returns false for nonexistent child", async () => {
        const result = await store.isChildOf("nonexistent", parentId);
        expect(result).toBe(false);
      });
    });

    describe("getSpawnDepth", () => {
      it("returns stored depth for child", async () => {
        const depth = await store.getSpawnDepth("child-1");
        expect(depth).toBe(1);
      });

      it("returns 0 for top-level session", async () => {
        const depth = await store.getSpawnDepth(parentId);
        expect(depth).toBe(0);
      });

      it("returns 0 for unknown session", async () => {
        const depth = await store.getSpawnDepth("nonexistent");
        expect(depth).toBe(0);
      });
    });
  });
});
