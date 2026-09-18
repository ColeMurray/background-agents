import { beforeEach, describe, it, expect } from "vitest";
import { createExecutionContext, env } from "cloudflare:test";
import {
  SANDBOX_OUTPUT_TAIL_MAX_CHARS,
  SANDBOX_OUTPUT_TAIL_MAX_LINES,
} from "@open-inspect/shared/types/sandbox-events";
import type { SessionDO } from "../../src/cloudflare/durable-object";
import { cleanD1Tables } from "./cleanup";
import { runInSessionDO } from "./session-do-access";
import {
  collectMessages,
  initNamedSession,
  openClientWs,
  openSandboxWs,
  queryDO,
  routeRequest,
  seedSandboxAuth,
  waitForSandboxStatus,
} from "./helpers";

beforeEach(cleanD1Tables);

const SANDBOX_TOKEN = "early-connect-sandbox-token";
const SANDBOX_ID = "sb-early-connect";

async function enqueuePrompt(stub: DurableObjectStub, content: string): Promise<string> {
  const response = await stub.fetch("http://internal/internal/prompt", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content, authorId: "user-1", source: "web" }),
  });
  expect(response.status).toBe(200);
  return (await response.json<{ messageId: string }>()).messageId;
}

function sandboxEvent(event: Record<string, unknown>): string {
  return JSON.stringify({ sandboxId: SANDBOX_ID, timestamp: Date.now() / 1000, ...event });
}

/**
 * The bridge connects ahead of the repository boot. The socket alone must not
 * make the sandbox ready or release the prompt queue; the runtime's `ready`
 * event does both.
 */
