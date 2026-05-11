import { describe, it, expect } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";
import { initSession, initNamedSession, openClientWs, collectMessages, queryDO } from "./helpers";
import type { SessionDO } from "../../src/session/durable-object";

const AUTO_RENAME_TIMEOUT_MS = 3000;
const AUTO_RENAME_POLL_INTERVAL_MS = 25;
// runAutoRename writes title_auto_rename_attempted_at BEFORE awaiting the titler call and
// writing the final title — wait for both so downstream title assertions don't race.
const BACKGROUND_SETTLE_WAIT_MS = 200;

async function waitForAutoRename(
  stub: DurableObjectStub,
  timeoutMs = AUTO_RENAME_TIMEOUT_MS
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const rows = await queryDO<{
      title_auto_rename_attempted_at: number | null;
      title: string | null;
    }>(stub, `SELECT title, title_auto_rename_attempted_at FROM session LIMIT 1`);
    const row = rows[0];
    if (
      row?.title_auto_rename_attempted_at !== null &&
      typeof row?.title === "string" &&
      row.title.trim().length > 0
    ) {
      return;
    }
    await new Promise((r) => setTimeout(r, AUTO_RENAME_POLL_INTERVAL_MS));
  }
  throw new Error("Auto-rename did not run within timeout");
}

describe("session auto-rename (integration)", () => {
  it("requires ANTHROPIC_API_KEY to be unset for this suite", () => {
    expect(env.ANTHROPIC_API_KEY).toBeFalsy();
  });

  it("writes a non-empty title for a web-initiated session via deterministic fallback (no API key)", async () => {
    // env.ANTHROPIC_API_KEY is unset in the integration env, so the titler
    // returns null and we exercise the derivePromptTitle path.
    const { stub } = await initSession();

    // Clear any default title that initSession might have set so we exercise
    // the "existing title null" branch explicitly.
    await runInDurableObject(stub, (instance: SessionDO) => {
      instance.ctx.storage.sql.exec(
        `UPDATE session SET title = NULL WHERE id = (SELECT id FROM session LIMIT 1)`
      );
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

    await waitForAutoRename(stub);

    const rows = await queryDO<{
      title: string | null;
      title_auto_rename_attempted_at: number | null;
    }>(stub, `SELECT title, title_auto_rename_attempted_at FROM session LIMIT 1`);
    expect(rows).toHaveLength(1);
    expect(rows[0].title_auto_rename_attempted_at).not.toBeNull();
    expect(rows[0].title).not.toBeNull();
    expect(rows[0].title!.length).toBeGreaterThan(0);
    // "user" spawnSource → no prefix
    expect(rows[0].title).toBe("Refactor the session sidebar layout");
  });

  it("does not auto-rename when title_manually_set is 1", async () => {
    const { stub } = await initSession({ title: "User Chose This" });

    // Simulate the user's manual rename PATCH having already happened.
    await runInDurableObject(stub, (instance: SessionDO) => {
      instance.ctx.storage.sql.exec(
        `UPDATE session SET title_manually_set = 1, title = ? WHERE id = (SELECT id FROM session LIMIT 1)`,
        "User Chose This"
      );
    });

    await stub.fetch("http://internal/internal/prompt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "Anything", authorId: "user-1", source: "web" }),
    });

    // Give the would-be-background-task time to NOT run.
    await new Promise((r) => setTimeout(r, BACKGROUND_SETTLE_WAIT_MS));

    const rows = await queryDO<{
      title: string | null;
      title_auto_rename_attempted_at: number | null;
    }>(stub, `SELECT title, title_auto_rename_attempted_at FROM session LIMIT 1`);
    expect(rows[0].title).toBe("User Chose This");
    expect(rows[0].title_auto_rename_attempted_at).toBeNull();
  });

  it("falls back to 'Untitled session' when prompt is whitespace AND existing title is empty", async () => {
    const { stub } = await initSession();
    await runInDurableObject(stub, (instance: SessionDO) => {
      instance.ctx.storage.sql.exec(
        `UPDATE session SET title = NULL WHERE id = (SELECT id FROM session LIMIT 1)`
      );
    });

    await stub.fetch("http://internal/internal/prompt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "   \n\t  ", authorId: "user-1", source: "web" }),
    });

    await waitForAutoRename(stub);

    const rows = await queryDO<{ title: string | null }>(stub, `SELECT title FROM session LIMIT 1`);
    expect(rows[0].title).toBe("Untitled session");
  });

  it("only triggers once even if multiple prompts arrive quickly", async () => {
    const { stub } = await initSession();
    await runInDurableObject(stub, (instance: SessionDO) => {
      instance.ctx.storage.sql.exec(
        `UPDATE session SET title = NULL WHERE id = (SELECT id FROM session LIMIT 1)`
      );
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

    await waitForAutoRename(stub);

    // Either the first or the second won the race, but the title should be set
    // and the attempted marker should be set.
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
