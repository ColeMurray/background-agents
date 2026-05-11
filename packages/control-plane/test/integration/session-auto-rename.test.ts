import { describe, it, expect } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";
import { initNamedSession, openClientWs, collectMessages, queryDO } from "./helpers";
import type { SessionDO } from "../../src/session/durable-object";

const AUTO_RENAME_TIMEOUT_MS = 3000;
// Bounded wait for the negative case to assert no background auto-rename fired.
// Not polling — a single setTimeout sufficient to surface an erroneously-scheduled write.
const NO_BROADCAST_WAIT_MS = 200;

function uniqueSessionName(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

describe("session auto-rename (integration)", () => {
  it("requires ANTHROPIC_API_KEY to be unset for this suite", () => {
    expect(env.ANTHROPIC_API_KEY).toBeFalsy();
  });

  it("writes a non-empty title for a web-initiated session via deterministic fallback (no API key)", async () => {
    // env.ANTHROPIC_API_KEY is unset in the integration env, so the titler
    // returns null and we exercise the derivePromptTitle path.
    const sessionName = uniqueSessionName("auto-rename-fallback");
    const { stub } = await initNamedSession(sessionName);

    // Clear any default title so we exercise the "existing title null" branch explicitly.
    await runInDurableObject(stub, (instance: SessionDO) => {
      instance.ctx.storage.sql.exec(
        `UPDATE session SET title = NULL WHERE id = (SELECT id FROM session LIMIT 1)`
      );
    });

    // Subscribe BEFORE sending the prompt so we capture the session_title broadcast.
    // runAutoRename broadcasts session_title AFTER persisting the title, so receiving
    // the broadcast is a deterministic signal that the title write is complete — no polling.
    const { ws } = await openClientWs(sessionName, { subscribe: true, userId: "user-1" });
    const collector = collectMessages(ws, {
      until: (msg) => msg.type === "session_title",
      timeoutMs: AUTO_RENAME_TIMEOUT_MS,
    });

    const res = await stub.fetch("http://internal/internal/prompt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: "Refactor the session sidebar layout",
        authorId: "user-1",
        source: "web",
      }),
    });
    expect(res.status).toBe(200);

    const messages = await collector;
    const titleMessage = messages.find((m) => m.type === "session_title");
    expect(titleMessage).toBeDefined();
    // "user" spawnSource → no prefix
    expect(titleMessage!.title).toBe("Refactor the session sidebar layout");

    const rows = await queryDO<{
      title: string | null;
      title_auto_rename_attempted_at: number | null;
    }>(stub, `SELECT title, title_auto_rename_attempted_at FROM session LIMIT 1`);
    expect(rows).toHaveLength(1);
    expect(rows[0].title_auto_rename_attempted_at).not.toBeNull();
    expect(rows[0].title).toBe("Refactor the session sidebar layout");
  });

  it("does not auto-rename when title_manually_set is 1", async () => {
    const sessionName = uniqueSessionName("auto-rename-manual");
    const { stub } = await initNamedSession(sessionName, { title: "User Chose This" });

    // Simulate the user's manual rename PATCH having already happened.
    await runInDurableObject(stub, (instance: SessionDO) => {
      instance.ctx.storage.sql.exec(
        `UPDATE session SET title_manually_set = 1, title = ? WHERE id = (SELECT id FROM session LIMIT 1)`,
        "User Chose This"
      );
    });

    // Subscribe and collect for a bounded window — assert no session_title broadcast
    // arrives. maybeScheduleAutoRename returns synchronously without ctx.waitUntil when
    // title_manually_set is 1, but we collect over a window to surface any regression.
    const { ws } = await openClientWs(sessionName, { subscribe: true, userId: "user-1" });
    const collector = collectMessages(ws, { timeoutMs: NO_BROADCAST_WAIT_MS });

    await stub.fetch("http://internal/internal/prompt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "Anything", authorId: "user-1", source: "web" }),
    });

    const messages = await collector;
    expect(messages.some((m) => m.type === "session_title")).toBe(false);

    const rows = await queryDO<{
      title: string | null;
      title_auto_rename_attempted_at: number | null;
    }>(stub, `SELECT title, title_auto_rename_attempted_at FROM session LIMIT 1`);
    expect(rows[0].title).toBe("User Chose This");
    expect(rows[0].title_auto_rename_attempted_at).toBeNull();
  });

  it("falls back to 'Untitled session' when prompt is whitespace AND existing title is empty", async () => {
    const sessionName = uniqueSessionName("auto-rename-whitespace");
    const { stub } = await initNamedSession(sessionName);
    await runInDurableObject(stub, (instance: SessionDO) => {
      instance.ctx.storage.sql.exec(
        `UPDATE session SET title = NULL WHERE id = (SELECT id FROM session LIMIT 1)`
      );
    });

    const { ws } = await openClientWs(sessionName, { subscribe: true, userId: "user-1" });
    const collector = collectMessages(ws, {
      until: (msg) => msg.type === "session_title",
      timeoutMs: AUTO_RENAME_TIMEOUT_MS,
    });

    await stub.fetch("http://internal/internal/prompt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "   \n\t  ", authorId: "user-1", source: "web" }),
    });

    const messages = await collector;
    const titleMessage = messages.find((m) => m.type === "session_title");
    expect(titleMessage?.title).toBe("Untitled session");

    const rows = await queryDO<{ title: string | null }>(stub, `SELECT title FROM session LIMIT 1`);
    expect(rows[0].title).toBe("Untitled session");
  });

  it("only triggers once even if multiple prompts arrive quickly", async () => {
    const sessionName = uniqueSessionName("auto-rename-once");
    const { stub } = await initNamedSession(sessionName);
    await runInDurableObject(stub, (instance: SessionDO) => {
      instance.ctx.storage.sql.exec(
        `UPDATE session SET title = NULL WHERE id = (SELECT id FROM session LIMIT 1)`
      );
    });

    // Two-phase wait: (a) wait up to AUTO_RENAME_TIMEOUT_MS for the FIRST session_title
    // broadcast so we never time out before the (background) rename fires; (b) then collect
    // for a short tail window to assert no SECOND broadcast — that's what proves
    // "only triggers once."
    const { ws } = await openClientWs(sessionName, { subscribe: true, userId: "user-1" });
    const firstCollector = collectMessages(ws, {
      until: (msg) => msg.type === "session_title",
      timeoutMs: AUTO_RENAME_TIMEOUT_MS,
    });

    await Promise.all([
      stub.fetch("http://internal/internal/prompt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "First prompt", authorId: "user-1", source: "web" }),
      }),
      stub.fetch("http://internal/internal/prompt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "Second prompt", authorId: "user-1", source: "web" }),
      }),
    ]);

    const firstMessages = await firstCollector;
    const firstTitleMessages = firstMessages.filter((m) => m.type === "session_title");
    expect(firstTitleMessages).toHaveLength(1);
    expect(firstTitleMessages[0].title).toMatch(/(First prompt|Second prompt)/);

    // Tail: no second broadcast should follow.
    const tailMessages = await collectMessages(ws, { timeoutMs: NO_BROADCAST_WAIT_MS });
    expect(tailMessages.some((m) => m.type === "session_title")).toBe(false);

    const rows = await queryDO<{
      title: string | null;
      title_auto_rename_attempted_at: number | null;
    }>(stub, `SELECT title, title_auto_rename_attempted_at FROM session LIMIT 1`);
    expect(rows[0].title_auto_rename_attempted_at).not.toBeNull();
    expect(rows[0].title).toMatch(/(First prompt|Second prompt)/);
  });

  it("subscribed state reflects a title committed during the subscribe handshake", async () => {
    // Regression: the auto-rename runs in ctx.waitUntil and, after the Haiku
    // network call returns, commits a new title and broadcasts session_title.
    // If that commit lands after `getSessionState` captures its title snapshot
    // but before `subscribed` is sent, the subscribed payload would ship with
    // a stale (null) title and the client had nothing to fall back to. The fix
    // re-reads the latest title from SQLite right before sending. We simulate
    // the committed-mid-handshake state by writing the title directly via
    // runInDurableObject (the same synchronous SQLite write the auto-rename
    // tail performs) and then subscribing.
    const sessionName = `auto-rename-handshake-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const { stub } = await initNamedSession(sessionName);

    await runInDurableObject(stub, (instance: SessionDO) => {
      instance.ctx.storage.sql.exec(
        `UPDATE session SET title = ? WHERE id = (SELECT id FROM session LIMIT 1)`,
        "Late-committed title"
      );
    });

    const { messages } = await openClientWs(sessionName, {
      subscribe: true,
      userId: "user-1",
    });
    const subscribed = messages.find((m) => m.type === "subscribed") as
      | { state?: { title?: string | null } }
      | undefined;
    expect(subscribed?.state?.title).toBe("Late-committed title");
  });

  it("broadcasts session_title to subscribed clients after auto-rename completes", async () => {
    const sessionName = `auto-rename-broadcast-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const { stub } = await initNamedSession(sessionName);
    // Ensure existing title is null so the fallback path writes a title.
    await runInDurableObject(stub, (instance: SessionDO) => {
      instance.ctx.storage.sql.exec(
        `UPDATE session SET title = NULL WHERE id = (SELECT id FROM session LIMIT 1)`
      );
    });

    // Subscribe a client BEFORE enqueueing the prompt so we capture the broadcast.
    const { ws } = await openClientWs(sessionName, { subscribe: true, userId: "user-1" });

    // Start collecting AFTER subscribe completes — wait specifically for session_title.
    const collector = collectMessages(ws, {
      until: (msg) => msg.type === "session_title",
      timeoutMs: AUTO_RENAME_TIMEOUT_MS,
    });

    const res = await stub.fetch("http://internal/internal/prompt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: "Refactor the session sidebar layout",
        authorId: "user-1",
        source: "web",
      }),
    });
    expect(res.status).toBe(200);

    const messages = await collector;
    const titleMessage = messages.find((m) => m.type === "session_title");
    expect(titleMessage).toBeDefined();
    expect(titleMessage!.title).toBe("Refactor the session sidebar layout");
  });
});
