import { beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { buildViewerSessionUnreadStatesQuery, SessionIndexStore } from "../../src/db/session-index";
import { cleanD1Tables } from "./cleanup";
import { serviceFetch } from "./helpers";
import type { SqlDatabase } from "../../src/db/sql-database";

const BROWSER_USER_ID = "11111111111111111111111111111111";

async function createUser(userId: string, createdAt: number): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO users (id, display_name, email, avatar_url, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  )
    .bind(userId, userId, `${userId}@test.local`, null, createdAt, createdAt)
    .run();
}

async function createSession(store: SessionIndexStore, sessionId: string, updatedAt = 1_000) {
  await store.create({
    id: sessionId,
    title: sessionId,
    repoOwner: "acme",
    repoName: "web",
    model: "anthropic/claude-haiku-4-5",
    reasoningEffort: null,
    baseBranch: "main",
    status: "completed",
    createdAt: 500,
    updatedAt,
  });
}

describe("session read state", () => {
  beforeEach(cleanD1Tables);

  it("projects terminal outcomes in message order without changing session order", async () => {
    const store = new SessionIndexStore(env.DB);
    await createSession(store, "newer-session", 2_000);
    await createSession(store, "attention-session", 1_000);

    expect(
      await store.recordLatestAttention({
        sessionId: "attention-session",
        messageId: "message-b",
        messageCreatedAt: 200,
        acceptedAt: 2_000,
      })
    ).toBe(true);
    expect(
      await store.recordLatestAttention({
        sessionId: "attention-session",
        messageId: "message-z",
        messageCreatedAt: 100,
        acceptedAt: 3_000,
      })
    ).toBe(false);
    expect(
      await store.recordLatestAttention({
        sessionId: "attention-session",
        messageId: "message-a",
        messageCreatedAt: 200,
        acceptedAt: 4_000,
      })
    ).toBe(false);
    expect(
      await store.recordLatestAttention({
        sessionId: "attention-session",
        messageId: "message-c",
        messageCreatedAt: 200,
        acceptedAt: 5_000,
      })
    ).toBe(true);

    const row = await env.DB.prepare(
      `SELECT latest_attention_message_id, latest_attention_message_created_at,
              latest_attention_at, updated_at
       FROM sessions WHERE id = ?`
    )
      .bind("attention-session")
      .first<Record<string, number | string>>();
    expect(row).toMatchObject({
      latest_attention_message_id: "message-c",
      latest_attention_message_created_at: 200,
      latest_attention_at: 5_000,
      updated_at: 1_000,
    });

    expect((await store.list()).sessions.map(({ id }) => id)).toEqual([
      "newer-session",
      "attention-session",
    ]);
  });

  it("isolates user cursors and treats eligible missing rows as unread", async () => {
    const store = new SessionIndexStore(env.DB);
    await createUser("user-a", 1_000);
    await createUser("user-b", 1_000);
    await createSession(store, "shared-session");
    await store.recordLatestAttention({
      sessionId: "shared-session",
      messageId: "message-a",
      messageCreatedAt: 1_500,
      acceptedAt: 2_000,
    });

    expect((await store.list({ viewerUserId: "user-a" })).sessions[0].navigation).toEqual({
      unread: true,
      attentionId: "message-a",
    });
    expect((await store.list({ viewerUserId: "user-b" })).sessions[0].navigation).toEqual({
      unread: true,
      attentionId: "message-a",
    });

    expect(
      await store.updateReadState("user-a", "shared-session", {
        kind: "acknowledge",
        observedAttentionId: "message-a",
      })
    ).toEqual({
      sessionId: "shared-session",
      accepted: true,
      unread: false,
      attentionId: "message-a",
    });
    expect((await store.list({ viewerUserId: "user-a" })).sessions[0].navigation).toEqual({
      unread: false,
      attentionId: "message-a",
    });
    expect((await store.list({ viewerUserId: "user-b" })).sessions[0].navigation).toEqual({
      unread: true,
      attentionId: "message-a",
    });
  });

  it("rejects stale acknowledgements and lets mark-read snapshot the latest outcome", async () => {
    const store = new SessionIndexStore(env.DB);
    await createUser("user-a", 1_000);
    await createSession(store, "racing-session");
    await store.recordLatestAttention({
      sessionId: "racing-session",
      messageId: "message-b",
      messageCreatedAt: 2_000,
      acceptedAt: 2_500,
    });

    expect(
      await store.updateReadState("user-a", "racing-session", {
        kind: "acknowledge",
        observedAttentionId: "message-a",
      })
    ).toEqual({
      sessionId: "racing-session",
      accepted: false,
      unread: true,
      attentionId: "message-b",
    });
    expect(await store.updateReadState("user-a", "racing-session", { kind: "mark_read" })).toEqual({
      sessionId: "racing-session",
      accepted: true,
      unread: false,
      attentionId: "message-b",
    });
  });

  it("does not surface outcomes accepted before the user existed", async () => {
    const store = new SessionIndexStore(env.DB);
    await createUser("new-user", 5_000);
    await createSession(store, "historical-session");
    await store.recordLatestAttention({
      sessionId: "historical-session",
      messageId: "historical-message",
      messageCreatedAt: 1_000,
      acceptedAt: 4_999,
    });

    expect((await store.list({ viewerUserId: "new-user" })).sessions[0].navigation).toEqual({
      unread: false,
      attentionId: "historical-message",
    });
  });

  it("keeps sessions without outcomes read and preserves cursors across archive", async () => {
    const store = new SessionIndexStore(env.DB);
    await createUser("viewer", 1_000);
    await createSession(store, "lifecycle-session");

    expect((await store.list({ viewerUserId: "viewer" })).sessions[0].navigation).toEqual({
      unread: false,
      attentionId: null,
    });
    expect(
      await store.updateReadState("viewer", "lifecycle-session", { kind: "mark_read" })
    ).toEqual({
      sessionId: "lifecycle-session",
      accepted: true,
      unread: false,
      attentionId: null,
    });

    await store.recordLatestAttention({
      sessionId: "lifecycle-session",
      messageId: "message-1",
      messageCreatedAt: 2_000,
      acceptedAt: 3_000,
    });
    await store.updateReadState("viewer", "lifecycle-session", { kind: "mark_read" });
    await store.updateStatus("lifecycle-session", "archived", 4_000);
    await store.updateStatus("lifecycle-session", "completed", 5_000);

    expect((await store.list({ viewerUserId: "viewer" })).sessions[0].navigation).toEqual({
      unread: false,
      attentionId: "message-1",
    });
  });

  it("cascades read rows when either parent row is deleted", async () => {
    const store = new SessionIndexStore(env.DB);
    await createUser("deleted-user", 1_000);
    await createSession(store, "deleted-session");
    await store.recordLatestAttention({
      sessionId: "deleted-session",
      messageId: "message-a",
      messageCreatedAt: 1_500,
      acceptedAt: 2_000,
    });
    await store.updateReadState("deleted-user", "deleted-session", { kind: "mark_read" });

    await env.DB.prepare("DELETE FROM users WHERE id = ?").bind("deleted-user").run();
    expect(await env.DB.prepare("SELECT * FROM session_read_states").all()).toMatchObject({
      results: [],
    });

    await createUser("deleted-user", 1_000);
    await store.updateReadState("deleted-user", "deleted-session", { kind: "mark_read" });
    await store.delete("deleted-session");
    expect(await env.DB.prepare("SELECT * FROM session_read_states").all()).toMatchObject({
      results: [],
    });
  });

  it("exposes canonical viewer state through the authenticated API", async () => {
    await serviceFetch("https://example.com/sessions");
    const store = new SessionIndexStore(env.DB);
    await createSession(store, "api-session");
    await store.recordLatestAttention({
      sessionId: "api-session",
      messageId: "message-a",
      messageCreatedAt: Date.now(),
      acceptedAt: Date.now(),
    });

    const listResponse = await serviceFetch("https://example.com/sessions");
    expect(listResponse.headers.get("Cache-Control")).toBe("private, no-store");
    expect((await listResponse.json()).sessions[0].navigation).toEqual({
      unread: true,
      attentionId: "message-a",
    });

    const staleResponse = await serviceFetch(
      "https://example.com/sessions/api-session/read-state",
      {
        method: "PATCH",
        body: JSON.stringify({ action: "acknowledge", observedAttentionId: "stale-message" }),
      }
    );
    expect(staleResponse.status).toBe(200);
    expect(staleResponse.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await staleResponse.json()).toEqual({
      sessionId: "api-session",
      accepted: false,
      unread: true,
      attentionId: "message-a",
    });

    const acceptedResponse = await serviceFetch(
      "https://example.com/sessions/api-session/read-state",
      {
        method: "PATCH",
        body: JSON.stringify({ action: "acknowledge", observedAttentionId: "message-a" }),
      }
    );
    expect(await acceptedResponse.json()).toEqual({
      sessionId: "api-session",
      accepted: true,
      unread: false,
      attentionId: "message-a",
    });

    const serviceResponse = await serviceFetch(
      "https://example.com/sessions/api-session/read-state",
      {
        method: "PATCH",
        service: "github-bot",
        body: JSON.stringify({ action: "mark_read", userId: BROWSER_USER_ID }),
      }
    );
    expect(serviceResponse.status).toBe(403);
  });

  it("decorates a 50-row page with a fixed number of indexed batch queries", async () => {
    const seedStore = new SessionIndexStore(env.DB);
    await createUser("viewer", 1_000);
    for (let index = 0; index < 50; index += 1) {
      const sessionId = `page-session-${index.toString().padStart(2, "0")}`;
      await createSession(seedStore, sessionId, 10_000 - index);
      await seedStore.recordLatestAttention({
        sessionId,
        messageId: `message-${index}`,
        messageCreatedAt: 2_000 + index,
        acceptedAt: 3_000 + index,
      });
    }

    let queryCount = 0;
    const countedDb = {
      prepare(query: string) {
        queryCount += 1;
        return env.DB.prepare(query);
      },
      batch(statements: D1PreparedStatement[]) {
        return env.DB.batch(statements);
      },
    } as SqlDatabase;
    const result = await new SessionIndexStore(countedDb).list({ viewerUserId: "viewer" });

    expect(result.sessions).toHaveLength(50);
    expect(result.sessions.every((session) => session.navigation?.unread)).toBe(true);
    expect(queryCount).toBe(4);

    const indexes = await env.DB.prepare("PRAGMA index_list('session_read_states')").all<{
      name: string;
    }>();
    expect(indexes.results.map(({ name }) => name)).toContain("idx_session_read_states_session");

    const sessionIds = result.sessions.map(({ id }) => id);
    const queryPlan = await env.DB.prepare(
      `EXPLAIN QUERY PLAN ${buildViewerSessionUnreadStatesQuery(sessionIds.length)}`
    )
      .bind("viewer", ...sessionIds)
      .all<{ detail: string }>();
    expect(queryPlan.results.map(({ detail }) => detail).join("\n")).toMatch(
      /INDEX .*session_read_states/i
    );
  });

  it("chunks navigation decoration for a 100-row page within D1 binding limits", async () => {
    const store = new SessionIndexStore(env.DB);
    await createUser("viewer", 1_000);
    for (let index = 0; index < 100; index += 1) {
      await createSession(store, `large-page-${index.toString().padStart(3, "0")}`, 10_000 - index);
    }

    const result = await store.list({ viewerUserId: "viewer", limit: 100 });

    expect(result.sessions).toHaveLength(100);
    expect(result.sessions.every((session) => session.navigation?.unread === false)).toBe(true);
  });
});
