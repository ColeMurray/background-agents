/**
 * Revocation coordinator for stored provider secrets issued to sandboxes.
 *
 * Drains the cleanup outbox: for every task, every live issuance at or below
 * the revoked credential version is terminated through a sandbox-id
 * conditional stop on its session, so a sandbox that was respawned since
 * (and never held the old token) is a no-op. A task is done when no live
 * issuance remains; otherwise it is rescheduled with backoff. The sandbox is
 * never authoritative for account lifecycle: nothing here reads sandbox
 * reports, only what the control plane recorded when it handed out a token.
 */

import type { Logger } from "../logger";
import type {
  ProviderAccountCleanupOutboxStore,
  ProviderCredentialIssuanceStore,
} from "../db/provider-credential-issuances";
import type { ProviderCredentialCleanupTask } from "../db/provider-credential-issuances";

export type SandboxRevocationOutcome = "terminated" | "not_current" | "no_sandbox";

export interface SandboxRevoker {
  /**
   * Stop `sessionId`'s sandbox only if it is still `expectedSandboxId`.
   * Throws on transport failure (the task is retried).
   */
  revoke(
    sessionId: string,
    expectedSandboxId: string,
    reason: string
  ): Promise<SandboxRevocationOutcome>;
}

const CLEANUP_BACKOFF_BASE_MS = 30_000;
const CLEANUP_BACKOFF_MAX_MS = 15 * 60 * 1000;
const CLEANUP_MAX_ATTEMPTS = 20;

export interface CredentialCleanupDrainResult {
  tasks: number;
  terminated: number;
  rescheduled: number;
}

export class ProviderCredentialCleanupCoordinator {
  constructor(
    private readonly issuances: Pick<ProviderCredentialIssuanceStore, "listLive" | "terminate">,
    private readonly outbox: Pick<
      ProviderAccountCleanupOutboxStore,
      "listDue" | "markProcessed" | "reschedule"
    >,
    private readonly revoker: SandboxRevoker,
    private readonly log: Pick<Logger, "info" | "warn" | "error">,
    private readonly now: () => number = Date.now
  ) {}

  async drain(limit = 20): Promise<CredentialCleanupDrainResult> {
    const tasks = await this.outbox.listDue(this.now(), limit);
    const result: CredentialCleanupDrainResult = {
      tasks: tasks.length,
      terminated: 0,
      rescheduled: 0,
    };
    for (const task of tasks) {
      const outcome = await this.process(task);
      result.terminated += outcome.terminated;
      if (outcome.rescheduled) result.rescheduled += 1;
    }
    return result;
  }

  private async process(
    task: ProviderCredentialCleanupTask
  ): Promise<{ terminated: number; rescheduled: boolean }> {
    let terminated = 0;
    let failed = false;
    const live = await this.issuances.listLive(task.providerAccountId, task.credentialVersion);
    for (const issuance of live) {
      try {
        const outcome = await this.revoker.revoke(
          issuance.sessionId,
          issuance.sandboxId,
          `provider account ${task.reason}`
        );
        await this.issuances.terminate(issuance.id, this.now());
        if (outcome === "terminated") terminated += 1;
        this.log.info("provider_credential.issuance_terminated", {
          event: "provider_credential.issuance_terminated",
          provider: task.provider,
          provider_account_id: task.providerAccountId,
          session_id: issuance.sessionId,
          sandbox_id: issuance.sandboxId,
          outcome,
          reason: task.reason,
        });
      } catch (error) {
        failed = true;
        this.log.warn("provider_credential.issuance_terminate_failed", {
          event: "provider_credential.issuance_terminate_failed",
          provider: task.provider,
          provider_account_id: task.providerAccountId,
          session_id: issuance.sessionId,
          sandbox_id: issuance.sandboxId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (!failed) {
      await this.outbox.markProcessed(task.id, this.now());
      return { terminated, rescheduled: false };
    }
    const attempts = task.attempts + 1;
    if (attempts >= CLEANUP_MAX_ATTEMPTS) {
      this.log.error("provider_credential.cleanup_abandoned", {
        event: "provider_credential.cleanup_abandoned",
        provider: task.provider,
        provider_account_id: task.providerAccountId,
        attempts,
      });
      await this.outbox.markProcessed(task.id, this.now());
      return { terminated, rescheduled: false };
    }
    const delay = Math.min(CLEANUP_BACKOFF_BASE_MS * 2 ** (attempts - 1), CLEANUP_BACKOFF_MAX_MS);
    await this.outbox.reschedule(task.id, attempts, this.now() + delay);
    return { terminated, rescheduled: true };
  }
}
