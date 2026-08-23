import { beforeEach, describe, expect, it } from "vitest";
import { runInDurableObject } from "cloudflare:test";
import type { SandboxLifecycleManager } from "../../src/sandbox/lifecycle/manager";
import type { SessionDO } from "../../src/session/durable-object";
import { cleanD1Tables } from "./cleanup";
import { initSession, queryDO, seedMessage, waitForSandboxStatus } from "./helpers";

/**
 * The SessionDO wires the lifecycle manager's termination callbacks to the
 * message queue after constructing the manager (the `lifecycleManager` getter in
 * durable-object.ts). Every call site inside the manager invokes them optionally,
 * so losing that wiring is silent: the sandbox still terminates, and a
 * `processing` message simply stays stuck forever with no error logged anywhere.
 *
 * These tests exercise the wiring through a real DO so a dropped or reordered
 * `setCallbacks` call fails loudly instead.
 */

/** The getter is private to the DO; tests read it to assert how it wires. */
function lifecycleManagerOf(instance: SessionDO): SandboxLifecycleManager {
  return (instance as unknown as { lifecycleManager: SandboxLifecycleManager }).lifecycleManager;
}

/**
 * Park the session's sandbox past the connecting timeout, so the next alarm
 * takes a terminating path. Init kicks off a background warm spawn that owns the
 * sandbox row and fails (Modal is unavailable in integration tests); wait for it
 * to settle before rewriting the row, otherwise it races this update.
 */
async function parkSandboxPastConnectingTimeout(stub: DurableObjectStub): Promise<void> {
  await waitForSandboxStatus(stub, "failed");
  await runInDurableObject(stub, (instance: SessionDO) => {
    instance.ctx.storage.sql.exec(
      // modal_object_id stays null, so terminating never calls the provider.
      "UPDATE sandbox SET status = 'connecting', modal_object_id = NULL, created_at = ?",
      Date.now() - 10 * 60 * 1000
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

describe("SessionDO lifecycle callback wiring", () => {
  beforeEach(async () => {
    await cleanD1Tables();
  });

  it("fails a stuck processing message when the lifecycle manager terminates the sandbox", async () => {
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

    await runInDurableObject(stub, (instance: SessionDO) =>
      lifecycleManagerOf(instance).handleAlarm()
    );

    const [message] = await queryDO<{ status: string; error_message: string | null }>(
      stub,
      "SELECT status, error_message FROM messages WHERE id = ?",
      "msg-stuck"
    );
    expect(message?.status).toBe("failed");
    expect(message?.error_message).toContain("stuck processing");
  });

  it("wires the manager's callbacks exactly once, on construction", async () => {
    const { stub } = await initSession({ userId: "user-1" });

    await runInDurableObject(stub, (instance: SessionDO) => {
      const manager = lifecycleManagerOf(instance);
      expect(lifecycleManagerOf(instance)).toBe(manager);
      // setCallbacks rejects a second wiring, so this throwing is proof the DO
      // already wired this manager rather than leaving it unwired.
      expect(() => manager.setCallbacks({})).toThrow(/already wired/i);
    });
  });
});
