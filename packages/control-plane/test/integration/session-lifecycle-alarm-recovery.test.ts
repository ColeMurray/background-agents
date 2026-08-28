import { componentsOf, runInSessionDO } from "./session-do-access";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RUNTIME_ATTACH_TIMEOUT_MS } from "../../src/sandbox/lifecycle/decisions";
import type { SessionDO } from "../../src/session/durable-object";
import { cleanD1Tables } from "./cleanup";
import { initSession, queryDO, seedMessage, waitForSandboxStatus } from "./helpers";

const STARTUP_LEASE_BUFFER_MS = 1_000;

/**
 * Park the session's sandbox past the runtime attach deadline, so the next alarm
 * takes a terminating path. Init kicks off a background warm spawn that owns the
 * sandbox row and fails (Modal is unavailable in integration tests); wait for it
 * to settle before rewriting the row, otherwise it races this update.
 */
async function parkSandboxPastRuntimeAttachDeadline(stub: DurableObjectStub): Promise<void> {
  await waitForSandboxStatus(stub, "failed");
  await runInSessionDO(stub, (instance: SessionDO, state) => {
    state.storage.sql.exec(
      // modal_object_id stays null, so terminating never calls the provider.
      `UPDATE sandbox SET status = 'connecting', modal_object_id = NULL,
         runtime_attach_started_at = ?`,
      Date.now() - (RUNTIME_ATTACH_TIMEOUT_MS + STARTUP_LEASE_BUFFER_MS)
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
    await parkSandboxPastRuntimeAttachDeadline(stub);
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

  it("redrives pending queue work once when an alarm fails runtime attachment", async () => {
    const { stub } = await initSession({ userId: "user-1" });
    await parkSandboxPastRuntimeAttachDeadline(stub);
    await seedMessage(stub, {
      id: "msg-pending",
      authorId: await ownerParticipantId(stub),
      content: "Retry after startup failure",
      source: "web",
      status: "pending",
      createdAt: Date.now() - 1000,
    });

    const processMessageQueue = await runInSessionDO(stub, (instance) =>
      vi.spyOn(componentsOf(instance).messageQueue, "processMessageQueue")
    );
    await runInSessionDO(stub, (instance: SessionDO) => instance.alarm());

    expect(processMessageQueue).toHaveBeenCalledOnce();
  });

  it("allows a long provider operation and then grants a fresh runtime attach window", async () => {
    const { stub } = await initSession({ userId: "user-1" });
    await waitForSandboxStatus(stub, "failed");
    const now = Date.now();
    await runInSessionDO(stub, (instance: SessionDO, state) => {
      state.storage.sql.exec(
        `UPDATE sandbox SET status = 'spawning', created_at = ?,
           runtime_attach_started_at = NULL, boot_progress_at = NULL`,
        now - RUNTIME_ATTACH_TIMEOUT_MS - STARTUP_LEASE_BUFFER_MS
      );
    });

    await runInSessionDO(stub, (instance: SessionDO) => instance.alarm());
    expect(await queryDO<{ status: string }>(stub, "SELECT status FROM sandbox LIMIT 1")).toEqual([
      { status: "spawning" },
    ]);

    await runInSessionDO(stub, (instance: SessionDO, state) => {
      state.storage.sql.exec(
        "UPDATE sandbox SET status = 'connecting', runtime_attach_started_at = ?",
        now
      );
    });
    await runInSessionDO(stub, (instance: SessionDO) => instance.alarm());

    expect(
      await queryDO<{ status: string; runtime_attach_started_at: number }>(
        stub,
        "SELECT status, runtime_attach_started_at FROM sandbox LIMIT 1"
      )
    ).toEqual([{ status: "connecting", runtime_attach_started_at: now }]);
  });
});
