import type { SandboxEvent } from "@open-inspect/shared/types/sandbox-events";
import type { Logger } from "../logger";
import type { GitPushSpec } from "../source-control";
import type { SessionWebSocketManager } from "./websocket-manager";

type PushResolver = { resolve: () => void; reject: (err: Error) => void };
export type PushTerminalEvent = Extract<SandboxEvent, { type: "push_complete" | "push_error" }>;

/** How long a pending push waits for its terminal event before rejecting. */
const PUSH_TIMEOUT_MS = 360_000;

/**
 * Pushes a branch by commanding the sandbox and awaiting its answer.
 *
 * This is the sandbox protocol's only request/response exchange — every other
 * message in either direction is one-way. The pending-resolver table is what
 * turns the command plus its later `push_complete`/`push_error` event into a
 * promise, and it is why this lives as session-scoped state: the caller
 * (`SessionPullRequestService`) is constructed per request and cannot hold the
 * table, while the event router must be able to reach it to settle waits.
 * Should a second reply-carrying command ever appear, generalize this with
 * per-request correlation ids (see the protocol gaps noted in issue #1630)
 * rather than growing a sibling table.
 */
export class SandboxPushService {
  private pendingPushResolvers = new Map<string, PushResolver>();

  constructor(
    private readonly log: Logger,
    private readonly wsManager: SessionWebSocketManager
  ) {}

  /**
   * Push a branch to its remote via the sandbox.
   *
   * Sends the push command over the sandbox socket and waits for the sandbox to
   * report completion or an error.
   *
   * @returns Success result or error message
   */
  async pushBranchToRemote(
    pushSpec: GitPushSpec
  ): Promise<{ success: true } | { success: false; error: string }> {
    const sandboxWs = this.wsManager.getSandboxSocket();

    if (!sandboxWs) {
      this.log.info("No sandbox connected, assuming branch was pushed manually");
      return { success: true };
    }

    const resolverKey = this.pushResolverKey(
      pushSpec.repoOwner,
      pushSpec.repoName,
      pushSpec.targetBranch
    );
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    const pushPromise = new Promise<void>((resolve, reject) => {
      this.pendingPushResolvers.set(resolverKey, { resolve, reject });

      timeoutId = setTimeout(() => {
        if (this.pendingPushResolvers.has(resolverKey)) {
          this.pendingPushResolvers.delete(resolverKey);
          reject(new Error(`Push operation timed out after ${PUSH_TIMEOUT_MS / 1000} seconds`));
        }
      }, PUSH_TIMEOUT_MS);
    });

    this.log.info("Sending push command", {
      branch_name: pushSpec.targetBranch,
      repo_owner: pushSpec.repoOwner,
      repo_name: pushSpec.repoName,
    });
    const delivered = this.wsManager.send(sandboxWs, {
      type: "push",
      pushSpec,
    });
    if (!delivered) {
      const resolver = this.pendingPushResolvers.get(resolverKey);
      this.pendingPushResolvers.delete(resolverKey);
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = undefined;
      }
      resolver?.reject(new Error("Failed to deliver push command to sandbox"));
    }

    try {
      await pushPromise;
      this.log.info("Push completed successfully", { branch_name: pushSpec.targetBranch });
      return { success: true };
    } catch (pushError) {
      this.log.error("Push failed", {
        branch_name: pushSpec.targetBranch,
        error: pushError instanceof Error ? pushError : String(pushError),
      });
      return { success: false, error: `Failed to push branch: ${pushError}` };
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    }
  }

  /** Settle the pending push a terminal event answers, if one is waiting. */
  settlePush(event: PushTerminalEvent): void {
    const entry = this.findPushResolver(event);
    if (!entry) {
      this.log.warn("Push event matched no pending resolver", {
        event_type: event.type,
        branch_name: event.branchName ?? null,
        repo_owner: event.repoOwner ?? null,
        repo_name: event.repoName ?? null,
        pending_resolvers: Array.from(this.pendingPushResolvers.keys()),
      });
      return;
    }

    const [resolverKey, resolver] = entry;
    if (event.type === "push_complete") {
      this.log.info("Push completed, resolving promise", {
        branch_name: event.branchName ?? null,
        pending_resolvers: Array.from(this.pendingPushResolvers.keys()),
      });
      resolver.resolve();
    } else {
      const error = event.error || "Push failed";
      this.log.warn("Push failed for branch", {
        branch_name: event.branchName ?? null,
        error,
      });
      resolver.reject(new Error(error));
    }

    this.pendingPushResolvers.delete(resolverKey);
  }

  /**
   * Match a terminal push event to its pending resolver. Events carrying the
   * full identity match strictly by key — a fully identified miss is a stale
   * or wrong-repo event and must not settle anything. Only events missing
   * identity (legacy single-repo runtimes echo no repo identity, and their
   * "no repository found" push_error carries no branchName either) settle
   * the sole pending push — by construction only one can be in flight when
   * identity is missing.
   */
  private findPushResolver(event: PushTerminalEvent): [string, PushResolver] | null {
    if (event.repoOwner && event.repoName && event.branchName) {
      const resolverKey = this.pushResolverKey(event.repoOwner, event.repoName, event.branchName);
      const resolver = this.pendingPushResolvers.get(resolverKey);
      return resolver ? [resolverKey, resolver] : null;
    }
    if (this.pendingPushResolvers.size === 1) {
      const [sole] = this.pendingPushResolvers.entries();
      return sole;
    }
    return null;
  }

  private pushResolverKey(repoOwner: string, repoName: string, branchName: string): string {
    return `${repoOwner.toLowerCase()}/${repoName.toLowerCase()}::${branchName.trim().toLowerCase()}`;
  }
}
