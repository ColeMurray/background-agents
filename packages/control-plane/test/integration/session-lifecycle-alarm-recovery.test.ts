import { runInSessionDO } from "./session-do-access";
import { beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { DEFAULT_LIFECYCLE_CONFIG } from "../../src/sandbox/lifecycle/manager";
import type { SessionDO } from "../../src/cloudflare/durable-object";
import { cleanD1Tables } from "./cleanup";
import { initSession, queryDO, seedMessage, waitForSandboxStatus } from "./helpers";

const CONNECTING_TIMEOUT_BUFFER_MS = 1_000;

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

  it("retains and rearms ambiguous allocation debt across Durable Object eviction", async () => {
    const sessionName = `allocation-recovery-${crypto.randomUUID()}`;
    const { stub } = await initSession({ userId: "user-1", sessionName });
    await waitForSandboxStatus(stub, "failed");
    await runInSessionDO(stub, (_instance: SessionDO, state) => {
      const now = Date.now();
      state.storage.sql.exec(
        `INSERT INTO sandbox_allocation_intents
         (allocation_name, session_id, sandbox_id, generation_created_at, auth_token_hash,
          provider_object_id, timeout_seconds, created_at)
         VALUES ('oi-eviction-test', ?, 'sandbox-eviction-test', ?, 'hash', NULL, 7200, ?)`,
        sessionName,
        now,
        now
      );
      state.storage.sql.exec(
        `INSERT INTO session_alarm_state (singleton, pending_deadline, cancelled)
         VALUES (1, ?, 0)
         ON CONFLICT(singleton) DO UPDATE SET pending_deadline = excluded.pending_deadline,
           cancelled = 0`,
        now
      );
    });

    await expect(
      runInSessionDO(stub, (_instance: SessionDO, state) =>
        state.abort("force allocation eviction")
      )
    ).rejects.toThrow();
    const restored = env.SESSION.get(env.SESSION.idFromName(sessionName));
    await runInSessionDO(restored, (instance: SessionDO) => instance.alarm());

    expect(
      await queryDO(restored, "SELECT allocation_name FROM sandbox_allocation_intents")
    ).toEqual([{ allocation_name: "oi-eviction-test" }]);
    const [alarm] = await queryDO<{ pending_deadline: number | null; cancelled: number }>(
      restored,
      "SELECT pending_deadline, cancelled FROM session_alarm_state WHERE singleton = 1"
    );
    expect(alarm?.pending_deadline).not.toBeNull();
    expect(alarm?.cancelled).toBe(0);
  });
});
