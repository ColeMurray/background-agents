import { beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { SessionIndexStore, type SessionEntry } from "../../src/db/session-index";
import { cleanD1Tables } from "./cleanup";
import { serviceFetch } from "./helpers";

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

  it("paginates roots independently with cursors", async () => {
    await serviceFetch("https://example.com/sessions/inbox?category=finished");
    const store = new SessionIndexStore(env.DB);
    for (let index = 0; index < 21; index += 1) {
      await store.create(session(`root-${index}`, { updatedAt: 3000 - index }));
    }

    const first = await serviceFetch("https://example.com/sessions/inbox?category=finished");
    const firstBody = (await first.json()) as {
      items: Array<{ rootSession: { id: string } }>;
      hasMore: boolean;
      nextCursor: string;
    };
    expect(firstBody.items).toHaveLength(20);
    expect(firstBody.items[0].rootSession.id).toBe("root-0");
    expect(firstBody.hasMore).toBe(true);

    const second = await serviceFetch(
      `https://example.com/sessions/inbox?category=finished&cursor=${encodeURIComponent(firstBody.nextCursor)}`
    );
    const secondBody = (await second.json()) as {
      items: Array<{ rootSession: { id: string } }>;
      hasMore: boolean;
      nextCursor: null;
    };
    expect(secondBody.items[0].rootSession.id).toBe("root-20");
    expect(secondBody.hasMore).toBe(false);
    expect(secondBody.nextCursor).toBeNull();
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
    await store.create(session("finished", { updatedAt: 3000 }));

    const response = await serviceFetch("https://example.com/sessions/inbox");
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    const body = (await response.json()) as {
      categories: Record<string, { items: Array<{ rootSession: { id: string } }> }>;
    };
    expect(body.categories.needs_attention.items.map((item) => item.rootSession.id)).toEqual([
      "attention",
    ]);
    expect(body.categories.in_progress.items.map((item) => item.rootSession.id)).toEqual([
      "running",
    ]);
    expect(body.categories.finished.items.map((item) => item.rootSession.id)).toEqual(["finished"]);
    const rootIds = Object.values(body.categories).flatMap((page) =>
      page.items.map((item) => item.rootSession.id)
    );
    expect(rootIds).toHaveLength(new Set(rootIds).size);
  });
});
