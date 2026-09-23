import { beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import type { SessionStatus, SpawnSource } from "@open-inspect/shared/types/sessions";
import { MAX_SESSION_LIST_LIMIT } from "@open-inspect/shared/session-list-query";
import { SessionIndexStore, type ListSessionsOptions } from "../../src/db/session-index";
import type { SqlDatabase } from "../../src/db/sql-database";
import { cleanD1Tables } from "./cleanup";

interface SeedSession {
  id: string;
  title?: string | null;
  repoOwner?: string | null;
  repoName?: string | null;
  repositories?: Array<{ repoOwner: string; repoName: string }>;
  status?: SessionStatus;
  spawnSource?: SpawnSource;
  parentSessionId?: string | null;
  userId?: string | null;
  environmentId?: string | null;
  updatedAt: number;
}

const ALICE = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const BOB = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

async function seed(store: SessionIndexStore, session: SeedSession): Promise<void> {
  const repositories = session.repositories?.map((repository) => ({
    ...repository,
    repoId: null,
    baseBranch: "main",
  }));
  await store.create({
    id: session.id,
    title: session.title ?? null,
    repoOwner: session.repoOwner ?? repositories?.[0]?.repoOwner ?? null,
    repoName: session.repoName ?? repositories?.[0]?.repoName ?? null,
    model: "anthropic/claude-haiku-4-5",
    reasoningEffort: null,
    baseBranch: null,
    status: session.status ?? "completed",
    spawnSource: session.spawnSource ?? "user",
    parentSessionId: session.parentSessionId ?? null,
    userId: session.userId ?? null,
    environmentId: session.environmentId ?? null,
    ...(repositories ? { repositories } : {}),
    createdAt: session.updatedAt,
    updatedAt: session.updatedAt,
  });
}

async function listIds(store: SessionIndexStore, options: ListSessionsOptions): Promise<string[]> {
  const result = await store.list(options);
  return result.sessions.map((session) => session.id);
}

/** Walk every offset page for `options` and return the ids in page order. */
async function listAllIds(
  store: SessionIndexStore,
  options: Omit<ListSessionsOptions, "limit" | "offset">,
  limit: number
): Promise<string[]> {
  const ids: string[] = [];
  for (let offset = 0; ; offset += limit) {
    const page = await store.list({ ...options, limit, offset });
    ids.push(...page.sessions.map((session) => session.id));
    if (!page.hasMore) return ids;
  }
}

describe("session discovery search (D1)", () => {
  beforeEach(cleanD1Tables);

  it("finds an old session beyond the recent window and pages until history is exhausted", async () => {
    const store = new SessionIndexStore(env.DB);
    const base = 1_000_000;
    // 120 recent, unrelated sessions occupy the whole "recent 100" window.
    for (let index = 0; index < 120; index += 1) {
      await seed(store, {
        id: `recent-${index.toString().padStart(3, "0")}`,
        title: `Routine work ${index}`,
        repoOwner: "acme",
        repoName: "web-app",
        updatedAt: base + 1_000 + index,
      });
    }
    // Three matches, all older than every recent session.
    for (const [id, updatedAt] of [
      ["needle-newest", base + 300],
      ["needle-middle", base + 200],
      ["needle-oldest", base + 100],
    ] as const) {
      await seed(store, {
        id,
        title: `Fix login redirect (${id})`,
        repoOwner: "acme",
        repoName: "web-app",
        updatedAt,
      });
    }

    const recentWindow = await listIds(store, {
      excludeStatus: "archived",
      limit: MAX_SESSION_LIST_LIMIT,
    });
    expect(recentWindow).toHaveLength(MAX_SESSION_LIST_LIMIT);
    expect(recentWindow).not.toContain("needle-oldest");

    const startedAt = Date.now();
    const firstPage = await store.list({
      excludeStatus: "archived",
      search: "login redirect",
      limit: 2,
    });
    console.info(
      `[session-discovery] search over ${123} rows took ${Date.now() - startedAt}ms (page of 2)`
    );
    expect(firstPage.sessions.map((session) => session.id)).toEqual([
      "needle-newest",
      "needle-middle",
    ]);
    expect(firstPage.hasMore).toBe(true);

    await expect(
      listAllIds(store, { excludeStatus: "archived", search: "login redirect" }, 2)
    ).resolves.toEqual(["needle-newest", "needle-middle", "needle-oldest"]);
  });

  it("matches title substrings case-insensitively and ids by prefix only", async () => {
    const store = new SessionIndexStore(env.DB);
    await seed(store, { id: "abc123def", title: "Upgrade Dependencies", updatedAt: 3 });
    await seed(store, { id: "zzz-abc123", title: "unrelated", updatedAt: 2 });
    await seed(store, { id: "other", title: "dependencies audit", updatedAt: 1 });

    await expect(listIds(store, { search: "DEPENDENCIES" })).resolves.toEqual([
      "abc123def",
      "other",
    ]);
    await expect(listIds(store, { search: "abc123" })).resolves.toEqual(["abc123def"]);
    await expect(listIds(store, { search: "abc123def" })).resolves.toEqual(["abc123def"]);
    await expect(listIds(store, { search: "no such session" })).resolves.toEqual([]);
  });

  it("treats LIKE metacharacters in the search text literally", async () => {
    const store = new SessionIndexStore(env.DB);
    await seed(store, { id: "percent", title: "Reach 100% coverage", updatedAt: 3 });
    await seed(store, { id: "underscore", title: "rename snake_case", updatedAt: 2 });
    await seed(store, { id: "plain", title: "Reach 100 coverage", updatedAt: 1 });

    await expect(listIds(store, { search: "100%" })).resolves.toEqual(["percent"]);
    await expect(listIds(store, { search: "snake_case" })).resolves.toEqual(["underscore"]);
    await expect(listIds(store, { search: "%" })).resolves.toEqual(["percent"]);
    await expect(listIds(store, { search: "_" })).resolves.toEqual(["underscore"]);
    await expect(listIds(store, { search: "\\" })).resolves.toEqual([]);
  });

  it("matches any member of a multi-repository session and the scalar primary of a legacy session", async () => {
    const store = new SessionIndexStore(env.DB);
    await seed(store, {
      id: "multi",
      title: null,
      repositories: [
        { repoOwner: "acme", repoName: "web-app" },
        { repoOwner: "acme", repoName: "billing-service" },
        { repoOwner: "partner", repoName: "sdk" },
      ],
      updatedAt: 3,
    });
    await seed(store, {
      id: "legacy",
      title: null,
      repoOwner: "acme",
      repoName: "billing-service",
      updatedAt: 2,
    });
    await seed(store, { id: "no-repo", title: "billing", updatedAt: 1 });

    // Search: owner, name, and owner/name forms.
    await expect(listIds(store, { search: "billing" })).resolves.toEqual([
      "multi",
      "legacy",
      "no-repo",
    ]);
    await expect(listIds(store, { search: "partner/sdk" })).resolves.toEqual(["multi"]);
    await expect(listIds(store, { search: "acme/billing" })).resolves.toEqual(["multi", "legacy"]);

    // Filter: third member, second member, and legacy scalar, case-insensitively.
    await expect(
      listIds(store, { repository: { repoOwner: "Partner", repoName: "SDK" } })
    ).resolves.toEqual(["multi"]);
    await expect(
      listIds(store, { repository: { repoOwner: "acme", repoName: "billing-service" } })
    ).resolves.toEqual(["multi", "legacy"]);
    await expect(
      listIds(store, { repository: { repoOwner: "acme", repoName: "missing" } })
    ).resolves.toEqual([]);
  });

  it("hides archived sessions by default and surfaces them under the archived lifecycle", async () => {
    const store = new SessionIndexStore(env.DB);
    await seed(store, { id: "live", title: "Migrate auth", status: "active", updatedAt: 3 });
    await seed(store, { id: "gone", title: "Migrate auth", status: "archived", updatedAt: 2 });

    await expect(listIds(store, { excludeStatus: "archived", search: "migrate" })).resolves.toEqual(
      ["live"]
    );
    await expect(listIds(store, { status: "archived", search: "migrate" })).resolves.toEqual([
      "gone",
    ]);
    await expect(listIds(store, { search: "migrate" })).resolves.toEqual(["live", "gone"]);
  });

  it("keeps a matching child discoverable when its parent does not match", async () => {
    const store = new SessionIndexStore(env.DB);
    await seed(store, { id: "parent", title: "Plan release", userId: ALICE, updatedAt: 3 });
    await seed(store, {
      id: "child",
      title: "Write changelog",
      parentSessionId: "parent",
      spawnSource: "agent",
      userId: BOB,
      updatedAt: 2,
    });

    const result = await store.list({ search: "changelog" });
    expect(result.sessions.map(({ id, parentSessionId }) => ({ id, parentSessionId }))).toEqual([
      { id: "child", parentSessionId: "parent" },
    ]);
    await expect(listIds(store, { createdByUserIds: [BOB] })).resolves.toEqual(["child"]);
  });

  it("composes creator, environment, origin, lifecycle, and repository filters on the server", async () => {
    const store = new SessionIndexStore(env.DB);
    const common = { repoOwner: "acme", repoName: "web-app", environmentId: "env-1" };
    await seed(store, { id: "match", userId: ALICE, spawnSource: "user", ...common, updatedAt: 9 });
    await seed(store, {
      id: "other-user",
      userId: BOB,
      spawnSource: "user",
      ...common,
      updatedAt: 8,
    });
    await seed(store, {
      id: "automation-run",
      userId: ALICE,
      spawnSource: "automation",
      ...common,
      updatedAt: 7,
    });
    await seed(store, {
      id: "other-env",
      userId: ALICE,
      spawnSource: "user",
      ...common,
      environmentId: "env-2",
      updatedAt: 6,
    });
    await seed(store, {
      id: "archived",
      userId: ALICE,
      spawnSource: "user",
      ...common,
      status: "archived",
      updatedAt: 5,
    });
    await seed(store, {
      id: "other-repo",
      userId: ALICE,
      spawnSource: "user",
      ...common,
      repoName: "api",
      updatedAt: 4,
    });
    await seed(store, {
      id: "bot",
      userId: null,
      spawnSource: "github-bot",
      ...common,
      updatedAt: 3,
    });

    await expect(
      listIds(store, {
        createdByUserIds: [ALICE],
        environmentId: "env-1",
        spawnSource: "user",
        excludeStatus: "archived",
        repository: { repoOwner: "acme", repoName: "web-app" },
      })
    ).resolves.toEqual(["match"]);
    await expect(listIds(store, { spawnSource: "automation" })).resolves.toEqual([
      "automation-run",
    ]);
    await expect(listIds(store, { spawnSource: "github-bot" })).resolves.toEqual(["bot"]);
    await expect(listIds(store, { environmentId: "env-2" })).resolves.toEqual(["other-env"]);
    // An unknown environment or origin is an empty result, not an unfiltered one.
    await expect(listIds(store, { environmentId: "env-none" })).resolves.toEqual([]);
    await expect(listIds(store, { spawnSource: "linear-bot" })).resolves.toEqual([]);
  });

  it("pages deterministically across updated_at ties", async () => {
    const store = new SessionIndexStore(env.DB);
    const ids = Array.from({ length: 7 }, (_, index) => `tie-${index}`);
    for (const id of ids) {
      await seed(store, { id, title: "same instant", updatedAt: 42 });
    }

    const paged = await listAllIds(store, { search: "same instant" }, 3);
    expect(paged).toHaveLength(ids.length);
    expect(new Set(paged).size).toBe(ids.length);
    expect(paged).toEqual([...ids].sort().reverse());
  });

  it("walks an updated_at-ordered index and binds every search parameter", async () => {
    const preparedQueries: string[] = [];
    const recordingDb = {
      prepare(query: string) {
        preparedQueries.push(query);
        return env.DB.prepare(query);
      },
      batch(statements: D1PreparedStatement[]) {
        return env.DB.batch(statements);
      },
    } as SqlDatabase;
    const store = new SessionIndexStore(recordingDb);
    await seed(store, { id: "plan-target", title: "plan me", updatedAt: 1 });

    const explain = async (
      options: ListSessionsOptions,
      bindings: unknown[],
      label: string
    ): Promise<string> => {
      preparedQueries.length = 0;
      await store.list(options);
      const pageQuery = preparedQueries.find((query) => query.includes("WITH paged_sessions AS"));
      expect(pageQuery).toBeDefined();
      expect(pageQuery).not.toContain("plan'");
      const plan = await env.DB.prepare(`EXPLAIN QUERY PLAN ${pageQuery}`)
        .bind(...bindings)
        .all<{ detail: string }>();
      const details = plan.results.map(({ detail }) => detail).join("\n");
      console.info(`[session-discovery] ${label} query plan:\n${details}`);
      // Only the id tie-breaker may need a sort; the walk itself is index-ordered.
      expect(details).not.toMatch(/USE TEMP B-TREE FOR ORDER BY/);
      return details;
    };

    const searchPlan = await explain(
      { excludeStatus: "archived", search: "plan' OR 1=1 --", viewerUserId: ALICE },
      ["archived", "%plan%", "plan%", "%plan%", "%plan%", 51, 0, ALICE],
      "search-only"
    );
    expect(searchPlan).toMatch(/SCAN sessions USING INDEX idx_sessions_updated_at/);

    const composedPlan = await explain(
      {
        excludeStatus: "archived",
        search: "plan' OR 1=1 --",
        repository: { repoOwner: "acme", repoName: "web-app" },
        environmentId: "env-1",
        spawnSource: "user",
        createdByUserIds: [ALICE],
        viewerUserId: ALICE,
      },
      [
        "archived",
        ALICE,
        "env-1",
        "user",
        "acme",
        "web-app",
        "acme",
        "web-app",
        "%plan%",
        "plan%",
        "%plan%",
        "%plan%",
        51,
        0,
        ALICE,
      ],
      "composed"
    );
    expect(composedPlan).toMatch(/SEARCH sessions USING INDEX idx_sessions_user_updated_at/);
  });
});
