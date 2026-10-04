import type { Logger } from "../../logger";
import type { AlarmScheduler, BackgroundTasks } from "../../platform-ports";
import type { SandboxRow, SessionRow } from "../../session/types";
import {
  SandboxProviderError,
  type CreateSandboxConfig,
  type CreateSandboxResult,
  type ResolveSandboxResult,
  type SandboxLifetime,
  type SandboxProvider,
} from "../provider";
import { modalVmAllocationDetail } from "../providers/modal-provider";
import { parsePendingVmReference } from "../providers/pending-vm-reference";
import { PENDING_VM_REFERENCE_MATERIALIZE_BOUND_MS } from "./decisions";
import type { SandboxLaunchContext } from "./launch-context";
import type { SandboxGeneration } from "./ports";
import type { SandboxAccess } from "./sandbox-access";
import { SandboxLaunchExpiredError, SpawnSupersededError } from "./startup-errors";

const VM_RESOLVE_RETRY_MS = 10_000;
/** Interval between alarm-driven lookups once a connected bridge's retry window has closed. */
const VM_RESOLVE_ALARM_RETRY_MS = 60_000;

type PendingStartupConfig = Pick<
  CreateSandboxConfig,
  "sessionId" | "sandboxId" | "generationCreatedAtMs" | "timeoutSeconds"
>;

/** Whether an alarm may next look up a connected bridge's generation, and when. */
type BridgeAlarmRetry =
  | { generation: SandboxGeneration; kind: "armed"; atMs: number }
  | { generation: SandboxGeneration; kind: "exhausted" };

function sameGeneration(a: SandboxGeneration, b: SandboxGeneration): boolean {
  return a.sandboxId === b.sandboxId && a.createdAt === b.createdAt;
}

export interface VmStartupReconciliationStorage {
  getSandbox(): SandboxRow | null;
  updateSandboxModalObjectId(modalObjectId: string | null): void;
  /** Repository rechecks generation, fence, status and expected reference after encryption. */
  completeProviderResume(
    generation: SandboxGeneration,
    access: {
      providerObjectId: string;
      codeServer: { url: string; password: string } | null;
      vnc: { url: string; password: string } | null;
      ttyd: { url: string | null; token: string } | null;
      tunnelUrls: Record<string, string> | null;
    },
    expectedProviderObjectId?: string
  ): Promise<boolean>;
}

export interface VmStartupReconciliationShutdown {
  /** Records a generation-scoped pending handle and its conservative expiry. */
  recordPendingProviderHandle(
    generation: SandboxGeneration,
    reference: string,
    lifetime: Extract<SandboxLifetime, { kind: "finite" }>
  ): Promise<"registered" | "expired" | "superseded">;
  /** Swaps a recovered handle without changing shutdown policy or lifetime. */
  recordResolvedProviderHandle?(
    generation: SandboxGeneration,
    expectedReference: string,
    providerObjectId: string
  ): void;
}

export interface VmStartupReconciliationDependencies {
  provider: Pick<
    SandboxProvider,
    | "name"
    | "createSandbox"
    | "pendingSandboxAllocation"
    | "isUnknownStartupError"
    | "resolveSandbox"
  >;
  storage: VmStartupReconciliationStorage;
  shutdown: VmStartupReconciliationShutdown;
  sessionContext: { getSession(): SessionRow | null };
  launchContext: Pick<SandboxLaunchContext, "resolveSandboxSettings">;
  access: Pick<SandboxAccess, "mintTtydToken" | "broadcastProviderAccessIfConnected">;
  /** Manager-owned generic acceptance, cleanup, lifetime recording and announcements. */
  acceptResolvedStartup(
    generation: SandboxGeneration,
    providerObjectId: string | undefined,
    lifetime: SandboxLifetime
  ): Promise<boolean>;
  getLogger: () => Pick<Logger, "warn">;
  alarmScheduler: Pick<AlarmScheduler, "schedule">;
  backgroundTasks?: BackgroundTasks;
}

/** Reconciles an already-authorized startup; owns no admission or preservation policy. */
export class VmStartupReconciliation {
  private bridgeResolution: SandboxGeneration | null = null;
  /**
   * Armed by each alarm lookup; exhausted once any lookup for the generation, including an
   * attach or ready lookup, fails non-retryably, which ends its alarm lookups.
   */
  private bridgeAlarmRetry: BridgeAlarmRetry | null = null;
  /** A lookup requested while another generation's was in flight; it runs once that settles. */
  private queuedBridgeLookup: { generation: SandboxGeneration; retryWindowMs: number } | null =
    null;
  private bridgeStartupClaim: SandboxGeneration | null = null;
  private bridgeResolvedStartup: {
    generation: SandboxGeneration;
    result: ResolveSandboxResult;
  } | null = null;
  private vmStartupAuth: {
    generation: SandboxGeneration;
    sessionId: string;
    token: string;
  } | null = null;

