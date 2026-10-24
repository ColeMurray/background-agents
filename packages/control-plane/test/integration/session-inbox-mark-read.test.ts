import { beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { SessionIndexStore, type SessionEntry } from "../../src/db/session-index";
import { cleanD1Tables } from "./cleanup";
import { serviceFetch } from "./helpers";
import { SESSION_INBOX_LIMIT } from "../../src/routes/session-index";
import { VIEWER_ID, session } from "./session-inbox-test-helpers";

const OTHER_USER_ID = "22222222222222222222222222222222";
const MARK_READ_URL = "https://example.com/sessions/inbox/read-state";

async function createUnread(store: SessionIndexStore, entry: SessionEntry): Promise<void> {
  await store.create(entry);
  await store.recordLatestTerminalMessage({
    sessionId: entry.id,
    messageId: `${entry.id}-message`,
    messageCreatedAt: Date.now(),
    terminalMessageCompletedAt: Date.now(),
  });
}

async function markRead(body: object = {}) {
  return serviceFetch(MARK_READ_URL, { method: "POST", body: JSON.stringify(body) });
}

async function attentionRootIds(query = ""): Promise<string[]> {
  const response = await serviceFetch(
    `https://example.com/sessions/inbox?category=needs_attention${query}`
  );
  const body = await response.json<{ items: Array<{ rootSession: { id: string } }> }>();
  return body.items.map(({ rootSession }) => rootSession.id);
}

async function readSessionIds(): Promise<string[]> {
  const rows = await env.DB.prepare(
    "SELECT session_id FROM session_read_states WHERE user_id = ? ORDER BY session_id"
  )
    .bind(VIEWER_ID)
    .all<{ session_id: string }>();
  return rows.results.map(({ session_id }) => session_id);
}

describe("mark session inbox read", () => {
  beforeEach(async () => {
    await cleanD1Tables();
    // Creates the viewer before any terminal message, so that output counts as unread.
    await serviceFetch("https://example.com/sessions/inbox?category=finished");
  });

  it("marks every unread session, including unloaded pages and descendants", async () => {
    const store = new SessionIndexStore(env.DB);
    const rootCount = SESSION_INBOX_LIMIT + 2;
    for (let index = 0; index < rootCount; index += 1) {
      await createUnread(store, session(`root-${index}`, { updatedAt: 2_000 + index }));
    }
    await store.create(session("read-parent", { updatedAt: 1_500 }));
    await createUnread(
      store,
      session("unread-child", { parentSessionId: "read-parent", spawnDepth: 1, updatedAt: 1_400 })
    );
    expect(await attentionRootIds()).toHaveLength(SESSION_INBOX_LIMIT);

    const response = await markRead();
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await response.json()).toEqual({ markedCount: rootCount + 1 });
    expect(await attentionRootIds()).toEqual([]);

    const finished = await serviceFetch("https://example.com/sessions/inbox?category=finished");
    const finishedBody = await finished.json<{ items: unknown[]; hasMore: boolean }>();
    expect(finishedBody.items).toHaveLength(SESSION_INBOX_LIMIT);
    expect(finishedBody.hasMore).toBe(true);

    expect(await (await markRead()).json()).toEqual({ markedCount: 0 });
  });

  it("leaves output that completes afterwards unread", async () => {
    const store = new SessionIndexStore(env.DB);
    await createUnread(store, session("busy", { updatedAt: 2_000 }));
    await markRead();

    await store.recordLatestTerminalMessage({
      sessionId: "busy",
      messageId: "busy-message-2",
      messageCreatedAt: Date.now() + 1,
      terminalMessageCompletedAt: Date.now() + 1,
    });
    expect(await attentionRootIds()).toEqual(["busy"]);
    expect(await (await markRead()).json()).toEqual({ markedCount: 1 });
    expect(await attentionRootIds()).toEqual([]);
  });

  it("limits marking to the requested filters", async () => {
    await env.DB.prepare(
      "INSERT INTO teams (id, slug, name, created_at, updated_at) VALUES ('team_alpha', 'alpha', 'Alpha', 1, 1), ('team_beta', 'beta', 'Beta', 1, 1)"
    ).run();
    const store = new SessionIndexStore(env.DB);
    await createUnread(store, session("alpha-mine", { ownerTeamId: "team_alpha" }));
    await createUnread(
      store,
      session("alpha-theirs", { ownerTeamId: "team_alpha", userId: OTHER_USER_ID })
    );
    await createUnread(store, session("beta-mine", { ownerTeamId: "team_beta" }));

    expect(await (await markRead({ teamIds: ["team_alpha"], mine: true })).json()).toEqual({
      markedCount: 1,
    });
    expect(await readSessionIds()).toEqual(["alpha-mine"]);

    expect(await (await markRead({ teamIds: ["team_alpha"] })).json()).toEqual({
      markedCount: 1,
    });
    expect(await readSessionIds()).toEqual(["alpha-mine", "alpha-theirs"]);
    expect(await attentionRootIds()).toEqual(["beta-mine"]);
  });

  it("limits marking to one hierarchy and its descendants", async () => {
    const store = new SessionIndexStore(env.DB);
    await createUnread(store, session("parent", { updatedAt: 2_000 }));
    await createUnread(
      store,
      session("child", { parentSessionId: "parent", spawnDepth: 1, updatedAt: 2_100 })
    );
    await createUnread(
      store,
      session("grandchild", { parentSessionId: "child", spawnDepth: 2, updatedAt: 2_200 })
    );
    await createUnread(store, session("other-root", { updatedAt: 1_000 }));

    expect(await (await markRead({ rootSessionId: "child" })).json()).toEqual({
      markedCount: 2,
    });
    expect(await readSessionIds()).toEqual(["child", "grandchild"]);
    expect(await attentionRootIds()).toEqual(["parent", "other-root"]);

    expect(await (await markRead({ rootSessionId: "parent" })).json()).toEqual({
      markedCount: 1,
    });
    expect(await readSessionIds()).toEqual(["child", "grandchild", "parent"]);
    expect(await attentionRootIds()).toEqual(["other-root"]);
  });

  it("marks a hierarchy rerooted by filters without its hidden ancestor", async () => {
    const store = new SessionIndexStore(env.DB);
    await createUnread(store, session("their-parent", { userId: OTHER_USER_ID }));
    await createUnread(
      store,
      session("my-child", { parentSessionId: "their-parent", spawnDepth: 1 })
    );
    await createUnread(
      store,
      session("my-grandchild", { parentSessionId: "my-child", spawnDepth: 2 })
    );
    expect(await attentionRootIds("&mine=true")).toEqual(["my-child"]);

    expect(await (await markRead({ mine: true, rootSessionId: "my-child" })).json()).toEqual({
      markedCount: 2,
    });
    expect(await readSessionIds()).toEqual(["my-child", "my-grandchild"]);
    expect(await attentionRootIds()).toEqual(["their-parent"]);
  });

  it("never marks sessions the viewer cannot see", async () => {
    const store = new SessionIndexStore(env.DB);
    await createUnread(store, session("visible"));
    await createUnread(store, session("archived", { status: "archived" }));
    await createUnread(
      store,
      session("someone-elses-private", { visibility: "private", userId: OTHER_USER_ID })
    );

    expect(await (await markRead()).json()).toEqual({ markedCount: 1 });
    expect(await readSessionIds()).toEqual(["visible"]);
  });

  it("rejects malformed bodies and service callers", async () => {
    expect((await markRead({ unexpected: true })).status).toBe(400);
    expect((await markRead({ teamIds: ["not-a-team"] })).status).toBe(400);
    const serviceResponse = await serviceFetch(MARK_READ_URL, {
      method: "POST",
      service: "github-bot",
      body: JSON.stringify({}),
    });
    expect(serviceResponse.status).toBe(403);
  });
});
