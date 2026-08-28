import { runInSessionDO } from "./session-do-access";
import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_LIFECYCLE_CONFIG } from "../../src/sandbox/lifecycle/manager";
import type { SessionDO } from "../../src/session/durable-object";
import { cleanD1Tables } from "./cleanup";
import { initSession, queryDO, seedMessage, waitForSandboxStatus } from "./helpers";

const CONNECTING_TIMEOUT_BUFFER_MS = 1_000;
const RESPAWN_POLL_INTERVAL_MS = 100;
const RESPAWN_TIMEOUT_MS = 5_000;
// Long enough that a background spawn submitted by the alarm would have
// stamped a fresh sandbox row, without slowing the suite meaningfully.
const SPAWN_QUIET_WINDOW_MS = 750;

/**
 * Park the session's sandbox past the connecting timeout, so the next alarm
 * takes a terminating path. Init kicks off a background warm spawn that owns the
 * sandbox row and fails (Modal is unavailable in integration tests); wait for it
 * to settle before rewriting the row, otherwise it races this update.
 */
async function parkSandboxPastConnectingTimeout(stub: DurableObjectStub): Promise<void> {
  await waitForSandboxStatus(stub, "failed");
  await runInSessionDO(stub, (instance: SessionDO, state) => {
    state.storage.sql.exec(
      // modal_object_id stays null, so terminating never calls the provider.
      "UPDATE sandbox SET status = 'connecting', modal_object_id = NULL, created_at = ?",
      Date.now() -
        (DEFAULT_LIFECYCLE_CONFIG.connectingTimeout.timeoutMs + CONNECTING_TIMEOUT_BUFFER_MS)
    );
  });
}

async function ownerParticipantId(stub: DurableObjectStub): Promise<string> {
  const participants = await queryDO<{ id: string }>(
    stub,
    "SELECT id FROM participants WHERE user_id = ?",
    "user-1"
  );
  const id = participants[0]?.id;
  if (!id) throw new Error("Expected owner participant");
  return id;
}

describe("SessionDO lifecycle alarm recovery", () => {
  beforeEach(async () => {
    await cleanD1Tables();
  });

  it("fails a stuck processing message when an alarm fails the sandbox", async () => {
    const { stub } = await initSession({ userId: "user-1" });
    await parkSandboxPastConnectingTimeout(stub);
    await seedMessage(stub, {
      id: "msg-stuck",
      authorId: await ownerParticipantId(stub),
      content: "Do the thing",
      source: "web",
      status: "processing",
      createdAt: Date.now() - 1000,
      startedAt: Date.now() - 500,
    });

    await runInSessionDO(stub, (instance: SessionDO) => instance.alarm());

    const [message] = await queryDO<{ status: string; error_message: string | null }>(
      stub,
      "SELECT status, error_message FROM messages WHERE id = ?",
      "msg-stuck"
    );
    expect(message?.status).toBe("failed");
    expect(message?.error_message).toContain("stuck processing");
  });

  it("re-drives a pending prompt after a connecting timeout instead of stranding it", async () => {
    const { stub } = await initSession({ userId: "user-1" });
    await parkSandboxPastConnectingTimeout(stub);
    await seedMessage(stub, {
      id: "msg-stranded",
      authorId: await ownerParticipantId(stub),
      content: "Review the PR",
      // Bot-triggered prompts arrive once and never send a follow-up message.
      source: "github",
      status: "pending",
      createdAt: Date.now() - 1000,
    });

    const [parked] = await queryDO<{ created_at: number }>(stub, "SELECT created_at FROM sandbox");
    if (!parked) throw new Error("Expected parked sandbox row");

    await runInDurableObject(stub, (instance: SessionDO) => instance.alarm());

    // The alarm re-drove the queue: the pending prompt found no sandbox and
    // spawned a replacement, which stamps a fresh created_at even though
    // Modal is unavailable here and the attempt settles failed.
    const deadline = Date.now() + RESPAWN_TIMEOUT_MS;
    let respawned = false;
    while (Date.now() < deadline) {
      const [row] = await queryDO<{ created_at: number }>(stub, "SELECT created_at FROM sandbox");
      if (row && row.created_at > parked.created_at) {
        respawned = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, RESPAWN_POLL_INTERVAL_MS));
    }
    expect(respawned).toBe(true);

    // The queued prompt survived the sandbox failure and stays pending for
    // the replacement sandbox instead of being silently dropped. It only
    // reaches a terminal state once a sandbox connects and dispatches it.
    const [message] = await queryDO<{ status: string }>(
      stub,
      "SELECT status FROM messages WHERE id = ?",
      "msg-stranded"
    );
    expect(message?.status).toBe("pending");
  });

  it("does not respawn a sandbox when no prompt is queued", async () => {
    const { stub } = await initSession({ userId: "user-1" });
    await parkSandboxPastConnectingTimeout(stub);

    const [parked] = await queryDO<{ created_at: number }>(stub, "SELECT created_at FROM sandbox");
    if (!parked) throw new Error("Expected parked sandbox row");

    await runInDurableObject(stub, (instance: SessionDO) => instance.alarm());

    // Control for the respawn above: the connecting-timeout alarm itself
    // must not spawn — only a queued prompt re-driving the queue does. A
    // fresh created_at here would mean some other path moved the respawn,
    // and the queue-recovery test would stop proving anything about the queue.
    await new Promise((resolve) => setTimeout(resolve, SPAWN_QUIET_WINDOW_MS));
    const [after] = await queryDO<{ created_at: number; status: string }>(
      stub,
      "SELECT created_at, status FROM sandbox"
    );
    expect(after?.created_at).toBe(parked.created_at);
    expect(after?.status).toBe("failed");
  });
});