  constructor(private readonly deps: VmStartupReconciliationDependencies) {}

  registerForegroundAuth(generation: SandboxGeneration, sessionId: string, token: string): void {
    if (this.deps.provider.name === "modal-vm")
      this.vmStartupAuth = { generation, sessionId, token };
  }

  /** The base-image retry drops old auth before reservation/hash publication can yield. */
  beginForegroundRetry(): void {
    this.vmStartupAuth = null;
  }

  finalizeForeground(generation: SandboxGeneration | null): void {
    // Foreground ownership is object identity; bridges authenticate equal-valued generations.
    if (this.vmStartupAuth?.generation === generation && this.bridgeStartupClaim !== generation)
      this.vmStartupAuth = null;
  }

  async recordPendingProviderReference(
    generation: SandboxGeneration,
    config: PendingStartupConfig
  ): Promise<void> {
    const { provider, storage, shutdown } = this.deps;
    if (!generation.sandboxId || config.sandboxId !== generation.sandboxId)
      throw new SpawnSupersededError();
    const pending = provider.pendingSandboxAllocation?.(config);
    if (!pending) return;
    const row = storage.getSandbox();
    if (
      row?.modal_sandbox_id !== generation.sandboxId ||
      row.created_at !== generation.createdAt ||
      row.fenced
    ) {
      throw new SpawnSupersededError();
    }
    const previousProviderObjectId = row.modal_object_id;
    storage.updateSandboxModalObjectId(pending.reference);
    const registered = await shutdown.recordPendingProviderHandle(
      generation,
      pending.reference,
      pending.lifetime
    );
    if (registered === "superseded") throw new SpawnSupersededError();
    if (registered === "expired") {
      const current = storage.getSandbox();
      if (
        current?.modal_sandbox_id === generation.sandboxId &&
        current.created_at === generation.createdAt &&
        current.modal_object_id === pending.reference &&
        !current.fenced
      ) {
        storage.updateSandboxModalObjectId(previousProviderObjectId);
      }
      throw new SandboxLaunchExpiredError();
    }
  }

  async createWithVmRecovery(
    config: CreateSandboxConfig,
    generation: SandboxGeneration
  ): Promise<CreateSandboxResult | null> {
    const { provider } = this.deps;
    try {
      return await provider.createSandbox(config);
    } catch (error) {
      if (!provider.isUnknownStartupError?.(error)) throw error;
      const recovered = await this.resolveUnknownVmStartup(generation, config);
      return recovered ? { ...recovered, createdAt: generation.createdAt } : null;
    }
  }

  private knownBridgeStartup(
    generation: SandboxGeneration,
    row: SandboxRow | null
  ): ResolveSandboxResult | null {
    const known = this.bridgeResolvedStartup;
    if (
      !known ||
      row?.modal_sandbox_id !== generation.sandboxId ||
      row.created_at !== generation.createdAt ||
      row.fenced ||
      !["spawning", "connecting", "ready"].includes(row.status) ||
      row.modal_object_id !== known.result.providerObjectId ||
      known.generation.sandboxId !== generation.sandboxId ||
      known.generation.createdAt !== generation.createdAt
    )
      return null;
    return known.result;
  }

