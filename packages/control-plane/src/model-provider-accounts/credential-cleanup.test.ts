import { describe, expect, it, vi } from "vitest";
import {
  ProviderCredentialCleanupCoordinator,
  type SandboxRevocationOutcome,
} from "./credential-cleanup";
import type {
  ProviderCredentialCleanupTask,
  ProviderCredentialIssuance,
} from "../db/provider-credential-issuances";

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

function task(
  overrides: Partial<ProviderCredentialCleanupTask> = {}
): ProviderCredentialCleanupTask {
  return {
    id: "task-1",
    providerAccountId: "acct-1",
    provider: "anthropic",
    reason: "disabled",
    credentialVersion: 2,
    attempts: 0,
    nextAttemptAt: 0,
    createdAt: 0,
    ...overrides,
  };
}

function issuance(overrides: Partial<ProviderCredentialIssuance> = {}): ProviderCredentialIssuance {
  return {
    id: "iss-1",
    providerAccountId: "acct-1",
    provider: "anthropic",
    sessionId: "session-1",
    sandboxId: "sb-1",
    credentialVersion: 2,
    issuedAt: 0,
    terminatedAt: null,
    ...overrides,
  };
}

function harness(
  tasks: ProviderCredentialCleanupTask[],
  live: ProviderCredentialIssuance[],
  revoke: (sessionId: string, sandboxId: string) => Promise<SandboxRevocationOutcome>
) {
  // Behaves like the store: a terminated issuance leaves the live set, and a
  // read returns at most one page.
  const terminated = new Set<string>();
  const issuances = {
    listLive: vi.fn(async () => live.filter((row) => !terminated.has(row.id)).slice(0, 100)),
    terminate: vi.fn(async (id: string) => {
      terminated.add(id);
      return true;
    }),
  };
  const outbox = {
    listDue: vi.fn(async () => tasks),
    markProcessed: vi.fn(async () => true),
    reschedule: vi.fn(async () => undefined),
  };
  const revoker = { revoke: vi.fn(revoke) };
  const coordinator = new ProviderCredentialCleanupCoordinator(
    issuances,
    outbox,
    revoker,
    log,
    () => 1_000_000
  );
  return { coordinator, issuances, outbox, revoker };
}

describe("ProviderCredentialCleanupCoordinator", () => {
  it("terminates every live issuance with a sandbox-id-conditional stop and completes the task", async () => {
    const h = harness(
      [task()],
      [issuance(), issuance({ id: "iss-2", sessionId: "session-2", sandboxId: "sb-2" })],
      async (_session, sandboxId) => (sandboxId === "sb-1" ? "terminated" : "not_current")
    );

    const result = await h.coordinator.drain();

    expect(result).toEqual({ tasks: 1, terminated: 1, rescheduled: 0 });
    expect(h.revoker.revoke).toHaveBeenCalledWith("session-1", "sb-1", "provider account disabled");
    expect(h.revoker.revoke).toHaveBeenCalledWith("session-2", "sb-2", "provider account disabled");
    // A respawned sandbox that never held the token is still settled.
    expect(h.issuances.terminate).toHaveBeenCalledTimes(2);
    expect(h.outbox.markProcessed).toHaveBeenCalledWith("task-1", 1_000_000);
  });

  it("only asks for issuances at or below the revoked credential version", async () => {
    const h = harness([task({ credentialVersion: 3 })], [], async () => "no_sandbox");
    await h.coordinator.drain();
    expect(h.issuances.listLive).toHaveBeenCalledWith("acct-1", 3);
    expect(h.outbox.markProcessed).toHaveBeenCalledOnce();
  });

  it("reschedules with backoff when a revocation call fails, keeping the issuance live", async () => {
    const h = harness([task({ attempts: 1 })], [issuance()], async () => {
      throw new Error("runtime unavailable");
    });

    const result = await h.coordinator.drain();

    expect(result.rescheduled).toBe(1);
    expect(h.issuances.terminate).not.toHaveBeenCalled();
    expect(h.outbox.markProcessed).not.toHaveBeenCalled();
    expect(h.outbox.reschedule).toHaveBeenCalledWith("task-1", 2, 1_000_000 + 60_000);
  });

  it("never abandons a task: past the stall threshold it keeps retrying at the capped backoff", async () => {
    const h = harness([task({ attempts: 19 })], [issuance()], async () => {
      throw new Error("still down");
    });
    await h.coordinator.drain();
    expect(h.outbox.markProcessed).not.toHaveBeenCalled();
    expect(h.issuances.terminate).not.toHaveBeenCalled();
    expect(h.outbox.reschedule).toHaveBeenCalledWith("task-1", 20, 1_000_000 + 15 * 60 * 1000);
    expect(log.error).toHaveBeenCalledWith(
      "provider_credential.cleanup_stalled",
      expect.objectContaining({ attempts: 20 })
    );
  });

  it("keeps an issuance live when the runtime could only request a shutdown", async () => {
    // A provider without an explicit stop (Modal) told the runtime to exit;
    // nothing confirmed it. The issuance settles on a later pass, when the
    // session reports the sandbox gone.
    const h = harness([task()], [issuance()], async () => "shutdown_requested");

    const result = await h.coordinator.drain();

    expect(result).toEqual({ tasks: 1, terminated: 0, rescheduled: 1 });
    expect(h.issuances.terminate).not.toHaveBeenCalled();
    expect(h.outbox.markProcessed).not.toHaveBeenCalled();
    expect(h.outbox.reschedule).toHaveBeenCalledWith("task-1", 1, 1_000_000 + 30_000);
  });

  it("pages past the store's page size and completes only on an empty read", async () => {
    const live = Array.from({ length: 101 }, (_, index) =>
      issuance({ id: `iss-${index}`, sessionId: `session-${index}`, sandboxId: `sb-${index}` })
    );
    const h = harness([task()], live, async () => "terminated");

    const result = await h.coordinator.drain();

    expect(result).toEqual({ tasks: 1, terminated: 101, rescheduled: 0 });
    expect(h.issuances.terminate).toHaveBeenCalledTimes(101);
    // 100, then 1, then the authoritative empty read.
    expect(h.issuances.listLive).toHaveBeenCalledTimes(3);
    expect(h.outbox.markProcessed).toHaveBeenCalledOnce();
  });
});
