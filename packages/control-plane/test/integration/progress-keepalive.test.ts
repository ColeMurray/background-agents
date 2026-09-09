import { beforeEach, describe, expect, it } from "vitest";
import { runInSessionDO } from "./session-do-access";
import type { SessionDO } from "../../src/cloudflare/durable-object";
import { PROGRESS_KEEPALIVE_INTERVAL_MS } from "../../src/session/progress-keepalive";
import { cleanD1Tables } from "./cleanup";
import { initNamedSession, openSandboxWs, queryDO, seedSandboxAuth } from "./helpers";

const LINEAR_CALLBACK_CONTEXT = {
  source: "linear",
  issueId: "issue-1",
  issueIdentifier: "ENG-1",
  issueUrl: "https://linear.app/acme/issue/ENG-1",
  model: "anthropic/claude-haiku-4-5",
};

interface ProgressRow {
  status: string;
  started_at: number | null;
  progress_notified_at: number | null;
}

async function readProgressRow(stub: DurableObjectStub, messageId: string): Promise<ProgressRow> {
  const [row] = await queryDO<ProgressRow>(
    stub,
    "SELECT status, started_at, progress_notified_at FROM messages WHERE id = ?",
    messageId
  );
  if (!row) throw new Error(`Expected message ${messageId}`);
  return row;
}

function currentAlarm(stub: DurableObjectStub): Promise<number | null> {
  return runInSessionDO(stub, (instance: SessionDO, state) => state.storage.getAlarm());
}

/**
 * Time-travel for the keepalive: the alarm handler reads the wall clock, so the
 * heartbeat is made due by backdating the message the same way the lifecycle
 * recovery test backdates the sandbox row.
 */
async function backdateProgressAnchor(stub: DurableObjectStub, messageId: string): Promise<void> {
  await runInSessionDO(stub, (instance: SessionDO, state) => {
    state.storage.sql.exec(
      "UPDATE messages SET started_at = ?, progress_notified_at = NULL WHERE id = ?",
      Date.now() - PROGRESS_KEEPALIVE_INTERVAL_MS - 1_000,
      messageId
    );
  });
}

describe("SessionDO Linear progress keepalive", () => {
  beforeEach(async () => {
    await cleanD1Tables();
  });

  it("heartbeats a processing Linear message over the shared alarm", async () => {
    const name = `progress-keepalive-${Date.now()}`;
    const { stub } = await initNamedSession(name);
    const sandboxAuth = { authToken: "sb-tok-progress", sandboxId: "sb-progress-1" };
    await seedSandboxAuth(stub, sandboxAuth);
    const { ws: sandboxWs } = await openSandboxWs(name, sandboxAuth);
    expect(sandboxWs).not.toBeNull();
    sandboxWs!.accept();

    const dispatchedAfter = Date.now();
    const res = await stub.fetch("http://internal/internal/prompt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: "Fix ENG-1",
        authorId: "user-1",
        source: "linear",
        callbackContext: LINEAR_CALLBACK_CONTEXT,
      }),
    });
    expect(res.status).toBe(200);
    const { messageId } = await res.json<{ messageId: string }>();

    // Dispatched straight to the connected sandbox: processing, nothing notified yet.
    const dispatched = await readProgressRow(stub, messageId);
    expect(dispatched.status).toBe("processing");
    expect(dispatched.progress_notified_at).toBeNull();
    const armed = await currentAlarm(stub);
    expect(armed).not.toBeNull();
    expect(armed!).toBeLessThanOrEqual(dispatched.started_at! + PROGRESS_KEEPALIVE_INTERVAL_MS);
    expect(armed!).toBeGreaterThan(dispatchedAfter);

    // One interval later the alarm delivers a heartbeat and re-arms itself.
    await backdateProgressAnchor(stub, messageId);
    const tickedAfter = Date.now();
    await runInSessionDO(stub, (instance: SessionDO) => instance.alarm());

    const heartbeat = await readProgressRow(stub, messageId);
    expect(heartbeat.status).toBe("processing");
    expect(heartbeat.progress_notified_at).toEqual(expect.any(Number));
    expect(heartbeat.progress_notified_at!).toBeGreaterThanOrEqual(tickedAfter);
    // The lifecycle manager shares the slot and may hold an earlier check; the
    // keepalive's own deadline is never later than one interval out.
    const rearmed = await currentAlarm(stub);
    expect(rearmed).not.toBeNull();
    expect(rearmed!).toBeGreaterThan(tickedAfter);
    expect(rearmed!).toBeLessThanOrEqual(
      heartbeat.progress_notified_at! + PROGRESS_KEEPALIVE_INTERVAL_MS
    );

    // Once the message completes, the keepalive leaves it alone.
    const completeRes = await stub.fetch("http://internal/internal/sandbox-event", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "execution_complete",
        messageId,
        success: true,
        sandboxId: sandboxAuth.sandboxId,
        timestamp: Date.now() / 1000,
      }),
    });
    expect(completeRes.status).toBe(200);
    await backdateProgressAnchor(stub, messageId);
    await runInSessionDO(stub, (instance: SessionDO) => instance.alarm());

    const completed = await readProgressRow(stub, messageId);
    expect(completed.status).toBe("completed");
    expect(completed.progress_notified_at).toBeNull();

    sandboxWs!.close();
  });
});