  async resolveUnknownVmStartup(
    generation: SandboxGeneration,
    config: PendingStartupConfig
  ): Promise<ResolveSandboxResult | null> {
    const { provider, storage } = this.deps;
    if (!provider.resolveSandbox) return null;
    const reference = provider.pendingSandboxAllocation?.(config)?.reference;
    while (true) {
      const row = storage.getSandbox();
      const bridged = this.knownBridgeStartup(generation, row);
      if (bridged) return bridged;
      const resolvedByBridge =
        !!row?.modal_object_id &&
        row.modal_object_id !== reference &&
        parsePendingVmReference(row.modal_object_id) === null;
      if (
        row?.modal_sandbox_id !== generation.sandboxId ||
        row.created_at !== generation.createdAt ||
        row.fenced ||
        !["spawning", "connecting", "ready"].includes(row.status) ||
        (row.modal_object_id !== reference && !resolvedByBridge)
      )
        return null;
      try {
        return await provider.resolveSandbox({
          ...config,
          generationCreatedAtMs: generation.createdAt,
        });
      } catch (error) {
        const detail = modalVmAllocationDetail(error);
        if (detail === "other_generation") throw error;
        if (detail !== "not_visible" && !provider.isUnknownStartupError?.(error)) throw error;
        if (Date.now() - generation.createdAt >= PENDING_VM_REFERENCE_MATERIALIZE_BOUND_MS) {
          const current = storage.getSandbox();
          const bridgedAfterLookup = this.knownBridgeStartup(generation, current);
          if (bridgedAfterLookup) return bridgedAfterLookup;
          if (
            current?.modal_sandbox_id === generation.sandboxId &&
            current.created_at === generation.createdAt &&
            !current.fenced &&
            current.modal_object_id &&
            parsePendingVmReference(current.modal_object_id) === null
          ) {
            const lifetime = provider.pendingSandboxAllocation?.(config)?.lifetime;
            if (lifetime)
              return {
                sandboxId: config.sandboxId,
                providerObjectId: current.modal_object_id,
                lifetime,
              };
          }
          if (detail === "not_visible")
            throw new SandboxProviderError(
              "The VM allocation did not appear for this attempt. Please retry.",
              "transient",
              error instanceof Error ? error : undefined
            );
          if (
            current?.modal_sandbox_id === generation.sandboxId &&
            current.created_at === generation.createdAt &&
            !current.fenced &&
            current.modal_object_id === reference
          )
            this.bridgeStartupClaim = generation;
          return null;
        }
      }
      await new Promise<void>((resolve) => setTimeout(resolve, VM_RESOLVE_RETRY_MS));
    }
  }

  /**
   * Synchronous bridge entry submits lookup-only work without holding readiness.
   * Retryable failures repeat within `retryWindowMs`, so a window of 0 makes a single attempt;
   * `resumePendingBridge` continues after it.
   */
  resolvePendingBridge(
    generation: SandboxGeneration,
    retryWindowMs = PENDING_VM_REFERENCE_MATERIALIZE_BOUND_MS
  ): void {
    if (this.bridgeResolution) {
      if (!sameGeneration(this.bridgeResolution, generation)) {
        // An alarm's single attempt joining a queued attach or ready keeps that window.
        const queued = this.queuedBridgeLookup;
        this.queuedBridgeLookup = {
          generation,
          retryWindowMs:
            queued && sameGeneration(queued.generation, generation)
              ? Math.max(queued.retryWindowMs, retryWindowMs)
              : retryWindowMs,
        };
      }
      return;
    }
    const target = this.pendingBridgeTarget(generation);
    if (!target) return;
    const { reference, pending, session } = target;
    const { provider, storage, launchContext, access, shutdown, backgroundTasks } = this.deps;
    const config = {
      sessionId: pending.sessionId,
      sandboxId: pending.sandboxId,
      generationCreatedAtMs: generation.createdAt,
      timeoutSeconds: launchContext.resolveSandboxSettings(session).timeoutSeconds,
    };
    const retryDeadlineAtMs = Date.now() + retryWindowMs;
    this.bridgeResolution = generation;
    const work = () =>
      (async () => {
        let result: ResolveSandboxResult;
        while (true) {
          const current = storage.getSandbox();
          if (
            current?.modal_sandbox_id !== generation.sandboxId ||
            current.created_at !== generation.createdAt ||
            current.fenced ||
            !["spawning", "connecting", "ready"].includes(current.status) ||
            current.modal_object_id !== reference
          )
            return;
          try {
            result = await provider.resolveSandbox!(config);
            break;
          } catch (error) {
            const detail = modalVmAllocationDetail(error);
            const retryable =
              detail === "not_visible"
                ? Date.now() - generation.createdAt < PENDING_VM_REFERENCE_MATERIALIZE_BOUND_MS
                : !!provider.isUnknownStartupError?.(error);
            if (!retryable) {
              this.bridgeAlarmRetry = { generation, kind: "exhausted" };
              if (detail === "not_visible") return;
              throw error;
            }
            if (Date.now() >= retryDeadlineAtMs || this.queuedBridgeLookup) return;
            await new Promise<void>((resolve) => setTimeout(resolve, VM_RESOLVE_RETRY_MS));
          }
        }
        if (!result.providerObjectId) return;
        const auth = this.vmStartupAuth;
        const terminalToken =
          result.ttydUrl &&
          auth &&
          auth.generation.sandboxId === generation.sandboxId &&
          auth.generation.createdAt === generation.createdAt
            ? await access.mintTtydToken(auth.token, auth.sessionId, generation.sandboxId!)
            : null;
        const committed = await storage.completeProviderResume(
          generation,
          {
            providerObjectId: result.providerObjectId,
            codeServer:
              result.codeServerUrl && result.codeServerPassword
                ? { url: result.codeServerUrl, password: result.codeServerPassword }
                : null,
            vnc: result.vncAccess ?? null,
            ttyd:
              result.ttydUrl && terminalToken
                ? { url: result.ttydUrl, token: terminalToken }
                : null,
            tunnelUrls: result.tunnelUrls ?? null,
          },
          reference
        );
        if (!committed) return;
        this.bridgeResolvedStartup = {
          generation,
          result: {
            sandboxId: result.sandboxId,
            providerObjectId: result.providerObjectId,
            lifetime: result.lifetime,
          },
        };
        if (
          this.bridgeStartupClaim?.sandboxId === generation.sandboxId &&
          this.bridgeStartupClaim.createdAt === generation.createdAt
        ) {
          this.bridgeStartupClaim = null;
          try {
            if (
              !(await this.deps.acceptResolvedStartup(
                generation,
                result.providerObjectId,
                result.lifetime
              ))
            )
              return;
          } finally {
            if (
              this.vmStartupAuth?.generation.sandboxId === generation.sandboxId &&
              this.vmStartupAuth.generation.createdAt === generation.createdAt
            )
              this.vmStartupAuth = null;
          }
        } else {
          shutdown.recordResolvedProviderHandle?.(generation, reference, result.providerObjectId);
        }
        access.broadcastProviderAccessIfConnected();
      })()
        .catch((error) => {
          this.deps.getLogger().warn("Bridge VM resolution failed", {
            event: "sandbox.vm_resolve_failed",
            error: error instanceof Error ? error.message : String(error),
          });
        })
        .finally(() => {
          this.bridgeResolution = null;
          const queued = this.queuedBridgeLookup;
          this.queuedBridgeLookup = null;
          if (queued) this.resolvePendingBridge(queued.generation, queued.retryWindowMs);
        });
    if (backgroundTasks) backgroundTasks.submit(work, { name: "sandbox.vm_resolve" });
    else void work();
  }

