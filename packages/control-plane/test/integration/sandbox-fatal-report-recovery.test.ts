import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_LIFECYCLE_CONFIG } from "../../src/sandbox/lifecycle/manager";
import { ModalSandboxProvider } from "../../src/sandbox/providers/modal-provider";
import type { SessionDO } from "../../src/cloudflare/durable-object";
import { cleanD1Tables } from "./cleanup";
import { runInSessionDO } from "./session-do-access";
import { initSession, queryDO, seedMessage, seedSandboxAuth } from "./helpers";

const SANDBOX_TOKEN = "fatal-report-sandbox-token";
const SANDBOX_ID = "sb-fatal-report";
const FATAL_ERROR = "git sync failed for acme/api";

/**
 * Seed a booting sandbox whose earlier attempts already count toward the
 * circuit breaker. Without a provider object, terminating never calls the
 * provider.
 */
async function seedBootingSandbox(
  stub: DurableObjectStub,
  spawnFailureCount: number,
  providerObjectId: string | null = null
) {
  await seedSandboxAuth(stub, {
    authToken: SANDBOX_TOKEN,
    sandboxId: SANDBOX_ID,
    status: "connecting",
  });
  await runInSessionDO(stub, (_instance: SessionDO, state) => {
    state.storage.sql.exec(
      `UPDATE sandbox SET modal_object_id = ?, created_at = ?,
         spawn_failure_count = ?, last_spawn_failure = ?`,
      providerObjectId,
      Date.now(),
      spawnFailureCount,
      spawnFailureCount > 0 ? Date.now() : null
    );
  });
}

async function seedPendingPrompt(stub: DurableObjectStub, id: string): Promise<void> {
  const [owner] = await queryDO<{ id: string }>(
    stub,
    "SELECT id FROM participants WHERE user_id = ?",
    "user-1"
  );
  if (!owner) throw new Error("Expected owner participant");
  await seedMessage(stub, {
    id,
    authorId: owner.id,
    content: "Review this pull request",
    source: "github",
    status: "pending",
    createdAt: Date.now() - 1000,
  });
}

async function reportFatalError(stub: DurableObjectStub): Promise<void> {
  const response = await stub.fetch("http://internal/internal/sandbox-error", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${SANDBOX_TOKEN}`,
      "X-Sandbox-ID": SANDBOX_ID,
    },
    body: JSON.stringify({ error: FATAL_ERROR, fatal: true }),
  });
  expect(await response.json()).toEqual({ status: "ok" });
}

async function messageState(stub: DurableObjectStub, id: string) {
  const [message] = await queryDO<{ status: string; error_message: string | null }>(
    stub,
    "SELECT status, error_message FROM messages WHERE id = ?",
    id
  );
  return message;
}

describe("SessionDO fatal sandbox report recovery", () => {
  beforeEach(async () => {
    await cleanD1Tables();
  });
  afterEach(() => vi.restoreAllMocks());

  it("leaves a pending prompt queued for a replacement while retries remain", async () => {
    const { stub } = await initSession({ userId: "user-1" });
    await seedBootingSandbox(stub, 0);
    await seedPendingPrompt(stub, "msg-review");

    await reportFatalError(stub);

    expect(await messageState(stub, "msg-review")).toEqual({
      status: "pending",
      error_message: null,
    });
  });

  it("fails a pending prompt once the fatal report opens the circuit breaker", async () => {
    const { stub } = await initSession({ userId: "user-1" });
    await seedBootingSandbox(stub, DEFAULT_LIFECYCLE_CONFIG.circuitBreaker.threshold - 1);
    await seedPendingPrompt(stub, "msg-review");

    await reportFatalError(stub);

    expect(await messageState(stub, "msg-review")).toEqual({
      status: "failed",
      error_message: FATAL_ERROR,
    });
  });

  it("fails a pending prompt when the failed sandbox cannot be stopped for a replacement", async () => {
    const stop = vi
      .spyOn(ModalSandboxProvider.prototype, "stopSandbox")
      .mockResolvedValue({ success: false, error: "provider unavailable" });
    const { stub } = await initSession({ userId: "user-1" });
    await seedBootingSandbox(stub, 0, "modal-obj-booting");
    await seedPendingPrompt(stub, "msg-review");

    await reportFatalError(stub);

    // Nothing re-drives a failed row, so the prompt must not wait for another message.
    expect(stop).toHaveBeenCalledWith(
      expect.objectContaining({ providerObjectId: "modal-obj-booting" })
    );
    expect(await messageState(stub, "msg-review")).toEqual({
      status: "failed",
      error_message: FATAL_ERROR,
    });
  });
});