describe("sandbox early connect (via SELF.fetch)", () => {
  it("holds a queued prompt while the bridge is attached but the sandbox is still booting, then dispatches on ready", async () => {
    const name = `ws-early-connect-${Date.now()}`;
    const { stub } = await initNamedSession(name);
    await seedSandboxAuth(stub, {
      authToken: SANDBOX_TOKEN,
      sandboxId: SANDBOX_ID,
      status: "connecting",
    });
    const messageId = await enqueuePrompt(stub, "Fix the login bug");

    const { ws } = await openSandboxWs(name, { authToken: SANDBOX_TOKEN, sandboxId: SANDBOX_ID });
    expect(ws).not.toBeNull();
    ws!.accept();
    const beforeReady = collectMessages(ws!, {
      until: (message) => message.type === "prompt",
      timeoutMs: 500,
    });

    expect(await beforeReady).toEqual([]);
    expect(await queryDO<{ status: string }>(stub, "SELECT status FROM sandbox")).toEqual([
      { status: "connecting" },
    ]);
    expect(
      await queryDO<{ status: string }>(stub, "SELECT status FROM messages WHERE id = ?", messageId)
    ).toEqual([{ status: "pending" }]);

    const promptDelivery = collectMessages(ws!, {
      until: (message) => message.type === "prompt",
    });
    ws!.send(sandboxEvent({ type: "ready", harness: "opencode" }));

    await waitForSandboxStatus(stub, "ready");
    const delivered = await promptDelivery;
    expect(delivered.find((message) => message.type === "prompt")).toEqual(
      expect.objectContaining({ messageId, content: "Fix the login bug" })
    );
    const [row] = await queryDO<{ last_activity: number | null }>(
      stub,
      "SELECT last_activity FROM sandbox"
    );
    expect(row.last_activity).not.toBeNull();

    ws!.close();
  });

  it("moves a spawning row to connecting at attach and tells clients, without publishing ready", async () => {
    const name = `ws-early-connect-attach-${Date.now()}`;
    const { stub } = await initNamedSession(name);
    await seedSandboxAuth(stub, {
      authToken: SANDBOX_TOKEN,
      sandboxId: SANDBOX_ID,
      status: "spawning",
    });
    const { ws: clientWs } = await openClientWs(name, { subscribe: true });
    const collector = collectMessages(clientWs, {
      until: (message) => message.type === "sandbox_access_changed",
    });

    const { ws } = await openSandboxWs(name, { authToken: SANDBOX_TOKEN, sandboxId: SANDBOX_ID });
    expect(ws).not.toBeNull();
    ws!.accept();

    const messages = await collector;
    expect(messages.slice(-2)).toEqual([
      { type: "sandbox_status", status: "connecting" },
      { type: "sandbox_access_changed" },
    ]);
    expect(await queryDO<{ status: string }>(stub, "SELECT status FROM sandbox")).toEqual([
      { status: "connecting" },
    ]);

    ws!.close();
    clientWs.close();
  });

  it("records boot phases once per sequence and serves the latest in the snapshot", async () => {
    const name = `ws-early-connect-phase-${Date.now()}`;
    const { stub } = await initNamedSession(name);
    await seedSandboxAuth(stub, {
      authToken: SANDBOX_TOKEN,
      sandboxId: SANDBOX_ID,
      status: "connecting",
    });
    const { ws: clientWs } = await openClientWs(name, { subscribe: true });
    const seen = collectMessages(clientWs, {
      until: (message) =>
        message.type === "sandbox_event" &&
        (message.event as { type: string; bootSeq?: number }).type === "boot_progress" &&
        (message.event as { bootSeq?: number }).bootSeq === 2,
    });

    const { ws } = await openSandboxWs(name, { authToken: SANDBOX_TOKEN, sandboxId: SANDBOX_ID });
    expect(ws).not.toBeNull();
    ws!.accept();
    const setupStarted = {
      type: "boot_progress",
      bootSeq: 1,
      phase: "setup",
      status: "started",
      repoOwner: "acme",
      repoName: "api",
    };
    ws!.send(sandboxEvent(setupStarted));
    // The bridge resends its latest phase on reconnect; the copy must not land twice.
    ws!.send(sandboxEvent(setupStarted));
    ws!.send(
      sandboxEvent({
        type: "boot_progress",
        bootSeq: 2,
        phase: "setup",
        status: "completed",
        elapsedMs: 750_000,
        repoOwner: "acme",
        repoName: "api",
      })
    );

    const broadcasts = (await seen).filter(
      (message) =>
        message.type === "sandbox_event" &&
        (message.event as { type: string }).type === "boot_progress"
    );
    expect(broadcasts.map((message) => (message.event as { bootSeq: number }).bootSeq)).toEqual([
      1, 2,
    ]);
    const events = await queryDO<{ data: string }>(
      stub,
      "SELECT data FROM events WHERE type = ? ORDER BY created_at",
      "boot_progress"
    );
    expect(events.map((event) => (JSON.parse(event.data) as { bootSeq: number }).bootSeq)).toEqual([
      1, 2,
    ]);
    const [row] = await queryDO<{ boot_phase: string; boot_seq: number }>(
      stub,
      "SELECT boot_phase, boot_seq FROM sandbox"
    );
    expect(row.boot_seq).toBe(2);
    expect(JSON.parse(row.boot_phase)).toEqual({
      bootSeq: 2,
      phase: "setup",
      status: "completed",
      elapsedMs: 750_000,
      repoOwner: "acme",
      repoName: "api",
      sandboxId: SANDBOX_ID,
    });

    const snapshotRes = await stub.fetch("http://internal/internal/snapshot");
    expect(snapshotRes.status).toBe(200);
    const snapshot = await snapshotRes.json<{ bootPhase: unknown }>();
    expect(snapshot.bootPhase).toEqual({
      bootSeq: 2,
      phase: "setup",
      status: "completed",
      elapsedMs: 750_000,
      repoOwner: "acme",
      repoName: "api",
      sandboxId: SANDBOX_ID,
    });

    // Ready clears the phase along with the transition.
    ws!.send(sandboxEvent({ type: "ready", harness: "opencode" }));
    await waitForSandboxStatus(stub, "ready");
    expect(
      await queryDO<{ boot_phase: string | null }>(stub, "SELECT boot_phase FROM sandbox")
    ).toEqual([{ boot_phase: null }]);

    ws!.close();
    clientWs.close();
  });

  it("refuses to revive a fenced generation on a late ready event", async () => {
    const name = `ws-early-connect-fenced-${Date.now()}`;
    const { stub } = await initNamedSession(name);
    await seedSandboxAuth(stub, {
      authToken: SANDBOX_TOKEN,
      sandboxId: SANDBOX_ID,
      status: "failed",
    });
    // A watchdog-failed row may self-heal; a budget-failed one is fenced and
    // may not. Seed the fence while leaving the credentials valid so the
    // socket can get in and the guard is what refuses the revival.
    await runInSessionDO(stub, (instance: SessionDO, state) => {
      state.storage.sql.exec("UPDATE sandbox SET fenced = 1");
    });

    const { ws } = await openSandboxWs(name, { authToken: SANDBOX_TOKEN, sandboxId: SANDBOX_ID });
    expect(ws).not.toBeNull();
    ws!.accept();
    ws!.send(sandboxEvent({ type: "ready", harness: "opencode" }));
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(await queryDO<{ status: string }>(stub, "SELECT status FROM sandbox")).toEqual([
      { status: "failed" },
    ]);

    ws!.close();
  });

  it("lands a structured fatal report on the timeline as the failed phase", async () => {
    const name = `ws-early-connect-fatal-${Date.now()}`;
    const { stub } = await initNamedSession(name);
    await seedSandboxAuth(stub, {
      authToken: SANDBOX_TOKEN,
      sandboxId: SANDBOX_ID,
      status: "connecting",
    });

    const response = await stub.fetch("http://internal/internal/sandbox-error", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${SANDBOX_TOKEN}`,
        "X-Sandbox-ID": SANDBOX_ID,
      },
      body: JSON.stringify({
        error: "start.sh exited 1",
        fatal: true,
        phase: "start",
        bootSeq: 5,
        repoOwner: "acme",
        repoName: "api",
        outputTail: ["npm ERR! missing script: start"],
      }),
    });

    expect(response.status).toBe(200);
    await waitForSandboxStatus(stub, "failed");
    const events = await queryDO<{ data: string }>(
      stub,
      "SELECT data FROM events WHERE type = ?",
      "boot_progress"
    );
    expect(events).toHaveLength(1);
    expect(JSON.parse(events[0].data)).toEqual(
      expect.objectContaining({
        phase: "start",
        status: "failed",
        bootSeq: 5,
        outputTail: ["npm ERR! missing script: start"],
      })
    );
    expect(
      await queryDO<{ last_spawn_error: string }>(stub, "SELECT last_spawn_error FROM sandbox")
    ).toEqual([{ last_spawn_error: "start.sh exited 1" }]);
    // A client that loads the session after the failure gets the failed
    // phase, its reason and the tail from the snapshot alone.
    const snapshotRes = await stub.fetch("http://internal/internal/snapshot");
    const snapshot = await snapshotRes.json<{ bootPhase: unknown }>();
    expect(snapshot.bootPhase).toEqual({
      phase: "start",
      status: "failed",
      bootSeq: 5,
      repoOwner: "acme",
      repoName: "api",
      outputTail: ["npm ERR! missing script: start"],
      detail: "start.sh exited 1",
      sandboxId: SANDBOX_ID,
    });
  });

  it("accepts a structured fatal report with a full output tail through the public route", async () => {
    // The route's body cap and the report schema share one budget, so the
    // largest tail the runtime may send must land, not 413 at the door.
    const name = `ws-early-connect-fatal-public-${Date.now()}`;
    const { stub } = await initNamedSession(name);
    await seedSandboxAuth(stub, {
      authToken: SANDBOX_TOKEN,
      sandboxId: SANDBOX_ID,
      status: "connecting",
    });
    const perLine = Math.floor(SANDBOX_OUTPUT_TAIL_MAX_CHARS / SANDBOX_OUTPUT_TAIL_MAX_LINES);
    const outputTail = Array.from({ length: SANDBOX_OUTPUT_TAIL_MAX_LINES }, (_, i) =>
      `${i}: `.padEnd(perLine, "x")
    );

    const response = await routeRequest(
      new Request(`http://localhost/sessions/${name}/sandbox-error`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${SANDBOX_TOKEN}`,
          "X-Sandbox-ID": SANDBOX_ID,
        },
        body: JSON.stringify({
          error: "setup.sh exited 1",
          fatal: true,
          phase: "setup",
          bootSeq: 4,
          repoOwner: "acme",
          repoName: "api",
          outputTail,
        }),
      }),
      env,
      createExecutionContext()
    );

    expect(response.status).toBe(200);
    await waitForSandboxStatus(stub, "failed");
    const events = await queryDO<{ data: string }>(
      stub,
      "SELECT data FROM events WHERE type = ?",
      "boot_progress"
    );
    expect(events).toHaveLength(1);
    const landed = JSON.parse(events[0].data) as { phase: string; outputTail: string[] };
    expect(landed.phase).toBe("setup");
    expect(landed.outputTail).toEqual(outputTail);
  });
});
