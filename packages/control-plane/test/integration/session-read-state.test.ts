import { beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { SessionIndexStore } from "../../src/db/session-index";
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

  it("projects terminal messages in message order without changing session order", async () => {
    const store = new SessionIndexStore(env.DB);
    await createSession(store, "newer-session", 2_000);
    await createSession(store, "terminal-message-session", 1_000);

    expect(
      await store.recordLatestTerminalMessage({
        sessionId: "terminal-message-session",
        messageId: "message-b",
        messageCreatedAt: 200,
        terminalMessageCompletedAt: 2_000,
      })
    ).toBe(true);
    expect(
      await store.recordLatestTerminalMessage({
        sessionId: "terminal-message-session",
        messageId: "message-z",
        messageCreatedAt: 100,
        terminalMessageCompletedAt: 3_000,
      })
    ).toBe(false);
    expect(
      await store.recordLatestTerminalMessage({
        sessionId: "terminal-message-session",
        messageId: "message-a",
        messageCreatedAt: 200,
        terminalMessageCompletedAt: 4_000,
      })
    ).toBe(false);
    expect(
      await store.recordLatestTerminalMessage({
        sessionId: "terminal-message-session",
        messageId: "message-c",
        messageCreatedAt: 200,
        terminalMessageCompletedAt: 5_000,
      })
    ).toBe(true);

    const row = await env.DB.prepare(
      `SELECT latest_terminal_message_id, latest_terminal_message_created_at,
               latest_terminal_message_completed_at, updated_at
       FROM sessions WHERE id = ?`
    )
      .bind("terminal-message-session")
      .first<Record<string, number | string>>();
    expect(row).toMatchObject({
      latest_terminal_message_id: "message-c",
      latest_terminal_message_created_at: 200,
      latest_terminal_message_completed_at: 5_000,
      updated_at: 1_000,
    });

    expect((await store.list()).sessions.map(({ id }) => id)).toEqual([
      "newer-session",
      "terminal-message-session",
    ]);
  });

  it("rejects partial terminal-message projections and read states", async () => {
    const store = new SessionIndexStore(env.DB);
    await createUser("viewer", 1_000);
    await createSession(store, "constrained-session");

    await expect(
      env.DB.prepare(
        `UPDATE sessions
         SET latest_terminal_message_id = ?
         WHERE id = ?`
      )
        .bind("message-1", "constrained-session")
        .run()
    ).rejects.toThrow();
    await expect(
      env.DB.prepare(
        `UPDATE sessions
         SET latest_terminal_message_id = ?,
             latest_terminal_message_created_at = ?,
             latest_terminal_message_completed_at = ?
         WHERE id = ?`
      )
        .bind("message-1", 2_000, 1_999, "constrained-session")
        .run()
    ).rejects.toThrow();
    await expect(
      env.DB.prepare(
        `INSERT INTO session_read_states
           (user_id, session_id, last_read_message_id, updated_at)
         VALUES (?, ?, NULL, ?)`
      )
        .bind("viewer", "constrained-session", 2_000)
        .run()
    ).rejects.toThrow();
  });

  it("isolates viewer read states and treats eligible missing rows as unread", async () => {
    const store = new SessionIndexStore(env.DB);
    await createUser("user-a", 1_000);
    await createUser("user-b", 1_000);
    await createSession(store, "shared-session");
    await store.recordLatestTerminalMessage({
      sessionId: "shared-session",
      messageId: "message-a",
      messageCreatedAt: 1_500,
      terminalMessageCompletedAt: 2_000,
    });

    expect((await store.list({ viewerUserId: "user-a" })).sessions[0].readState).toEqual({
      unread: true,
      latestMessageId: "message-a",
    });
    expect((await store.list({ viewerUserId: "user-b" })).sessions[0].readState).toEqual({
      unread: true,
      latestMessageId: "message-a",
    });

    expect(
      await store.updateReadState("user-a", "shared-session", {
        action: "mark_message_read",
        messageId: "message-a",
      })
    ).toEqual({
      sessionId: "shared-session",
      outcome: "marked_read",
      unread: false,
      latestMessageId: "message-a",
    });
    expect(
      await store.updateReadState("user-a", "shared-session", {
        action: "mark_message_read",
        messageId: "message-a",
      })
    ).toEqual({
      sessionId: "shared-session",
      outcome: "already_read",
      unread: false,
      latestMessageId: "message-a",
    });
    expect((await store.list({ viewerUserId: "user-a" })).sessions[0].readState).toEqual({
      unread: false,
      latestMessageId: "message-a",
    });
    expect((await store.list({ viewerUserId: "user-b" })).sessions[0].readState).toEqual({
      unread: true,
      latestMessageId: "message-a",
    });
  });

  it("reports stale exact reads and lets the latest-read action snapshot the current outcome", async () => {
    const store = new SessionIndexStore(env.DB);
    await createUser("user-a", 1_000);
    await createSession(store, "racing-session");
    await store.recordLatestTerminalMessage({
      sessionId: "racing-session",
      messageId: "message-b",
      messageCreatedAt: 2_000,
      terminalMessageCompletedAt: 2_500,
    });

    expect(
      await store.updateReadState("user-a", "racing-session", {
        action: "mark_message_read",
        messageId: "message-a",
      })
    ).toEqual({
      sessionId: "racing-session",
      outcome: "not_latest",
      unread: true,
      latestMessageId: "message-b",
    });
    expect(
      await store.updateReadState("user-a", "racing-session", {
        action: "mark_latest_message_read",
      })
    ).toEqual({
      sessionId: "racing-session",
      outcome: "marked_read",
      unread: false,
      latestMessageId: "message-b",
    });
  });

  it("does not surface outcomes completed before the user existed", async () => {
    const store = new SessionIndexStore(env.DB);
    await createUser("new-user", 5_000);
    await createSession(store, "historical-session");
    await store.recordLatestTerminalMessage({
      sessionId: "historical-session",
      messageId: "historical-message",
      messageCreatedAt: 1_000,
      terminalMessageCompletedAt: 4_999,
    });

    expect((await store.list({ viewerUserId: "new-user" })).sessions[0].readState).toEqual({
      unread: false,
      latestMessageId: "historical-message",
    });
  });

  it("keeps sessions without outcomes read and preserves read state across archive", async () => {
    const store = new SessionIndexStore(env.DB);
    await createUser("viewer", 1_000);
    await createSession(store, "lifecycle-session");

    expect((await store.list({ viewerUserId: "viewer" })).sessions[0].readState).toEqual({
      unread: false,
      latestMessageId: null,
    });
    expect(
      await store.updateReadState("viewer", "lifecycle-session", {
        action: "mark_latest_message_read",
      })
    ).toEqual({
      sessionId: "lifecycle-session",
      outcome: "no_terminal_message",
      unread: false,
      latestMessageId: null,
    });

    await store.recordLatestTerminalMessage({
      sessionId: "lifecycle-session",
      messageId: "message-1",
      messageCreatedAt: 2_000,
      terminalMessageCompletedAt: 3_000,
    });
    await store.updateReadState("viewer", "lifecycle-session", {
      action: "mark_latest_message_read",
    });
    await store.updateStatus("lifecycle-session", "archived", 4_000);
    await store.updateStatus("lifecycle-session", "completed", 5_000);

    expect((await store.list({ viewerUserId: "viewer" })).sessions[0].readState).toEqual({
      unread: false,
      latestMessageId: "message-1",
    });
  });

  it("cascades read rows when either parent row is deleted", async () => {
    const store = new SessionIndexStore(env.DB);
    await createUser("deleted-user", 1_000);
    await createSession(store, "deleted-session");
    await store.recordLatestTerminalMessage({
      sessionId: "deleted-session",
      messageId: "message-a",
      messageCreatedAt: 1_500,
      terminalMessageCompletedAt: 2_000,
    });
    await store.updateReadState("deleted-user", "deleted-session", {
      action: "mark_latest_message_read",
    });

    await env.DB.prepare("DELETE FROM users WHERE id = ?").bind("deleted-user").run();
    expect(await env.DB.prepare("SELECT * FROM session_read_states").all()).toMatchObject({
      results: [],
    });

    await createUser("deleted-user", 1_000);
    await store.updateReadState("deleted-user", "deleted-session", {
      action: "mark_latest_message_read",
    });
    await store.delete("deleted-session");
    expect(await env.DB.prepare("SELECT * FROM session_read_states").all()).toMatchObject({
      results: [],
    });
  });

  it("exposes canonical viewer state through the authenticated API", async () => {
    await serviceFetch("https://example.com/sessions");
    const store = new SessionIndexStore(env.DB);
    await createSession(store, "api-session");
    await store.recordLatestTerminalMessage({
      sessionId: "api-session",
      messageId: "message-a",
      messageCreatedAt: Date.now(),
      terminalMessageCompletedAt: Date.now(),
    });

    const listResponse = await serviceFetch("https://example.com/sessions");
    expect(listResponse.headers.get("Cache-Control")).toBe("private, no-store");
    expect((await listResponse.json()).sessions[0].readState).toEqual({
      unread: true,
      latestMessageId: "message-a",
    });

    const staleResponse = await serviceFetch(
      "https://example.com/sessions/api-session/read-state",
      {
        method: "PATCH",
        body: JSON.stringify({
          action: "mark_message_read",
          messageId: "stale-message",
        }),
      }
    );
    expect(staleResponse.status).toBe(200);
    expect(staleResponse.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await staleResponse.json()).toEqual({
      sessionId: "api-session",
      outcome: "not_latest",
      unread: true,
      latestMessageId: "message-a",
    });

    const markedReadResponse = await serviceFetch(
      "https://example.com/sessions/api-session/read-state",
      {
        method: "PATCH",
        body: JSON.stringify({
          action: "mark_message_read",
          messageId: "message-a",
        }),
      }
    );
    expect(await markedReadResponse.json()).toEqual({
      sessionId: "api-session",
      outcome: "marked_read",
      unread: false,
      latestMessageId: "message-a",
    });

    const serviceResponse = await serviceFetch(
      "https://example.com/sessions/api-session/read-state",
      {
        method: "PATCH",
        service: "github-bot",
        body: JSON.stringify({
          action: "mark_latest_message_read",
          userId: BROWSER_USER_ID,
        }),
      }
    );
    expect(serviceResponse.status).toBe(403);
  });

  it("decorates a 50-row page in three indexed queries", async () => {
    const seedStore = new SessionIndexStore(env.DB);
    await createUser("viewer", 1_000);
    for (let index = 0; index < 50; index += 1) {
      const sessionId = `page-session-${index.toString().padStart(2, "0")}`;
      await createSession(seedStore, sessionId, 10_000 - index);
      await seedStore.recordLatestTerminalMessage({
        sessionId,
        messageId: `message-${index}`,
        messageCreatedAt: 2_000 + index,
        terminalMessageCompletedAt: 3_000 + index,
      });
    }

    let queryCount = 0;
    const preparedQueries: string[] = [];
    const countedDb = {
      prepare(query: string) {
        queryCount += 1;
        preparedQueries.push(query);
        return env.DB.prepare(query);
      },
      batch(statements: D1PreparedStatement[]) {
        return env.DB.batch(statements);
      },
    } as SqlDatabase;
    const result = await new SessionIndexStore(countedDb).list({ viewerUserId: "viewer" });

    expect(result.sessions).toHaveLength(50);
    expect(result.sessions.every((session) => session.readState?.unread)).toBe(true);
    expect(queryCount).toBe(3);

    const indexes = await env.DB.prepare("PRAGMA index_list('session_read_states')").all<{
      name: string;
    }>();
    expect(indexes.results.map(({ name }) => name)).toContain("idx_session_read_states_session");

    const pageQuery = preparedQueries.find((query) => query.includes("WITH paged_sessions AS"));
    expect(pageQuery).toBeDefined();
    const queryPlan = await env.DB.prepare(`EXPLAIN QUERY PLAN ${pageQuery}`)
      .bind(51, 0, "viewer")
      .all<{ detail: string }>();
    expect(queryPlan.results.map(({ detail }) => detail).join("\n")).toMatch(
      /SEARCH read_state USING/i
    );
  });

  it("decorates a 100-row page without per-session query bindings", async () => {
    const store = new SessionIndexStore(env.DB);
    await createUser("viewer", 1_000);
    for (let index = 0; index < 100; index += 1) {
      await createSession(store, `large-page-${index.toString().padStart(3, "0")}`, 10_000 - index);
    }

    const result = await store.list({ viewerUserId: "viewer", limit: 100 });

    expect(result.sessions).toHaveLength(100);
    expect(result.sessions.every((session) => session.readState?.unread === false)).toBe(true);
  });
});
