/**
 * Revocation coordinator for stored provider secrets issued to sandboxes.
 *
 * Drains the cleanup outbox: for every task, every live issuance at or below
 * the revoked credential version is terminated through a sandbox-id
 * conditional stop on its session, so a sandbox that was respawned since
 * (and never held the old token) is a no-op. A task is done only when an
 * authoritative read finds no live issuance left; otherwise it is
 * rescheduled with capped backoff for as long as it takes. A revocation is
 * never abandoned: an issuance the runtime could not confirm as terminated
 * stays live and is retried, and a task that has retried for a long time is
 * logged as stalled, not marked done. The sandbox is never authoritative for
 * account lifecycle: nothing here reads sandbox reports, only what the
 * control plane recorded when it handed out a token.
 */

import type { Logger } from "../logger";
import type {
  ProviderAccountCleanupOutboxStore,
  ProviderCredentialIssuanceStore,
} from "../db/provider-credential-issuances";
import type { ProviderCredentialCleanupTask } from "../db/provider-credential-issuances";

/**
 * What the session runtime did about a sandbox:
 * - `terminated`: the provider confirmed the stop.
 * - `shutdown_requested`: the provider cannot stop a sandbox on request
 *   (Modal); the runtime was told to exit and the record is now dead. Not
 *   settled: the issuance stays live until a later pass finds the sandbox
 *   gone.
 * - `not_current`: the session runs a different sandbox now; the named one
 *   is gone.
 * - `no_sandbox`: the session has no live sandbox.
 */
export type SandboxRevocationOutcome =
  | "terminated"
  | "shutdown_requested"
  | "not_current"
  | "no_sandbox";

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
/** Attempts after which every further retry is logged as a stalled revocation. */
const CLEANUP_STALLED_ATTEMPTS = 20;
/** Pages of live issuances one drain works through before yielding the task. */
const CLEANUP_MAX_PAGES_PER_DRAIN = 20;

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
    let unsettled = false;
    let pages = 0;
    // Page through the live issuances until a read comes back empty. A page
    // that leaves anything live (a failed call, an unconfirmed shutdown)
    // ends the pass; the task comes back and re-reads from the start.
    while (pages < CLEANUP_MAX_PAGES_PER_DRAIN) {
      pages += 1;
      const live = await this.issuances.listLive(task.providerAccountId, task.credentialVersion);
      if (live.length === 0) {
        if (!unsettled) {
          await this.outbox.markProcessed(task.id, this.now());
          return { terminated, rescheduled: false };
        }
        break;
      }
      for (const issuance of live) {
        try {
          const outcome = await this.revoker.revoke(
            issuance.sessionId,
            issuance.sandboxId,
            `provider account ${task.reason}`
          );
          if (outcome === "shutdown_requested") {
            unsettled = true;
            this.log.info("provider_credential.issuance_shutdown_requested", {
              event: "provider_credential.issuance_shutdown_requested",
              provider: task.provider,
              provider_account_id: task.providerAccountId,
              session_id: issuance.sessionId,
              sandbox_id: issuance.sandboxId,
              reason: task.reason,
            });
            continue;
          }
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
          unsettled = true;
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
      if (unsettled) break;
    }
    if (!unsettled) {
      // Every page settled but the page budget ran out before an empty read:
      // come straight back for the rest.
      await this.outbox.reschedule(task.id, task.attempts, this.now());
      return { terminated, rescheduled: true };
    }
    const attempts = task.attempts + 1;
    if (attempts >= CLEANUP_STALLED_ATTEMPTS) {
      this.log.error("provider_credential.cleanup_stalled", {
        event: "provider_credential.cleanup_stalled",
        provider: task.provider,
        provider_account_id: task.providerAccountId,
        attempts,
      });
    }
    const delay = Math.min(CLEANUP_BACKOFF_BASE_MS * 2 ** (attempts - 1), CLEANUP_BACKOFF_MAX_MS);
    await this.outbox.reschedule(task.id, attempts, this.now() + delay);
    return { terminated, rescheduled: true };
  }
}
