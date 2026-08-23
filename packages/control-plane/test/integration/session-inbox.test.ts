import { beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { SessionIndexStore, type SessionEntry } from "../../src/db/session-index";
import { cleanD1Tables } from "./cleanup";
import { serviceFetch } from "./helpers";
import type { SessionInboxCategory } from "@open-inspect/shared/types/session-inbox";

const VIEWER_ID = "11111111111111111111111111111111";

function session(id: string, overrides: Partial<SessionEntry> = {}): SessionEntry {
  return {
    id,
    title: id,
    repoOwner: "open-inspect",
    repoName: "open-inspect",
    model: "anthropic/claude-sonnet-4-6",
    reasoningEffort: "high",
    baseBranch: "main",
    status: "completed",
    parentSessionId: null,
    spawnSource: "user",
    spawnDepth: 0,
    userId: VIEWER_ID,
    createdAt: 1000,
    updatedAt: 2000,
    ...overrides,
  };
}

describe("session inbox", () => {
  beforeEach(cleanD1Tables);

  it("classifies complete hierarchies on the server", async () => {
    await serviceFetch("https://example.com/sessions/inbox?category=finished");
    const store = new SessionIndexStore(env.DB);
    const parent = session("parent", { status: "active", updatedAt: 5000 });
    const child = session("child", {
      status: "active",
      parentSessionId: parent.id,
      spawnSource: "agent",
      spawnDepth: 1,
      updatedAt: 4000,
    });
    const grandchild = session("grandchild", {
      status: "failed",
      parentSessionId: child.id,
      spawnSource: "agent",
      spawnDepth: 2,
      updatedAt: 3000,
    });
    await store.create(parent);
    await store.create(child);
    await store.create(grandchild);
    // The failure has to carry unread output to pull the tree up — a bare
    // `failed` status is not itself an attention signal.
    await store.recordLatestTerminalMessage({
      sessionId: grandchild.id,
      messageId: "message-1",
      messageCreatedAt: Date.now(),
      terminalMessageCompletedAt: Date.now(),
    });

    const response = await serviceFetch(
      "https://example.com/sessions/inbox?category=needs_attention"
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    const body = (await response.json()) as {
      items: Array<{
        rootSession: { id: string };
        descendantSessions: Array<{ id: string }>;
      }>;
    };
    expect(body.items).toHaveLength(1);
    expect(body.items[0].rootSession.id).toBe(parent.id);
    expect(body.items[0].descendantSessions.map(({ id }) => id)).toEqual([child.id, grandchild.id]);
  });

  it("persists roots and repairs them cycle-safely when parents change", async () => {
    const store = new SessionIndexStore(env.DB);
    await store.create(session("root"));
    await store.create(session("child", { parentSessionId: "root", spawnDepth: 1 }));
    await store.create(session("grandchild", { parentSessionId: "child", spawnDepth: 2 }));

    const initial = await env.DB.prepare(
      "SELECT id, root_session_id FROM sessions ORDER BY id"
    ).all<{ id: string; root_session_id: string }>();
    expect(initial.results).toEqual([
      { id: "child", root_session_id: "root" },
      { id: "grandchild", root_session_id: "root" },
      { id: "root", root_session_id: "root" },
    ]);

    await env.DB.prepare("UPDATE sessions SET parent_session_id = ? WHERE id = ?")
      .bind("grandchild", "root")
      .run();

    const cycled = await env.DB.prepare(
      "SELECT id, root_session_id FROM sessions ORDER BY id"
    ).all<{ id: string; root_session_id: string }>();
    expect(cycled.results).toEqual([
      { id: "child", root_session_id: "child" },
      { id: "grandchild", root_session_id: "child" },
      { id: "root", root_session_id: "child" },
    ]);
  });

  it("fills old-worker roots and repairs child-before-parent inserts", async () => {
    await env.DB.prepare("INSERT INTO sessions (id, created_at, updated_at) VALUES (?, ?, ?)")
      .bind("legacy-root", 1000, 1000)
      .run();
    await env.DB.prepare(
      `INSERT INTO sessions (id, parent_session_id, spawn_source, spawn_depth, created_at, updated_at)
       VALUES (?, ?, 'agent', 1, ?, ?)`
    )
      .bind("legacy-child", "legacy-root", 1000, 1000)
      .run();

    const roots = await env.DB.prepare("SELECT id, root_session_id FROM sessions ORDER BY id").all<{
      id: string;
      root_session_id: string;
    }>();
    expect(roots.results).toEqual([
      { id: "legacy-child", root_session_id: "legacy-root" },
      { id: "legacy-root", root_session_id: "legacy-root" },
    ]);

    const store = new SessionIndexStore(env.DB);
    await store.create(session("orphan", { parentSessionId: "late-parent", spawnDepth: 1 }));
    expect(
      await env.DB.prepare("SELECT root_session_id FROM sessions WHERE id = 'orphan'").first<{
        root_session_id: string;
      }>()
    ).toEqual({ root_session_id: "orphan" });

    await store.create(session("late-parent"));
    expect(
      await env.DB.prepare("SELECT root_session_id FROM sessions WHERE id = 'orphan'").first<{
        root_session_id: string;
      }>()
    ).toEqual({ root_session_id: "late-parent" });
  });

  it("reroots surviving subtrees when a parent is deleted", async () => {
    const store = new SessionIndexStore(env.DB);
    await store.create(session("root"));
    await store.create(session("child", { parentSessionId: "root", spawnDepth: 1 }));
    await store.create(session("grandchild", { parentSessionId: "child", spawnDepth: 2 }));

    await store.delete("root");

    const descendants = await env.DB.prepare(
      "SELECT id, parent_session_id, root_session_id FROM sessions ORDER BY id"
    ).all<{ id: string; parent_session_id: string | null; root_session_id: string }>();
    expect(descendants.results).toEqual([
      { id: "child", parent_session_id: null, root_session_id: "child" },
      { id: "grandchild", parent_session_id: "child", root_session_id: "child" },
    ]);
  });

  it("puts active sessions with unread terminal output in needs attention", async () => {
    await serviceFetch("https://example.com/sessions/inbox?category=finished");
    const store = new SessionIndexStore(env.DB);
    await store.create(session("active-unread", { status: "active", updatedAt: 3000 }));
    await store.recordLatestTerminalMessage({
      sessionId: "active-unread",
      messageId: "message-1",
      messageCreatedAt: Date.now(),
      terminalMessageCompletedAt: Date.now(),
    });

    const response = await serviceFetch(
      "https://example.com/sessions/inbox?category=needs_attention"
    );
    const body = (await response.json()) as {
      items: Array<{ rootSession: { id: string } }>;
    };
    expect(body.items).toHaveLength(1);
    expect(body.items[0].rootSession.id).toBe("active-unread");
  });

  it("keeps a failure that produced no output out of needs attention", async () => {
    await serviceFetch("https://example.com/sessions/inbox?category=finished");
    const store = new SessionIndexStore(env.DB);
    await store.create(session("spawn-failure", { status: "failed", updatedAt: 3000 }));

    const attention = await serviceFetch(
      "https://example.com/sessions/inbox?category=needs_attention"
    );
    const attentionBody = (await attention.json()) as {
      items: Array<{ rootSession: { id: string } }>;
    };
    expect(attentionBody.items).toEqual([]);

    const finished = await serviceFetch("https://example.com/sessions/inbox?category=finished");
    const finishedBody = (await finished.json()) as {
      items: Array<{ rootSession: { id: string } }>;
    };
    expect(finishedBody.items.map((item) => item.rootSession.id)).toEqual(["spawn-failure"]);
  });

  it("releases a failed session from needs attention once its output is read", async () => {
    await serviceFetch("https://example.com/sessions/inbox?category=finished");
    const store = new SessionIndexStore(env.DB);
    await store.create(session("failed-with-output", { status: "failed", updatedAt: 3000 }));
    await store.recordLatestTerminalMessage({
      sessionId: "failed-with-output",
      messageId: "message-1",
      messageCreatedAt: Date.now(),
      terminalMessageCompletedAt: Date.now(),
    });

    const beforeRead = await serviceFetch(
      "https://example.com/sessions/inbox?category=needs_attention"
    );
    const beforeBody = (await beforeRead.json()) as {
      items: Array<{ rootSession: { id: string } }>;
    };
    expect(beforeBody.items.map((item) => item.rootSession.id)).toEqual(["failed-with-output"]);

    await store.updateReadState(VIEWER_ID, "failed-with-output", {
      action: "mark_latest_message_read",
    });

    const afterRead = await serviceFetch(
      "https://example.com/sessions/inbox?category=needs_attention"
    );
    const afterBody = (await afterRead.json()) as {
      items: Array<{ rootSession: { id: string } }>;
    };
    expect(afterBody.items).toEqual([]);

    const finished = await serviceFetch("https://example.com/sessions/inbox?category=finished");
    const finishedBody = (await finished.json()) as {
      items: Array<{ rootSession: { id: string } }>;
    };
    expect(finishedBody.items.map((item) => item.rootSession.id)).toEqual(["failed-with-output"]);
  });

  it("keeps a never-prompted draft out of in progress", async () => {
    await serviceFetch("https://example.com/sessions/inbox?category=finished");
    const store = new SessionIndexStore(env.DB);
    await store.create(session("draft", { status: "created", updatedAt: 3000 }));

    const inProgress = await serviceFetch(
      "https://example.com/sessions/inbox?category=in_progress"
    );
    const inProgressBody = (await inProgress.json()) as {
      items: Array<{ rootSession: { id: string } }>;
    };
    expect(inProgressBody.items).toEqual([]);

    const finished = await serviceFetch("https://example.com/sessions/inbox?category=finished");
    const finishedBody = (await finished.json()) as {
      items: Array<{ rootSession: { id: string } }>;
    };
    expect(finishedBody.items.map((item) => item.rootSession.id)).toEqual(["draft"]);
  });

  it("does not promote a hierarchy into in progress for a draft descendant", async () => {
    await serviceFetch("https://example.com/sessions/inbox?category=finished");
    const store = new SessionIndexStore(env.DB);
    const parent = session("parent", { updatedAt: 5000 });
    await store.create(parent);
    await store.create(
      session("draft-child", {
        status: "created",
        parentSessionId: parent.id,
        spawnSource: "agent",
        spawnDepth: 1,
        updatedAt: 4000,
      })
    );

    const inProgress = await serviceFetch(
      "https://example.com/sessions/inbox?category=in_progress"
    );
    const inProgressBody = (await inProgress.json()) as {
      items: Array<{ rootSession: { id: string } }>;
    };
    expect(inProgressBody.items).toEqual([]);

    const finished = await serviceFetch("https://example.com/sessions/inbox?category=finished");
    const finishedBody = (await finished.json()) as {
      items: Array<{ rootSession: { id: string }; descendantSessions: Array<{ id: string }> }>;
    };
    expect(finishedBody.items).toHaveLength(1);
    expect(finishedBody.items[0].rootSession.id).toBe(parent.id);
    expect(finishedBody.items[0].descendantSessions.map(({ id }) => id)).toEqual(["draft-child"]);
  });

  it("limits the Mine view to user-created non-automation sessions", async () => {
    await serviceFetch("https://example.com/sessions/inbox?category=finished");
    const store = new SessionIndexStore(env.DB);
    await store.create(session("mine"));
    await store.create(session("another-user", { userId: "22222222222222222222222222222222" }));
    await store.create(
      session("automation", {
        automationId: "automation-1",
        spawnSource: "automation",
      })
    );

    const response = await serviceFetch(
      "https://example.com/sessions/inbox?category=finished&mine=true"
    );
    const body = (await response.json()) as {
      items: Array<{ rootSession: { id: string } }>;
    };
    expect(body.items.map((item) => item.rootSession.id)).toEqual(["mine"]);
  });

  it("reroots every visible subtree when Mine filters out the persisted root", async () => {
    const store = new SessionIndexStore(env.DB);
    await store.create(
      session("filtered-root", {
        userId: "22222222222222222222222222222222",
        updatedAt: 5000,
      })
    );
    await store.create(
      session("child-a", { parentSessionId: "filtered-root", spawnDepth: 1, updatedAt: 4000 })
    );
    await store.create(
      session("grandchild", { parentSessionId: "child-a", spawnDepth: 2, updatedAt: 3500 })
    );
    await store.create(
      session("child-b", { parentSessionId: "filtered-root", spawnDepth: 1, updatedAt: 3000 })
    );

    const response = await serviceFetch(
      "https://example.com/sessions/inbox?category=finished&mine=true"
    );
    const body = (await response.json()) as {
      items: Array<{ rootSession: { id: string }; descendantSessions: Array<{ id: string }> }>;
    };
    expect(body.items).toEqual([
      {
        rootSession: expect.objectContaining({ id: "child-a" }),
        descendantSessions: [expect.objectContaining({ id: "grandchild" })],
      },
      {
        rootSession: expect.objectContaining({ id: "child-b" }),
        descendantSessions: [],
      },
    ]);
  });

  it("reroots below a filtered middle ancestor while keeping the root visible", async () => {
    const store = new SessionIndexStore(env.DB);
    await store.create(session("visible-root", { updatedAt: 5000 }));
    await store.create(
      session("filtered-middle", {
        parentSessionId: "visible-root",
        spawnDepth: 1,
        userId: "22222222222222222222222222222222",
        updatedAt: 4000,
      })
    );
    await store.create(
      session("visible-leaf", {
        parentSessionId: "filtered-middle",
        spawnDepth: 2,
        updatedAt: 3000,
      })
    );

    const response = await serviceFetch(
      "https://example.com/sessions/inbox?category=finished&mine=true"
    );
    const body = (await response.json()) as {
      items: Array<{ rootSession: { id: string }; descendantSessions: Array<{ id: string }> }>;
    };
    expect(body.items.map((item) => item.rootSession.id)).toEqual(["visible-root", "visible-leaf"]);
    expect(body.items.every((item) => item.descendantSessions.length === 0)).toBe(true);
  });

  it("paginates roots independently with cursors", async () => {
    await serviceFetch("https://example.com/sessions/inbox?category=finished");
    const store = new SessionIndexStore(env.DB);
    const rootIds = Array.from({ length: 21 }, (_, index) => `root-${index}`);
    for (const rootId of rootIds) await store.create(session(rootId, { updatedAt: 3000 }));
    const expectedOrder = [...rootIds].sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));

    const first = await serviceFetch("https://example.com/sessions/inbox?category=finished");
    const firstBody = (await first.json()) as {
      items: Array<{ rootSession: { id: string } }>;
      hasMore: boolean;
      nextCursor: string;
    };
    expect(firstBody.items).toHaveLength(20);
    expect(firstBody.items.map((item) => item.rootSession.id)).toEqual(expectedOrder.slice(0, 20));
    expect(firstBody.hasMore).toBe(true);

    const second = await serviceFetch(
      `https://example.com/sessions/inbox?category=finished&cursor=${encodeURIComponent(firstBody.nextCursor)}`
    );
    const secondBody = (await second.json()) as {
      items: Array<{ rootSession: { id: string } }>;
      hasMore: boolean;
      nextCursor: null;
    };
    expect(secondBody.items.map((item) => item.rootSession.id)).toEqual(expectedOrder.slice(20));
    expect(secondBody.hasMore).toBe(false);
    expect(secondBody.nextCursor).toBeNull();
  });

  it("decorates complete lineages beyond one D1 parameter chunk", async () => {
    const store = new SessionIndexStore(env.DB);
    await store.create(session("large-root", { updatedAt: 5000 }));
    for (let index = 0; index < 105; index += 1) {
      await store.create(
        session(`child-${index}`, {
          parentSessionId: "large-root",
          spawnDepth: 1,
          updatedAt: 4000 - index,
          ...(index === 104
            ? {
                repositories: [
                  {
                    repoOwner: "chunk-owner",
                    repoName: "chunk-repo",
                    repoId: 123,
                    baseBranch: "main",
                  },
                ],
              }
            : {}),
        })
      );
    }

    const response = await serviceFetch("https://example.com/sessions/inbox?category=finished");
    const body = (await response.json()) as {
      items: Array<{
        rootSession: { id: string };
        descendantSessions: Array<{
          id: string;
          repositories?: Array<{ repoOwner: string; repoName: string }>;
        }>;
      }>;
    };
    expect(body.items).toHaveLength(1);
    expect(body.items[0].rootSession.id).toBe("large-root");
    expect(body.items[0].descendantSessions).toHaveLength(105);
    expect(
      body.items[0].descendantSessions.find(({ id }) => id === "child-104")?.repositories
    ).toEqual([expect.objectContaining({ repoOwner: "chunk-owner", repoName: "chunk-repo" })]);
  });

  it("returns all categories from one coherent snapshot", async () => {
    await serviceFetch("https://example.com/sessions/inbox?category=finished");
    const store = new SessionIndexStore(env.DB);
    await store.create(session("attention", { updatedAt: 5000 }));
    await store.recordLatestTerminalMessage({
      sessionId: "attention",
      messageId: "message-1",
      messageCreatedAt: Date.now(),
      terminalMessageCompletedAt: Date.now(),
    });
    await store.create(session("running", { status: "active", updatedAt: 4000 }));
    for (let index = 0; index < 21; index += 1) {
      await store.create(session(`finished-${index}`, { updatedAt: 3000 - index }));
    }

    const response = await serviceFetch("https://example.com/sessions/inbox");
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    const body = (await response.json()) as {
      categories: Record<
        string,
        {
          items: Array<{ rootSession: { id: string } }>;
          hasMore: boolean;
          nextCursor: string | null;
        }
      >;
    };
    expect(body.categories.needs_attention.items.map((item) => item.rootSession.id)).toEqual([
      "attention",
    ]);
    expect(body.categories.in_progress.items.map((item) => item.rootSession.id)).toEqual([
      "running",
    ]);
    expect(body.categories.finished.items).toHaveLength(20);
    expect(body.categories.finished.items[0].rootSession.id).toBe("finished-0");
    expect(body.categories.finished.hasMore).toBe(true);
    expect(body.categories.finished.nextCursor).not.toBeNull();
    const rootIds = Object.values(body.categories).flatMap((page) =>
      page.items.map((item) => item.rootSession.id)
    );
    expect(rootIds).toHaveLength(new Set(rootIds).size);
  });
});

