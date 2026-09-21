import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createNodeSqlStorage } from "../node/sqlite-storage";
import { initSchema } from "../session/schema";
import type { SandboxProvider } from "./provider";
import { SandboxAllocationCoordinator, type AllocationIntent } from "./allocation-coordinator";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

function fixture(
  options: {
    sessionStatus?: string;
    sandboxStatus?: string;
    fenced?: number;
    generation?: number;
    provider?: Partial<SandboxProvider>;
  } = {}
) {
  const db = new DatabaseSync(":memory:");
  const { sql, transactionSync } = createNodeSqlStorage(db);
  initSchema(sql);
  sql.exec(
    "INSERT INTO session (id, status, created_at, updated_at) VALUES (?, ?, 1, 1)",
    "session-1",
    options.sessionStatus ?? "active"
  );
  sql.exec(
    `INSERT INTO sandbox
     (id, modal_sandbox_id, auth_token_hash, status, fenced, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    "row-1",
    "sandbox-1",
    "hash-1",
    options.sandboxStatus ?? "spawning",
    options.fenced ?? 0,
    options.generation ?? 100
  );
  const provider = options.provider ?? {};
  const alarmScheduler = {
    schedule: vi.fn(async () => {}),
    cancel: vi.fn(async () => {}),
    current: vi.fn(async () => null),
  };
  const log = { warn: vi.fn(), error: vi.fn() };
  const coordinator = new SandboxAllocationCoordinator(
    sql,
    transactionSync,
    provider as SandboxProvider,
    alarmScheduler,
    log as never
  );
  return { db, sql, coordinator, provider, alarmScheduler, log };
}

const reservation = {
  allocationName: "allocation-1",
  sessionId: "session-1",
  sandboxId: "sandbox-1",
  generationCreatedAt: 100,
  authTokenHash: "hash-1",
  timeoutSeconds: 7200,
};

const intent = (): AllocationIntent => ({
  allocation_name: "allocation-1",
  session_id: "session-1",
  sandbox_id: "sandbox-1",
  generation_created_at: 100,
  auth_token_hash: "hash-1",
  provider_object_id: null,
  created_at: 1,
  recovery_attempts: 0,
  next_attempt_at: 0,
  cleanup_required: 0,
  timeout_seconds: 7200,
});

const databases: DatabaseSync[] = [];
afterEach(() => {
  while (databases.length) databases.pop()!.close();
  vi.restoreAllMocks();
});

function trackedFixture(...args: Parameters<typeof fixture>) {
  const value = fixture(...args);
  databases.push(value.db);
  return value;
}

describe("SandboxAllocationCoordinator durable allocation contract", () => {
  it("persists the intent and recovery alarm before dispatch can begin", async () => {
    const { coordinator, sql, alarmScheduler } = trackedFixture();
    alarmScheduler.schedule.mockImplementation(async () => {
      expect(coordinator.find("allocation-1")).toMatchObject({ sandbox_id: "sandbox-1" });
      expect(sql.exec("SELECT pending_deadline FROM session_alarm_state").toArray()).toEqual([
        { pending_deadline: expect.any(Number) },
      ]);
    });

    await coordinator.reserve(reservation);

    expect(alarmScheduler.schedule).toHaveBeenCalledOnce();
  });

  it.each(["ready", "busy", "failed"])(
    "binds a lost-response allocation to the current unfenced %s generation",
    async (sandboxStatus) => {
      const terminateAllocation = vi.fn();
      const { coordinator, sql } = trackedFixture({
        sandboxStatus,
        provider: { terminateAllocation },
      });
      await coordinator.reserve(reservation);

      await expect(coordinator.acceptProviderResult(intent(), "provider-1")).resolves.toBe(true);

      expect(sql.exec("SELECT modal_object_id FROM sandbox").toArray()).toEqual([
        { modal_object_id: "provider-1" },
      ]);
      const boundIntent = coordinator.find("allocation-1");
      expect(boundIntent).toMatchObject({ provider_object_id: "provider-1" });
      coordinator.settleBound(boundIntent!);
      expect(coordinator.find("allocation-1")).toBeNull();
      expect(terminateAllocation).not.toHaveBeenCalled();
    }
  );

  it.each([
    { name: "cancelled session", sessionStatus: "cancelled" },
    { name: "archived session", sessionStatus: "archived" },
    { name: "fenced generation", fenced: 1 },
    { name: "superseded generation", generation: 101 },
  ])("never binds a $name", async (state) => {
    const terminateAllocation = vi.fn(async () => {});
    const { coordinator, sql } = trackedFixture({ ...state, provider: { terminateAllocation } });
    await coordinator.reserve(reservation);

    await expect(coordinator.acceptProviderResult(intent(), "provider-old")).resolves.toBe(false);

    expect(sql.exec("SELECT modal_object_id FROM sandbox").toArray()).toEqual([
      { modal_object_id: null },
    ]);
    expect(terminateAllocation).toHaveBeenCalledWith({
      allocationName: "allocation-1",
      providerObjectId: "provider-old",
      sessionId: "session-1",
      sandboxId: "sandbox-1",
    });
  });

  it("keeps cleanup debt and a retry deadline after transient termination failure", async () => {
    const terminateAllocation = vi.fn(async () => {
      throw new Error("provider unavailable");
    });
    const { coordinator, sql, alarmScheduler } = trackedFixture({
      fenced: 1,
      provider: { terminateAllocation },
    });
    await coordinator.reserve(reservation);
    sql.exec(
      "UPDATE sandbox_allocation_intents SET provider_object_id = ? WHERE allocation_name = ?",
      "provider-old",
      "allocation-1"
    );
    alarmScheduler.schedule.mockClear();

    await expect(coordinator.recover()).resolves.toBe(true);

    expect(coordinator.find("allocation-1")).toMatchObject({ provider_object_id: "provider-old" });
    expect(sql.exec("SELECT pending_deadline FROM session_alarm_state").toArray()).toEqual([
      { pending_deadline: expect.any(Number) },
    ]);
    expect(alarmScheduler.schedule).toHaveBeenCalledOnce();
  });

  it("does not terminate a healthy VM when late recovery loses to normal binding", async () => {
    const lookup = deferred<string | null>();
    const reconcileAllocation = vi.fn(() => lookup.promise);
    const terminateAllocation = vi.fn(async () => {});
    const { coordinator, sql } = trackedFixture({
      provider: { reconcileAllocation, terminateAllocation },
    });
    await coordinator.reserve(reservation);
    const recovery = coordinator.recover();
    await vi.waitFor(() => expect(reconcileAllocation).toHaveBeenCalledOnce());

    await coordinator.acceptProviderResult(intent(), "provider-1");
    coordinator.settleBound(coordinator.find("allocation-1")!);
    lookup.resolve("provider-1");
    await recovery;

    expect(sql.exec("SELECT modal_object_id FROM sandbox").toArray()).toEqual([
      { modal_object_id: "provider-1" },
    ]);
    expect(terminateAllocation).not.toHaveBeenCalled();
  });

  it("does not let an old lookup mutate a newer reservation", async () => {
    const lookup = deferred<string | null>();
    const reconcileAllocation = vi.fn(() => lookup.promise);
    const terminateAllocation = vi.fn(async () => {});
    const { coordinator, sql } = trackedFixture({
      provider: { reconcileAllocation, terminateAllocation },
    });
    await coordinator.reserve(reservation);
    const recovery = coordinator.recover();
    await vi.waitFor(() => expect(reconcileAllocation).toHaveBeenCalledOnce());
    sql.exec("DELETE FROM sandbox_allocation_intents WHERE allocation_name = ?", "allocation-1");
    sql.exec(
      `INSERT INTO sandbox_allocation_intents
       (allocation_name, session_id, sandbox_id, generation_created_at, auth_token_hash,
        provider_object_id, timeout_seconds, created_at)
       VALUES (?, ?, ?, ?, ?, NULL, 7200, ?)`,
      "allocation-1",
      "session-1",
      "sandbox-1",
      101,
      "hash-2",
      2
    );

    lookup.resolve("provider-old");
    await recovery;

    expect(coordinator.find("allocation-1")).toMatchObject({
      generation_created_at: 101,
      auth_token_hash: "hash-2",
    });
    expect(sql.exec("SELECT modal_object_id FROM sandbox").toArray()).toEqual([
      { modal_object_id: null },
    ]);
  });

  it("rejects a late original callback after a newer generation owns the intent", async () => {
    const terminateAllocation = vi.fn(async () => {});
    const { coordinator, sql } = trackedFixture({ provider: { terminateAllocation } });
    await coordinator.reserve(reservation);
    sql.exec("DELETE FROM sandbox_allocation_intents WHERE allocation_name = ?", "allocation-1");
    sql.exec(
      `INSERT INTO sandbox_allocation_intents
       (allocation_name, session_id, sandbox_id, generation_created_at, auth_token_hash,
        provider_object_id, timeout_seconds, created_at)
       VALUES (?, ?, ?, ?, ?, NULL, 7200, ?)`,
      "allocation-1",
      "session-1",
      "sandbox-1",
      101,
      "hash-2",
      2
    );
    sql.exec(
      "UPDATE sandbox SET created_at = ?, auth_token_hash = ? WHERE modal_sandbox_id = ?",
      101,
      "hash-2",
      "sandbox-1"
    );

    await expect(coordinator.acceptProviderResult(intent(), "provider-old")).resolves.toBe(false);

    expect(coordinator.find("allocation-1")).toMatchObject({
      generation_created_at: 101,
      auth_token_hash: "hash-2",
    });
    expect(sql.exec("SELECT modal_object_id FROM sandbox").toArray()).toEqual([
      { modal_object_id: null },
    ]);
    expect(terminateAllocation).not.toHaveBeenCalled();
  });

  it("settles a duplicate late callback when the same full authority is already bound", async () => {
    const terminateAllocation = vi.fn(async () => {});
    const { coordinator, sql } = trackedFixture({ provider: { terminateAllocation } });
    await coordinator.reserve(reservation);
    await coordinator.acceptProviderResult(intent(), "provider-1");
    coordinator.settleBound(coordinator.find("allocation-1")!);

    await expect(coordinator.acceptProviderResult(intent(), "provider-1")).resolves.toBe(true);

    expect(sql.exec("SELECT modal_object_id FROM sandbox").toArray()).toEqual([
      { modal_object_id: "provider-1" },
    ]);
    expect(terminateAllocation).not.toHaveBeenCalled();
  });

  it("quarantines a malformed row while recovering healthy work and rearming the alarm", async () => {
    const reconcileAllocation = vi.fn(async ({ allocationName }) =>
      allocationName === "allocation-good" ? "provider-1" : "unexpected"
    );
    const terminateAllocation = vi.fn(async () => {});
    const { coordinator, sql, alarmScheduler, log } = trackedFixture({
      provider: { reconcileAllocation, terminateAllocation },
    });
    sql.exec(
      `INSERT INTO sandbox_allocation_intents
       (allocation_name, session_id, sandbox_id, generation_created_at, auth_token_hash,
        provider_object_id, timeout_seconds, created_at)
       VALUES (?, ?, ?, ?, ?, NULL, 7200, ?)`,
      "allocation-bad",
      "session-1",
      "sandbox-1",
      "not-a-generation",
      "hash-1",
      1
    );
    await coordinator.reserve({ ...reservation, allocationName: "allocation-good" });
    alarmScheduler.schedule.mockClear();

    await expect(coordinator.recover()).resolves.toBe(true);

    expect(reconcileAllocation).toHaveBeenCalledOnce();
    expect(reconcileAllocation).toHaveBeenCalledWith({
      allocationName: "allocation-good",
      sessionId: "session-1",
      sandboxId: "sandbox-1",
    });
    expect(terminateAllocation).not.toHaveBeenCalled();
    expect(sql.exec("SELECT modal_object_id FROM sandbox").toArray()).toEqual([
      { modal_object_id: "provider-1" },
    ]);
    expect(
      sql
        .exec(
          "SELECT allocation_name FROM sandbox_allocation_intents WHERE allocation_name = ?",
          "allocation-bad"
        )
        .toArray()
    ).toEqual([{ allocation_name: "allocation-bad" }]);
    expect(alarmScheduler.schedule).toHaveBeenCalledOnce();
    expect(log.error).toHaveBeenCalled();
  });

  it("retries rejected-result cleanup without ever adopting the rejected provider ID", async () => {
    const reconcileAllocation = vi.fn(async () => "provider-rejected");
    const terminateAllocation = vi
      .fn()
      .mockRejectedValueOnce(new Error("temporary termination failure"))
      .mockResolvedValueOnce(undefined);
    const { coordinator, sql } = trackedFixture({
      sandboxStatus: "failed",
      provider: { reconcileAllocation, terminateAllocation },
    });
    await coordinator.reserve(reservation);

    await expect(coordinator.rejectProviderResult(intent(), "provider-rejected")).rejects.toThrow(
      "temporary termination failure"
    );
    expect(
      sql
        .exec(
          "SELECT provider_object_id, cleanup_required FROM sandbox_allocation_intents WHERE allocation_name = ?",
          "allocation-1"
        )
        .toArray()
    ).toEqual([{ provider_object_id: "provider-rejected", cleanup_required: 1 }]);
    sql.exec(
      "UPDATE sandbox_allocation_intents SET next_attempt_at = 0 WHERE allocation_name = ?",
      "allocation-1"
    );

    await expect(coordinator.recover()).resolves.toBe(false);

    expect(reconcileAllocation).not.toHaveBeenCalled();
    expect(terminateAllocation).toHaveBeenCalledTimes(2);
    expect(sql.exec("SELECT modal_object_id FROM sandbox").toArray()).toEqual([
      { modal_object_id: null },
    ]);
    expect(coordinator.find("allocation-1")).toBeNull();
  });

  it("keeps terminally selected cleanup non-adoptable after the session is unarchived", async () => {
    const reconcileAllocation = vi.fn(async () => "provider-terminal");
    const terminateAllocation = vi
      .fn()
      .mockRejectedValueOnce(new Error("temporary termination failure"))
      .mockResolvedValueOnce(undefined);
    const { coordinator, sql } = trackedFixture({
      sessionStatus: "archived",
      sandboxStatus: "ready",
      provider: { reconcileAllocation, terminateAllocation },
    });
    await coordinator.reserve(reservation);

    await expect(coordinator.acceptProviderResult(intent(), "provider-terminal")).rejects.toThrow(
      "temporary termination failure"
    );
    expect(
      sql
        .exec(
          "SELECT provider_object_id, cleanup_required FROM sandbox_allocation_intents WHERE allocation_name = ?",
          "allocation-1"
        )
        .toArray()
    ).toEqual([{ provider_object_id: "provider-terminal", cleanup_required: 1 }]);
    sql.exec("UPDATE session SET status = 'active' WHERE id = 'session-1'");
    sql.exec(
      "UPDATE sandbox_allocation_intents SET next_attempt_at = 0 WHERE allocation_name = ?",
      "allocation-1"
    );

    await expect(coordinator.recover()).resolves.toBe(false);

    expect(reconcileAllocation).not.toHaveBeenCalled();
    expect(terminateAllocation).toHaveBeenCalledTimes(2);
    expect(sql.exec("SELECT modal_object_id, status, fenced FROM sandbox").toArray()).toEqual([
      { modal_object_id: null, status: "ready", fenced: 0 },
    ]);
    expect(coordinator.find("allocation-1")).toBeNull();
  });

  it("finds an exact newly reserved intent beyond the recovery batch window", async () => {
    const { coordinator, sql } = trackedFixture();
    for (let index = 0; index < 26; index += 1) {
      sql.exec(
        `INSERT INTO sandbox_allocation_intents
         (allocation_name, session_id, sandbox_id, generation_created_at, auth_token_hash,
          provider_object_id, recovery_attempts, next_attempt_at, cleanup_required,
          timeout_seconds, created_at)
         VALUES (?, ?, ?, ?, ?, NULL, 0, 0, 0, 7200, ?)`,
        `older-${index}`,
        "session-1",
        "sandbox-1",
        100,
        "hash-1",
        index
      );
    }

    await coordinator.reserve({ ...reservation, allocationName: "new-exact-intent" });

    expect(coordinator.find("new-exact-intent")).toMatchObject({
      allocation_name: "new-exact-intent",
      sandbox_id: "sandbox-1",
    });
  });

  it("does not let a full malformed batch starve the next healthy intent", async () => {
    const reconcileAllocation = vi.fn(async ({ allocationName }) => {
      expect(allocationName).toBe("healthy-26");
      return "provider-healthy";
    });
    const terminateAllocation = vi.fn(async () => {});
    const { coordinator, sql, alarmScheduler, log } = trackedFixture({
      provider: { reconcileAllocation, terminateAllocation },
    });
    for (let index = 0; index < 25; index += 1) {
      sql.exec(
        `INSERT INTO sandbox_allocation_intents
         (allocation_name, session_id, sandbox_id, generation_created_at, auth_token_hash,
          provider_object_id, recovery_attempts, next_attempt_at, cleanup_required,
          timeout_seconds, created_at)
         VALUES (?, ?, ?, ?, ?, NULL, 0, 0, 0, 7200, ?)`,
        `malformed-${index}`,
        "session-1",
        "sandbox-1",
        "not-a-generation",
        "hash-1",
        index
      );
    }
    await coordinator.reserve({ ...reservation, allocationName: "healthy-26" });
    alarmScheduler.schedule.mockClear();

    await expect(coordinator.recover()).resolves.toBe(true);
    await expect(coordinator.recover()).resolves.toBe(true);

    expect(reconcileAllocation).toHaveBeenCalledOnce();
    expect(terminateAllocation).not.toHaveBeenCalled();
    expect(sql.exec("SELECT modal_object_id FROM sandbox").toArray()).toEqual([
      { modal_object_id: "provider-healthy" },
    ]);
    expect(
      sql
        .exec(
          "SELECT COUNT(*) AS count FROM sandbox_allocation_intents WHERE allocation_name LIKE 'malformed-%'"
        )
        .toArray()
    ).toEqual([{ count: 25 }]);
    expect(alarmScheduler.schedule).toHaveBeenCalledTimes(2);
    expect(log.error).toHaveBeenCalledTimes(25);
  });

  it("settles recovered allocation debt only after publication observes the bound provider ID", async () => {
    const reconcileAllocation = vi.fn(async () => "provider-recovered");
    const { coordinator, sql } = trackedFixture({ provider: { reconcileAllocation } });
    await coordinator.reserve(reservation);
    const publisher = vi.fn(async (publishedIntent: AllocationIntent, providerObjectId: string) => {
      expect(providerObjectId).toBe("provider-recovered");
      expect(publishedIntent.timeout_seconds).toBe(7200);
      expect(sql.exec("SELECT modal_object_id FROM sandbox").toArray()).toEqual([
        { modal_object_id: "provider-recovered" },
      ]);
      expect(coordinator.find("allocation-1")).not.toBeNull();
      return "published" as const;
    });
    coordinator.setRecoveryPublisher(publisher);

    await expect(coordinator.recover()).resolves.toBe(false);

    expect(publisher).toHaveBeenCalledOnce();
    expect(coordinator.find("allocation-1")).toBeNull();
  });

  it("retains recovered allocation debt without termination when publication is held", async () => {
    const reconcileAllocation = vi.fn(async () => "provider-held");
    const terminateAllocation = vi.fn(async () => {});
    const { coordinator } = trackedFixture({
      provider: { reconcileAllocation, terminateAllocation },
    });
    await coordinator.reserve(reservation);
    coordinator.setRecoveryPublisher(async () => "held");

    await expect(coordinator.recover()).resolves.toBe(true);

    expect(coordinator.find("allocation-1")).toMatchObject({
      provider_object_id: "provider-held",
      cleanup_required: 0,
      recovery_attempts: 1,
    });
    expect(terminateAllocation).not.toHaveBeenCalled();
  });

  it("turns an explicitly rejected publication into cleanup-only debt", async () => {
    const reconcileAllocation = vi.fn(async () => "provider-rejected");
    const terminateAllocation = vi.fn(async () => {
      throw new Error("termination retry required");
    });
    const { coordinator } = trackedFixture({
      provider: { reconcileAllocation, terminateAllocation },
    });
    await coordinator.reserve(reservation);
    coordinator.setRecoveryPublisher(async () => "rejected");

    await expect(coordinator.recover()).resolves.toBe(true);

    expect(coordinator.find("allocation-1")).toMatchObject({
      provider_object_id: "provider-rejected",
      cleanup_required: 1,
    });
    expect(terminateAllocation).toHaveBeenCalledOnce();
  });

  it("retains bound debt for retry when recovered-startup publication throws", async () => {
    const reconcileAllocation = vi.fn(async () => "provider-recovered");
    const terminateAllocation = vi.fn(async () => {});
    const { coordinator } = trackedFixture({
      provider: { reconcileAllocation, terminateAllocation },
    });
    await coordinator.reserve(reservation);
    const publisher = vi.fn(async () => {
      throw new Error("publisher unavailable");
    });
    coordinator.setRecoveryPublisher(publisher);

    await expect(coordinator.recover()).resolves.toBe(true);

    expect(coordinator.find("allocation-1")).toMatchObject({
      provider_object_id: "provider-recovered",
      cleanup_required: 0,
      recovery_attempts: 1,
    });
    expect(terminateAllocation).not.toHaveBeenCalled();
  });

  it("cannot adopt a lookup result after the latest intent state switches to cleanup", async () => {
    const lookup = deferred<string | null>();
    const reconcileAllocation = vi.fn(() => lookup.promise);
    const terminateAllocation = vi.fn(async () => {});
    const { coordinator, sql } = trackedFixture({
      provider: { reconcileAllocation, terminateAllocation },
    });
    await coordinator.reserve(reservation);
    const publisher = vi.fn(async () => "published" as const);
    coordinator.setRecoveryPublisher(publisher);
    const recovery = coordinator.recover();
    await vi.waitFor(() => expect(reconcileAllocation).toHaveBeenCalledOnce());
    sql.exec(
      `UPDATE sandbox_allocation_intents
       SET provider_object_id = ?, cleanup_required = 1
       WHERE allocation_name = ?`,
      "provider-cleanup",
      "allocation-1"
    );

    lookup.resolve("provider-stale");
    await expect(recovery).resolves.toBe(true);

    expect(sql.exec("SELECT modal_object_id FROM sandbox").toArray()).toEqual([
      { modal_object_id: null },
    ]);
    expect(coordinator.find("allocation-1")).toMatchObject({
      provider_object_id: "provider-cleanup",
      cleanup_required: 1,
    });
    expect(publisher).not.toHaveBeenCalled();
    expect(terminateAllocation).not.toHaveBeenCalled();
  });
});