  /**
   * Alarm entry for a connected bridge's pending lookup. The next attempt is armed on the
   * awaited alarm path before any provider I/O, so a rejected schedule fails the delivery and
   * the platform retries it. An alarm before that time only re-arms it, so neither the second
   * preservation hook of a delivery nor an unrelated earlier alarm repeats the lookup. After a
   * non-retryable failure for the generation, alarms neither look up nor re-arm. This state is
   * in memory, so an alarm in a restarted instance looks up again before it is relearned.
   */
  async resumePendingBridge(generation: SandboxGeneration): Promise<void> {
    if (!this.pendingBridgeTarget(generation)) return;
    const retry = this.bridgeAlarmRetry;
    const now = Date.now();
    if (retry && sameGeneration(retry.generation, generation)) {
      if (retry.kind === "exhausted") return;
      if (now < retry.atMs) {
        await this.deps.alarmScheduler.schedule(retry.atMs);
        return;
      }
    }
    const atMs = now + VM_RESOLVE_ALARM_RETRY_MS;
    await this.deps.alarmScheduler.schedule(atMs);
    this.bridgeAlarmRetry = { generation, kind: "armed", atMs };
    // Rechecks the row after that await and leaves a lookup already in flight to finish.
    this.resolvePendingBridge(generation, 0);
  }

  /** The generation's own pending VM reference, while a bridge lookup may resolve it. */
  private pendingBridgeTarget(generation: SandboxGeneration): {
    reference: string;
    pending: { sessionId: string; sandboxId: string };
    session: SessionRow;
  } | null {
    const { provider, storage, sessionContext } = this.deps;
    if (!provider.resolveSandbox) return null;
    const row = storage.getSandbox();
    const reference = row?.modal_object_id;
    const pending = reference ? parsePendingVmReference(reference) : null;
    const session = sessionContext.getSession();
    if (
      !row ||
      row.fenced ||
      !["spawning", "connecting", "ready"].includes(row.status) ||
      row.created_at !== generation.createdAt ||
      row.modal_sandbox_id !== generation.sandboxId ||
      !reference ||
      !pending ||
      !session ||
      pending.sandboxId !== row.modal_sandbox_id ||
      pending.sessionId !== (session.session_name || session.id)
    )
      return null;
    return { reference, pending, session };
  }
}
