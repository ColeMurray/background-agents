import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionExportStore } from "../../src/db/session-export-store";
import type { SqlDatabase, SqlStatement } from "../../src/db/sql-database";
import { cleanD1Tables } from "./cleanup";
import { sqlDatabase } from "./helpers";

function insertSession(id: string, createdAt: number) {
  return env.DB.prepare("INSERT INTO sessions (id, created_at, updated_at) VALUES (?, ?, ?)")
    .bind(id, createdAt, createdAt)
    .run();
}

describe("SessionExportStore integration", () => {
  beforeEach(cleanD1Tables);
  afterEach(cleanD1Tables);

  it("paginates timestamp ties without gaps or newly-created sessions", async () => {
    await insertSession("session-a", 200);
    await insertSession("session-b", 200);
    await insertSession("session-c", 200);
    await insertSession("session-newest", 300);
    const store = new SessionExportStore(sqlDatabase(env.DB));

    const first = await store.list({ cursor: null, limit: 2 });
    expect(first.sessions.map(({ id }) => id)).toEqual(["session-newest", "session-c"]);
    expect(first.nextCursor).toEqual({
      createdAt: 200,
      id: "session-c",
      snapshotMaxRowId: expect.any(Number),
    });

    await insertSession("session-created-during-export", 400);
    await insertSession("session-bb-created-during-export", 200);
    const second = await store.list({ cursor: first.nextCursor, limit: 2 });
    expect(second.sessions.map(({ id }) => id)).toEqual(["session-b", "session-a"]);
    expect(second).toMatchObject({ hasMore: false, nextCursor: null });
  });

  it("applies inclusive created-at filters", async () => {
    await insertSession("session-old", 100);
    await insertSession("session-start", 200);
    await insertSession("session-end", 300);
    await insertSession("session-new", 400);

    const result = await new SessionExportStore(sqlDatabase(env.DB)).list({
      cursor: null,
      limit: 10,
      createdAfter: 200,
      createdBefore: 300,
    });

    expect(result.sessions.map(({ id }) => id)).toEqual(["session-end", "session-start"]);
  });

  it("exports child identity, ordered repositories, merged PRs, and projected token totals", async () => {
    await insertSession("root", 100);
    await insertSession("child", 200);
    await env.DB.prepare(
      `UPDATE sessions SET title = ?, status = ?, spawn_source = ?, parent_session_id = ?,
       root_session_id = ?, spawn_depth = ?, harness = ?, model = ?, reasoning_effort = ?,
       scm_login = ?, automation_run_id = ?, environment_id = ?, repo_owner = ?, repo_name = ?,
       base_branch = ?, pr_count = ?, input_tokens = ?, output_tokens = ?, reasoning_tokens = ?,
       cache_read_tokens = ?, cache_write_tokens = ? WHERE id = ?`
    )
      .bind(
        "Child run",
        "completed",
        "agent",
        "root",
        "root",
        1,
        "claude",
        "openai/gpt-5.4",
        "high",
        "agent-user",
        "run-1",
        "env-1",
        "acme",
        "web",
        "main",
        1,
        120,
        30,
        8,
        55,
        4,
        "child"
      )
      .run();
    await env.DB.prepare(
      `INSERT INTO session_repositories (session_id, position, repo_owner, repo_name, repo_id, base_branch)
       VALUES (?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?)`
    )
      .bind("child", 1, "acme", "api", 202, "develop", "child", 0, "acme", "web", 101, "main")
      .run();
    await env.DB.prepare(
      `INSERT INTO session_pull_requests
       (artifact_id, session_id, repo_owner, repo_name, pr_number, url, lifecycle_state,
        is_draft, head_branch, base_branch, head_sha, created_at, updated_at,
        provider_created_at, merged_at, closed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        "pr-1",
        "child",
        "acme",
        "api",
        42,
        "https://example.com/acme/api/pull/42",
        "merged",
        0,
        "feature/child",
        "develop",
        "abc123",
        210,
        300,
        210,
        300,
        300
      )
      .run();

    const result = await new SessionExportStore(sqlDatabase(env.DB)).list({
      cursor: null,
      limit: 1,
    });

    expect(result.sessions).toMatchObject([
      {
        id: "child",
        source: "agent",
        spawnSource: "agent",
        parentSessionId: "root",
        rootSessionId: "root",
        spawnDepth: 1,
        harness: "claude",
        model: "openai/gpt-5.4",
        provider: "openai",
        reasoningEffort: "high",
        scmLogin: "agent-user",
        automationRunId: "run-1",
        environmentId: "env-1",
        baseBranch: "main",
        prCount: 1,
        inputTokens: 120,
        outputTokens: 30,
        reasoningTokens: 8,
        cacheReadTokens: 55,
        cacheWriteTokens: 4,
        repositories: [
          { repoOwner: "acme", repoName: "web", repoId: 101, baseBranch: "main" },
          { repoOwner: "acme", repoName: "api", repoId: 202, baseBranch: "develop" },
        ],
        pullRequests: [
          {
            repoOwner: "acme",
            repoName: "api",
            prNumber: 42,
            url: "https://example.com/acme/api/pull/42",
            lifecycleState: "merged",
            isDraft: false,
            headBranch: "feature/child",
            baseBranch: "develop",
            headSha: "abc123",
            providerCreatedAt: 210,
            mergedAt: 300,
            closedAt: 300,
          },
        ],
      },
    ]);
    expect(result.hasMore).toBe(true);
  });

  it("synthesizes a scalar-era repository and derives the provider for a bare Claude model", async () => {
    await insertSession("legacy", 100);
    await env.DB.prepare(
      "UPDATE sessions SET repo_owner = ?, repo_name = ?, base_branch = ?, model = ? WHERE id = ?"
    )
      .bind("group/subgroup", "repo", "release", "claude-haiku-4-5", "legacy")
      .run();

    const result = await new SessionExportStore(sqlDatabase(env.DB)).list({
      cursor: null,
      limit: 10,
    });

    expect(result.sessions).toMatchObject([
      {
        id: "legacy",
        model: "claude-haiku-4-5",
        provider: "anthropic",
        repositories: [
          { repoOwner: "group/subgroup", repoName: "repo", repoId: null, baseBranch: "release" },
        ],
        pullRequests: [],
      },
    ]);
  });

  it("exports no synthesized repository for a repository-less session", async () => {
    await insertSession("no-repo", 100);

    const result = await new SessionExportStore(sqlDatabase(env.DB)).list({
      cursor: null,
      limit: 10,
    });

    expect(result.sessions[0].repositories).toEqual([]);
    expect(result.sessions[0].pullRequests).toEqual([]);
  });

  it("loads repository membership across the D1 parameter boundary", async () => {
    await env.DB.batch(
      Array.from({ length: 101 }, (_, index) =>
        env.DB.prepare("INSERT INTO sessions (id, created_at, updated_at) VALUES (?, ?, ?)").bind(
          `session-${index}`,
          index,
          index
        )
      )
    );
    await env.DB.prepare(
      `INSERT INTO session_repositories
       (session_id, position, repo_owner, repo_name, base_branch) VALUES (?, ?, ?, ?, ?)`
    )
      .bind("session-0", 0, "acme", "oldest", "main")
      .run();
    await env.DB.prepare(
      `INSERT INTO session_repositories
       (session_id, position, repo_owner, repo_name, base_branch) VALUES (?, ?, ?, ?, ?)`
    )
      .bind("session-100", 0, "acme", "newest", "main")
      .run();

    const result = await new SessionExportStore(sqlDatabase(env.DB)).list({
      cursor: null,
      limit: 101,
    });

    expect(result.sessions).toHaveLength(101);
    expect(result.sessions[0].repositories).toEqual([
      { repoOwner: "acme", repoName: "newest", repoId: null, baseBranch: "main" },
    ]);
    expect(result.sessions[100].repositories).toEqual([
      { repoOwner: "acme", repoName: "oldest", repoId: null, baseBranch: "main" },
    ]);
  });

  it("keeps metrics and PRs on one snapshot when a write interleaves with the read", async () => {
    await insertSession("interleaved", 100);
    const rawDb = sqlDatabase(env.DB);
    const unwrapped = new WeakMap<SqlStatement, SqlStatement>();
    let wrote = false;
    const write = async () => {
      if (wrote) return;
      wrote = true;
      await env.DB.prepare("UPDATE sessions SET pr_count = 1 WHERE id = ?")
        .bind("interleaved")
        .run();
      await env.DB.prepare(
        `INSERT INTO session_pull_requests
         (artifact_id, session_id, repo_owner, repo_name, pr_number, url, lifecycle_state,
          is_draft, head_branch, base_branch, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
        .bind(
          "pr-interleaved",
          "interleaved",
          "acme",
          "repo",
          1,
          "https://example.com/pr/1",
          "open",
          0,
          "feature",
          "main",
          100,
          100
        )
        .run();
    };
    const db: SqlDatabase = {
      prepare(sql) {
        const statement = rawDb.prepare(sql);
        if (!sql.includes("FROM sessions")) return statement;
        const wrap = (inner: SqlStatement): SqlStatement => {
          const wrapped: SqlStatement = {
            bind(...values) {
              return wrap(inner.bind(...values));
            },
            first<T = Record<string, unknown>>() {
              return inner.first<T>();
            },
            run<T = Record<string, unknown>>() {
              return inner.run<T>();
            },
            async all<T = Record<string, unknown>>() {
              const result = await inner.all<T>();
              await write();
              return result;
            },
          };
          unwrapped.set(wrapped, inner);
          return wrapped;
        };
        return wrap(statement);
      },
      async batch<T = unknown>(statements: SqlStatement[]) {
        const result = await rawDb.batch<T>(statements.map((stmt) => unwrapped.get(stmt) ?? stmt));
        await write();
        return result;
      },
    };

    const result = await new SessionExportStore(db).list({ cursor: null, limit: 10 });

    expect(wrote).toBe(true);
    expect(result.sessions[0].prCount).toBe(result.sessions[0].pullRequests.length);
    expect(
      await env.DB.prepare("SELECT pr_count FROM sessions WHERE id = ?").bind("interleaved").first()
    ).toMatchObject({ pr_count: 1 });
  });
});
