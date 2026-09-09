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
  const issuances = {
    listLive: vi.fn(async () => live),
    terminate: vi.fn(async () => true),
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

  it("abandons a task after the attempt budget and logs it", async () => {
    const h = harness([task({ attempts: 19 })], [issuance()], async () => {
      throw new Error("still down");
    });
    await h.coordinator.drain();
    expect(h.outbox.markProcessed).toHaveBeenCalledOnce();
    expect(log.error).toHaveBeenCalledWith(
      "provider_credential.cleanup_abandoned",
      expect.objectContaining({ attempts: 20 })
    );
  });
});