describe("inbox category conformance", () => {
  beforeEach(cleanD1Tables);

  // The category is decided by a CASE expression inside a query that also uses
  // it as a WHERE predicate and a pagination key, so it cannot move out of SQL.
  // These cases pin the rule by driving real rows through the real query and
  // asserting the category each tree shape must land in. Expectations are
  // stated, not computed: a second implementation to compare against would just
  // be a second thing that can drift.
  const CASES: Array<{
    name: string;
    tree: Array<{ status: SessionEntry["status"]; unread: boolean }>;
    expected: SessionInboxCategory;
  }> = [
    {
      name: "single idle session",
      tree: [{ status: "completed", unread: false }],
      expected: "finished",
    },
    {
      name: "single active session",
      tree: [{ status: "active", unread: false }],
      expected: "in_progress",
    },
    {
      name: "single unread session",
      tree: [{ status: "completed", unread: true }],
      expected: "needs_attention",
    },
    {
      name: "single draft",
      tree: [{ status: "created", unread: false }],
      expected: "finished",
    },
    {
      name: "single failed session",
      tree: [{ status: "failed", unread: false }],
      expected: "finished",
    },
    {
      name: "idle root with an active child",
      tree: [
        { status: "completed", unread: false },
        { status: "active", unread: false },
      ],
      expected: "in_progress",
    },
    {
      name: "idle root with an unread child",
      tree: [
        { status: "completed", unread: false },
        { status: "completed", unread: true },
      ],
      expected: "needs_attention",
    },
    {
      name: "active root with an unread child (attention outranks progress)",
      tree: [
        { status: "active", unread: false },
        { status: "completed", unread: true },
      ],
      expected: "needs_attention",
    },
    {
      name: "wholly finished tree",
      tree: [
        { status: "completed", unread: false },
        { status: "failed", unread: false },
      ],
      expected: "finished",
    },
    // Archived rows are filtered by the eligibility clause before the
    // aggregate runs, so they contribute nothing -- not their unread flag and
    // not their status. These two cases are the only ones that can catch a
    // fold which forgets that, which is why the first draft of this suite
    // omitting `archived` left a real divergence undetected.
    {
      name: "idle root with an archived unread child",
      tree: [
        { status: "completed", unread: false },
        { status: "archived", unread: true },
      ],
      expected: "finished",
    },
    {
      name: "idle root with an archived active child",
      tree: [
        { status: "completed", unread: false },
        { status: "archived", unread: false },
      ],
      expected: "finished",
    },
  ];

  it.each(CASES)("files a $name under $expected", async ({ tree, expected }) => {
    // Prime the viewer row first: unreadSql gates on
    // `latest_terminal_message_completed_at >= viewer.created_at`, so a message
    // seeded before the viewer exists can never read as unread.
    await serviceFetch("https://example.com/sessions/inbox?category=finished");
    const store = new SessionIndexStore(env.DB);
    const rootId = "root";
    const readAfter = Date.now();

    for (const [index, node] of tree.entries()) {
      const id = index === 0 ? rootId : `descendant-${index}`;
      await store.create(
        session(id, {
          status: node.status,
          parentSessionId: index === 0 ? null : rootId,
          spawnSource: index === 0 ? "user" : "agent",
          spawnDepth: index === 0 ? 0 : 1,
          updatedAt: 5000 - index,
        })
      );
      if (node.unread) {
        await store.recordLatestTerminalMessage({
          sessionId: id,
          messageId: `message-${index}`,
          messageCreatedAt: readAfter,
          terminalMessageCompletedAt: readAfter,
        });
      }
    }

    const response = await serviceFetch(`https://example.com/sessions/inbox?category=${expected}`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      items: Array<{ rootSession: { id: string } }>;
    };
    expect(body.items.map(({ rootSession }) => rootSession.id)).toEqual([rootId]);
  });
});
