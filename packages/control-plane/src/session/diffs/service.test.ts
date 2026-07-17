import { describe, expect, it, vi } from "vitest";
import type { SessionAlarmCoordinator } from "../alarm/coordinator";
import type { SessionRepository } from "../repository";
import type { SessionDiffStore } from "./store";
import { SESSION_DIFF_OBJECT_DELETE_CONCURRENCY, SessionDiffService } from "./service";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function harness(objectKeys: string[], deleteObject: (objectKey: string) => Promise<void>) {
  const store = {
    tombstoneForDeletion: vi.fn(() => objectKeys),
    forgetObject: vi.fn(),
    deferObjectCleanup: vi.fn(),
    getNextCleanupAt: vi.fn(() => null),
  } as unknown as SessionDiffStore;
  const alarms = {
    clear: vi.fn(async () => {}),
    schedule: vi.fn(async () => {}),
  } as unknown as SessionAlarmCoordinator;
  const log = { warn: vi.fn() };
  const service = new SessionDiffService({
    store,
    repository: {} as SessionRepository,
    alarms,
    storage: { transactionSync: <T>(closure: () => T) => closure() },
    log,
    generateId: () => "capture-id",
    now: () => 1_000,
    getPublicSessionId: () => "session-id",
    hasSandboxConnection: () => true,
    sendCaptureCommand: () => true,
    deleteObject,
    broadcast: vi.fn(),
    processMessageQueue: vi.fn(async () => {}),
  });
  return { service, store, log };
}

describe("SessionDiffService cleanup", () => {
  it("deletes objects with bounded concurrency", async () => {
    expect(SESSION_DIFF_OBJECT_DELETE_CONCURRENCY).toBe(8);
    const objectKeys = Array.from({ length: 10 }, (_, index) => `object-${index}`);
    const release = deferred();
    let active = 0;
    let maxActive = 0;
    const deleteObject = vi.fn(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await release.promise;
      active -= 1;
    });
    const { service, store } = harness(objectKeys, deleteObject);

    const deletion = service.handleDelete();
    await vi.waitFor(() =>
      expect(deleteObject).toHaveBeenCalledTimes(SESSION_DIFF_OBJECT_DELETE_CONCURRENCY)
    );
    release.resolve();
    await deletion;

    expect(maxActive).toBe(SESSION_DIFF_OBJECT_DELETE_CONCURRENCY);
    expect(store.forgetObject).toHaveBeenCalledTimes(objectKeys.length);
  });

  it("retains per-object retry bookkeeping when one deletion fails", async () => {
    const deleteObject = vi.fn(async (objectKey: string) => {
      if (objectKey === "failed-object") throw new Error("R2 unavailable");
    });
    const { service, store, log } = harness(
      ["first-object", "failed-object", "last-object"],
      deleteObject
    );

    await service.handleDelete();

    expect(store.forgetObject).toHaveBeenCalledWith("first-object");
    expect(store.forgetObject).toHaveBeenCalledWith("last-object");
    expect(store.deferObjectCleanup).toHaveBeenCalledWith("failed-object", 1_000);
    expect(log.warn).toHaveBeenCalledWith("session_diff.cleanup_failed", {
      object_key: "failed-object",
      error: "R2 unavailable",
    });
  });
});
