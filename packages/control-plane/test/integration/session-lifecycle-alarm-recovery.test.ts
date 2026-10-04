import { runInSessionDO } from "./session-do-access";
import { beforeEach, describe, expect, it } from "vitest";
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
async function parkSandboxPastConnectingTimeout(
  stub: DurableObjectStub,
  spawnFailureCount = 0
): Promise<string> {
  await waitForSandboxStatus(stub, "failed");
  const createdAt =
    Date.now() -
    (DEFAULT_LIFECYCLE_CONFIG.connectingTimeout.timeoutMs + CONNECTING_TIMEOUT_BUFFER_MS);
  await runInSessionDO(stub, (instance: SessionDO, state) => {
    state.storage.sql.exec(
      // modal_object_id stays null, so terminating never calls the provider.
      `UPDATE sandbox SET status = 'connecting', modal_object_id = NULL, created_at = ?,
         spawn_failure_count = ?, last_spawn_failure = ?`,
      createdAt,
      spawnFailureCount,
      spawnFailureCount > 0 ? createdAt : null
    );
    // Keep the warm spawn's preservation record on the rewritten generation,
    // as it is for a real boot; a mismatch reads as a held, foreign source.
    state.storage.sql.exec(
      "UPDATE sandbox_preservation SET state = json_set(state, '$.generation.createdAt', ?)",
      createdAt
    );
  });
  const [sandbox] = await queryDO<{ modal_sandbox_id: string }>(
    stub,
    "SELECT modal_sandbox_id FROM sandbox"
  );
  if (!sandbox) throw new Error("Expected sandbox row");
  return sandbox.modal_sandbox_id;
}

async function messageState(
  stub: DurableObjectStub,
  id: string
): Promise<{ status: string; error_message: string | null } | undefined> {
  const [message] = await queryDO<{ status: string; error_message: string | null }>(
    stub,
    "SELECT status, error_message FROM messages WHERE id = ?",
    id
  );
  return message;
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

    const message = await messageState(stub, "msg-stuck");
    expect(message?.status).toBe("failed");
    expect(message?.error_message).toContain("stuck processing");
  });

  it("re-drives a pending bot prompt onto a replacement after a connecting timeout", async () => {
    const { stub } = await initSession({ userId: "user-1" });
    const timedOutSandboxId = await parkSandboxPastConnectingTimeout(stub);
    await seedMessage(stub, {
      id: "msg-review",
      authorId: await ownerParticipantId(stub),
      content: "Review this pull request",
      source: "github",
      status: "pending",
      createdAt: Date.now() - 1000,
    });

    await runInSessionDO(stub, (instance: SessionDO) => instance.alarm());

    // The replacement spawn runs in the background and reserves a new identity.
    await expect
      .poll(async () => {
        const [sandbox] = await queryDO<{ modal_sandbox_id: string }>(
          stub,
          "SELECT modal_sandbox_id FROM sandbox"
        );
        return sandbox?.modal_sandbox_id;
      })
      .not.toBe(timedOutSandboxId);
    expect(await messageState(stub, "msg-review")).toEqual({
      status: "pending",
      error_message: null,
    });
  });

  it("fails a pending prompt once connecting timeouts open the circuit breaker", async () => {
    const { stub } = await initSession({ userId: "user-1" });
    await parkSandboxPastConnectingTimeout(
      stub,
      DEFAULT_LIFECYCLE_CONFIG.circuitBreaker.threshold - 1
    );
    await seedMessage(stub, {
      id: "msg-review",
      authorId: await ownerParticipantId(stub),
      content: "Review this pull request",
      source: "github",
      status: "pending",
      createdAt: Date.now() - 1000,
    });

    await runInSessionDO(stub, (instance: SessionDO) => instance.alarm());

    expect(await messageState(stub, "msg-review")).toEqual({
      status: "failed",
      error_message: "Sandbox failed to connect within the allowed time after repeated attempts.",
    });
  });
});
