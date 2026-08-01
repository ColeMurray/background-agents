import { beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import {
  buildViewerSessionTerminalOutcomeReadStatesQuery,
  SessionIndexStore,
} from "../../src/db/session-index";
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

describe("session terminal-outcome read state", () => {
  beforeEach(cleanD1Tables);

  it("projects terminal outcomes in message order without changing session order", async () => {
    const store = new SessionIndexStore(env.DB);
    await createSession(store, "newer-session", 2_000);
    await createSession(store, "terminal-outcome-session", 1_000);

    expect(
      await store.recordLatestTerminalOutcome({
        sessionId: "terminal-outcome-session",
        messageId: "message-b",
        messageCreatedAt: 200,
        terminalOutcomeCompletedAt: 2_000,
      })
    ).toBe(true);
    expect(
      await store.recordLatestTerminalOutcome({
        sessionId: "terminal-outcome-session",
        messageId: "message-z",
        messageCreatedAt: 100,
        terminalOutcomeCompletedAt: 3_000,
      })
    ).toBe(false);
    expect(
      await store.recordLatestTerminalOutcome({
        sessionId: "terminal-outcome-session",
        messageId: "message-a",
        messageCreatedAt: 200,
        terminalOutcomeCompletedAt: 4_000,
      })
    ).toBe(false);
    expect(
      await store.recordLatestTerminalOutcome({
        sessionId: "terminal-outcome-session",
        messageId: "message-c",
        messageCreatedAt: 200,
        terminalOutcomeCompletedAt: 5_000,
      })
    ).toBe(true);

    const row = await env.DB.prepare(
      `SELECT latest_terminal_outcome_message_id, latest_terminal_outcome_message_created_at,
               latest_terminal_outcome_completed_at, updated_at
       FROM sessions WHERE id = ?`
    )
      .bind("terminal-outcome-session")
      .first<Record<string, number | string>>();
    expect(row).toMatchObject({
      latest_terminal_outcome_message_id: "message-c",
      latest_terminal_outcome_message_created_at: 200,
      latest_terminal_outcome_completed_at: 5_000,
      updated_at: 1_000,
    });

    expect((await store.list()).sessions.map(({ id }) => id)).toEqual([
      "newer-session",
      "terminal-outcome-session",
    ]);
  });

  it("rejects partial terminal-outcome projections and read states", async () => {
    const store = new SessionIndexStore(env.DB);
    await createUser("viewer", 1_000);
    await createSession(store, "constrained-session");

    await expect(
      env.DB.prepare(
        `UPDATE sessions
         SET latest_terminal_outcome_message_id = ?
         WHERE id = ?`
      )
        .bind("message-1", "constrained-session")
        .run()
    ).rejects.toThrow();
    await expect(
      env.DB.prepare(
        `UPDATE sessions
         SET latest_terminal_outcome_message_id = ?,
             latest_terminal_outcome_message_created_at = ?,
             latest_terminal_outcome_completed_at = ?
         WHERE id = ?`
      )
        .bind("message-1", 2_000, 1_999, "constrained-session")
        .run()
    ).rejects.toThrow();
    await expect(
      env.DB.prepare(
        `INSERT INTO session_terminal_outcome_read_states
           (user_id, session_id, last_read_terminal_outcome_message_id, updated_at)
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
    await store.recordLatestTerminalOutcome({
      sessionId: "shared-session",
      messageId: "message-a",
      messageCreatedAt: 1_500,
      terminalOutcomeCompletedAt: 2_000,
    });

    expect(
      (await store.list({ viewerUserId: "user-a" })).sessions[0].terminalOutcomeReadState
    ).toEqual({
      hasUnreadTerminalOutcome: true,
      latestTerminalOutcomeMessageId: "message-a",
    });
    expect(
      (await store.list({ viewerUserId: "user-b" })).sessions[0].terminalOutcomeReadState
    ).toEqual({
      hasUnreadTerminalOutcome: true,
      latestTerminalOutcomeMessageId: "message-a",
    });

    expect(
      await store.updateTerminalOutcomeReadState("user-a", "shared-session", {
        action: "mark_terminal_outcome_read",
        terminalOutcomeMessageId: "message-a",
      })
    ).toEqual({
      sessionId: "shared-session",
      outcome: "marked_read",
      hasUnreadTerminalOutcome: false,
      latestTerminalOutcomeMessageId: "message-a",
    });
    expect(
      await store.updateTerminalOutcomeReadState("user-a", "shared-session", {
        action: "mark_terminal_outcome_read",
        terminalOutcomeMessageId: "message-a",
      })
    ).toEqual({
      sessionId: "shared-session",
      outcome: "already_read",
      hasUnreadTerminalOutcome: false,
      latestTerminalOutcomeMessageId: "message-a",
    });
    expect(
      (await store.list({ viewerUserId: "user-a" })).sessions[0].terminalOutcomeReadState
    ).toEqual({
      hasUnreadTerminalOutcome: false,
      latestTerminalOutcomeMessageId: "message-a",
    });
    expect(
      (await store.list({ viewerUserId: "user-b" })).sessions[0].terminalOutcomeReadState
    ).toEqual({
      hasUnreadTerminalOutcome: true,
      latestTerminalOutcomeMessageId: "message-a",
    });
  });

  it("reports stale exact reads and lets the latest-read action snapshot the current outcome", async () => {
    const store = new SessionIndexStore(env.DB);
    await createUser("user-a", 1_000);
    await createSession(store, "racing-session");
    await store.recordLatestTerminalOutcome({
      sessionId: "racing-session",
      messageId: "message-b",
      messageCreatedAt: 2_000,
      terminalOutcomeCompletedAt: 2_500,
    });

    expect(
      await store.updateTerminalOutcomeReadState("user-a", "racing-session", {
        action: "mark_terminal_outcome_read",
        terminalOutcomeMessageId: "message-a",
      })
    ).toEqual({
      sessionId: "racing-session",
      outcome: "not_latest",
      hasUnreadTerminalOutcome: true,
      latestTerminalOutcomeMessageId: "message-b",
    });
    expect(
      await store.updateTerminalOutcomeReadState("user-a", "racing-session", {
        action: "mark_latest_terminal_outcome_read",
      })
    ).toEqual({
      sessionId: "racing-session",
      outcome: "marked_read",
      hasUnreadTerminalOutcome: false,
      latestTerminalOutcomeMessageId: "message-b",
    });
  });

  it("does not surface outcomes completed before the user existed", async () => {
    const store = new SessionIndexStore(env.DB);
    await createUser("new-user", 5_000);
    await createSession(store, "historical-session");
    await store.recordLatestTerminalOutcome({
      sessionId: "historical-session",
      messageId: "historical-message",
      messageCreatedAt: 1_000,
      terminalOutcomeCompletedAt: 4_999,
    });

    expect(
      (await store.list({ viewerUserId: "new-user" })).sessions[0].terminalOutcomeReadState
    ).toEqual({
      hasUnreadTerminalOutcome: false,
      latestTerminalOutcomeMessageId: "historical-message",
    });
  });

  it("keeps sessions without outcomes read and preserves read state across archive", async () => {
    const store = new SessionIndexStore(env.DB);
    await createUser("viewer", 1_000);
    await createSession(store, "lifecycle-session");

    expect(
      (await store.list({ viewerUserId: "viewer" })).sessions[0].terminalOutcomeReadState
    ).toEqual({
      hasUnreadTerminalOutcome: false,
      latestTerminalOutcomeMessageId: null,
    });
    expect(
      await store.updateTerminalOutcomeReadState("viewer", "lifecycle-session", {
        action: "mark_latest_terminal_outcome_read",
      })
    ).toEqual({
      sessionId: "lifecycle-session",
      outcome: "no_terminal_outcome",
      hasUnreadTerminalOutcome: false,
      latestTerminalOutcomeMessageId: null,
    });

    await store.recordLatestTerminalOutcome({
      sessionId: "lifecycle-session",
      messageId: "message-1",
      messageCreatedAt: 2_000,
      terminalOutcomeCompletedAt: 3_000,
    });
    await store.updateTerminalOutcomeReadState("viewer", "lifecycle-session", {
      action: "mark_latest_terminal_outcome_read",
    });
    await store.updateStatus("lifecycle-session", "archived", 4_000);
    await store.updateStatus("lifecycle-session", "completed", 5_000);

    expect(
      (await store.list({ viewerUserId: "viewer" })).sessions[0].terminalOutcomeReadState
    ).toEqual({
      hasUnreadTerminalOutcome: false,
      latestTerminalOutcomeMessageId: "message-1",
    });
  });

  it("cascades read rows when either parent row is deleted", async () => {
    const store = new SessionIndexStore(env.DB);
    await createUser("deleted-user", 1_000);
    await createSession(store, "deleted-session");
    await store.recordLatestTerminalOutcome({
      sessionId: "deleted-session",
      messageId: "message-a",
      messageCreatedAt: 1_500,
      terminalOutcomeCompletedAt: 2_000,
    });
    await store.updateTerminalOutcomeReadState("deleted-user", "deleted-session", {
      action: "mark_latest_terminal_outcome_read",
    });

    await env.DB.prepare("DELETE FROM users WHERE id = ?").bind("deleted-user").run();
    expect(
      await env.DB.prepare("SELECT * FROM session_terminal_outcome_read_states").all()
    ).toMatchObject({ results: [] });

    await createUser("deleted-user", 1_000);
    await store.updateTerminalOutcomeReadState("deleted-user", "deleted-session", {
      action: "mark_latest_terminal_outcome_read",
    });
    await store.delete("deleted-session");
    expect(
      await env.DB.prepare("SELECT * FROM session_terminal_outcome_read_states").all()
    ).toMatchObject({ results: [] });
  });

  it("exposes canonical viewer state through the authenticated API", async () => {
    await serviceFetch("https://example.com/sessions");
    const store = new SessionIndexStore(env.DB);
    await createSession(store, "api-session");
    await store.recordLatestTerminalOutcome({
      sessionId: "api-session",
      messageId: "message-a",
      messageCreatedAt: Date.now(),
      terminalOutcomeCompletedAt: Date.now(),
    });

    const listResponse = await serviceFetch("https://example.com/sessions");
    expect(listResponse.headers.get("Cache-Control")).toBe("private, no-store");
    expect((await listResponse.json()).sessions[0].terminalOutcomeReadState).toEqual({
      hasUnreadTerminalOutcome: true,
      latestTerminalOutcomeMessageId: "message-a",
    });

    const staleResponse = await serviceFetch(
      "https://example.com/sessions/api-session/terminal-outcome-read-state",
      {
        method: "PATCH",
        body: JSON.stringify({
          action: "mark_terminal_outcome_read",
          terminalOutcomeMessageId: "stale-message",
        }),
      }
    );
    expect(staleResponse.status).toBe(200);
    expect(staleResponse.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await staleResponse.json()).toEqual({
      sessionId: "api-session",
      outcome: "not_latest",
      hasUnreadTerminalOutcome: true,
      latestTerminalOutcomeMessageId: "message-a",
    });

    const markedReadResponse = await serviceFetch(
      "https://example.com/sessions/api-session/terminal-outcome-read-state",
      {
        method: "PATCH",
        body: JSON.stringify({
          action: "mark_terminal_outcome_read",
          terminalOutcomeMessageId: "message-a",
        }),
      }
    );
    expect(await markedReadResponse.json()).toEqual({
      sessionId: "api-session",
      outcome: "marked_read",
      hasUnreadTerminalOutcome: false,
      latestTerminalOutcomeMessageId: "message-a",
    });

    const serviceResponse = await serviceFetch(
      "https://example.com/sessions/api-session/terminal-outcome-read-state",
      {
        method: "PATCH",
        service: "github-bot",
        body: JSON.stringify({
          action: "mark_latest_terminal_outcome_read",
          userId: BROWSER_USER_ID,
        }),
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
      await seedStore.recordLatestTerminalOutcome({
        sessionId,
        messageId: `message-${index}`,
        messageCreatedAt: 2_000 + index,
        terminalOutcomeCompletedAt: 3_000 + index,
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
    expect(
      result.sessions.every((session) => session.terminalOutcomeReadState?.hasUnreadTerminalOutcome)
    ).toBe(true);
    expect(queryCount).toBe(4);

    const indexes = await env.DB.prepare(
      "PRAGMA index_list('session_terminal_outcome_read_states')"
    ).all<{ name: string }>();
    expect(indexes.results.map(({ name }) => name)).toContain(
      "idx_session_terminal_outcome_read_states_session"
    );

    const sessionIds = result.sessions.map(({ id }) => id);
    const queryPlan = await env.DB.prepare(
      `EXPLAIN QUERY PLAN ${buildViewerSessionTerminalOutcomeReadStatesQuery(sessionIds.length)}`
    )
      .bind("viewer", ...sessionIds)
      .all<{ detail: string }>();
    expect(queryPlan.results.map(({ detail }) => detail).join("\n")).toMatch(
      /INDEX .*session_terminal_outcome_read_states/i
    );
  });

  it("chunks terminal-outcome read-state decoration within D1 binding limits", async () => {
    const store = new SessionIndexStore(env.DB);
    await createUser("viewer", 1_000);
    for (let index = 0; index < 100; index += 1) {
      await createSession(store, `large-page-${index.toString().padStart(3, "0")}`, 10_000 - index);
    }

    const result = await store.list({ viewerUserId: "viewer", limit: 100 });

    expect(result.sessions).toHaveLength(100);
    expect(
      result.sessions.every(
        (session) => session.terminalOutcomeReadState?.hasUnreadTerminalOutcome === false
      )
    ).toBe(true);
  });
});
