import { DEFAULT_FINAL_SNAPSHOT_BUFFER_MS } from "@open-inspect/shared/types/integrations";
import type { ServerMessage } from "@open-inspect/shared/types/server-messages";
import type { SandboxEvent } from "@open-inspect/shared/types/sandbox-events";
import {
  sandboxShutdownSchema,
  type SandboxShutdownState,
  type ShutdownRecoveryAction,
} from "@open-inspect/shared/types/sandbox-shutdown";
import type { AlarmScheduler, BackgroundTasks } from "../platform-ports";
import type { Logger } from "../logger";
import type { SandboxLifetime, SandboxProvider } from "../sandbox/provider";
import { parsePersistedSandboxSettings } from "../sandbox/settings";
import type {
  SandboxCheckpointOutcome,
  SandboxGeneration,
  SandboxStartupDecision,
  SandboxWorkAdmission,
} from "../sandbox/lifecycle/ports";
import { ShutdownRecoveryRejectedError } from "../sandbox/lifecycle/ports";
import type { ShutdownLifecyclePolicy } from "../sandbox/lifecycle/shutdown-policy";
import { isDeadSandboxStatus } from "../sandbox/lifecycle/decisions";
import { legacyShutdownRecord } from "./legacy-shutdown-record";
import type { SandboxShutdownStorage } from "./sandbox-ports";
import type { SessionCoreRepository } from "./session-core-repository";
import type { MessageRepository } from "./message-repository";
import type { MessageFailureService } from "./message-failure-service";
import type { SessionMessenger } from "./messenger";
import type { SessionWebSocketManager } from "./websocket-manager";
import type { ShutdownRecord, ShutdownStore } from "./sandbox-shutdown-repository";

const STOP_MS = 60_000;
const CAPTURE_MS = 300_000;
const RETIRE_MS = 30_000;
const MARGIN_MS = 30_000;
/** How long a sandbox whose save failed is kept for another attempt. */
const RETRY_WINDOW_MS = 30 * 60_000;

/** User-facing text for a prompt interrupted by a shutdown; reasons are internal codes. */
const INTERRUPTION_MESSAGES: Record<string, string> = {
  heartbeat_timeout: "The sandbox stopped responding.",
  prompt_dispatch_send_failed: "The sandbox stopped responding.",
  stop_send_failed: "The sandbox stopped responding.",
  stop_alarm_failed: "The sandbox stopped responding.",
  stop_confirmation_timeout: "The sandbox stopped responding.",
  fatal_runtime_error: "The sandbox runtime failed.",
  inactivity_timeout: "The sandbox was stopped after a period of inactivity.",
  sandbox_lifetime_expiring: "The sandbox reached its maximum lifetime.",
};

class ShutdownDeadlineError extends Error {}

interface ShutdownDependencies {
  store: ShutdownStore;
  provider: SandboxProvider;
  sandbox: SandboxShutdownStorage;
  session: SessionCoreRepository;
  messages: MessageRepository;
  failures: MessageFailureService;
  messenger: SessionMessenger;
  sockets: SessionWebSocketManager;
  alarm: AlarmScheduler;
  background: BackgroundTasks;
  /** Notifies the lifecycle boundary to re-evaluate queued work under current policy. */
  onLifecycleChange(): Promise<void>;
  /** Re-derives session status after any interrupted message has been persisted. */
  reconcileStatusFromMessages(): Promise<void>;
  retireAccess(): void;
  now?: () => number;
  log?: Logger;
}

/** One durable owner of planned stopping. Provider side effects never imply a saved receipt. */
export class SandboxShutdownCoordinator {
  private activeOperation: string | null = null;
  private checkpointOperationId: string | null = null;
  private checkpointGeneration: SandboxGeneration | null = null;
  private retiringOperation: string | null = null;
  private discardingOperation: string | null = null;
  private activeRestoreGeneration: SandboxGeneration | null = null;
  private readonly now: () => number;

  constructor(private readonly deps: ShutdownDependencies) {
    this.now = deps.now ?? Date.now;
  }

  snapshot(): SandboxShutdownState | null {
    const state = this.normalizeInterruptedRestore();
    return state ? this.project(state) : null;
  }

  /** The public projection; it carries no provider handles or receipts. */
  private project(state: ShutdownRecord): SandboxShutdownState {
    const actions = this.availableRecoveryActions(state);
    return sandboxShutdownSchema.parse({
      ...state,
      savedAtMs: state.receipt?.savedAtMs ?? state.savedAtMs,
      hasRecoveryPoint: !!state.receipt,
      continuationPaused: this.continuationPaused(state),
      availableRecoveryActions: actions.filter((action) => action !== "discard"),
      discardAvailable: actions.includes("discard"),
    });
  }

  private current(state: ShutdownRecord): boolean {
    const row = this.deps.sandbox.getSandbox();
    return (
      row?.modal_sandbox_id === state.generation.sandboxId &&
      row.created_at === state.generation.createdAt
    );
  }

  private publish(state: ShutdownRecord): void {
    this.deps.store.write(state);
    this.announce(state);
  }

  /** Delivery cannot change the outcome of an already committed lifecycle operation. */
  private broadcast(message: ServerMessage): void {
    try {
      this.deps.messenger.broadcast(message);
    } catch (error) {
      this.deps.log?.warn("Sandbox lifecycle announcement failed", {
        event: "sandbox.announcement_failed",
        message_type: message.type,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private announce(state: ShutdownRecord): void {
    this.deps.log?.info("sandbox.preservation", {
      event: "sandbox.preservation",
      phase: state.phase,
      reason: state.reason,
      error: state.error,
      provider: this.deps.provider.name,
      sandbox_id: state.generation.sandboxId,
      generation_created_at: state.generation.createdAt,
      operation_id: state.operationId,
      expires_at_ms: state.expiresAtMs,
    });
    this.broadcast({ type: "sandbox_preservation", preservation: this.project(state) });
  }

  /** Atomically reserves the sandbox row and shutdown ownership before provider work. */
  reserveStartup(
    createdAt: number,
    lifecyclePolicy: ShutdownLifecyclePolicy,
    persistSandboxRow: () => void
  ): void {
    const previous = this.deps.store.read();
    const restoring =
      !!previous?.receipt &&
      (previous.phase === "saved" ||
        (previous.phase === "restoring" && previous.restoreInvoked !== true));
    let next!: ShutdownRecord;
    this.deps.session.transaction(() => {
      persistSandboxRow();
      const row = this.deps.sandbox.getSandbox();
      if (!row?.modal_sandbox_id || row.created_at !== createdAt)
        throw new Error("Missing sandbox generation after reservation");
      next = {
        phase: restoring ? "restoring" : "running",
        generation: { sandboxId: row.modal_sandbox_id, createdAt },
        provider: this.deps.provider.name,
        providerObjectId: null,
        sourceRetired: previous?.sourceRetired === true || previous?.phase === "saved",
        lifetimeKind: "unknown",
        lifetimeSource: undefined,
        expiresAtMs: null,
        drainAtMs: null,
        generationReady: false,
        lifecyclePolicy,
        receipt: previous?.receipt,
        restoreInvoked: restoring ? false : undefined,
      };
      this.deps.store.write(next);
    });
    this.activeRestoreGeneration = restoring ? next.generation : null;
    this.announce(next);
    if (next.lifecyclePolicy === "legacy") {
      this.deps.log?.warn("Restoring existing sandbox under legacy lifecycle policy", {
        event: "sandbox.preservation_legacy_lifecycle",
        sandbox_id: next.generation.sandboxId,
      });
    }
  }

  /** Persist uncertainty before restore/resume can create or reactivate execution. */
  markRecoveryInvoked(generation: SandboxGeneration, providerObjectId?: string): void {
    const state = this.deps.store.read();
    if (!state || !this.current(state) || !this.matches(state, generation))
      throw new Error("Saved sandbox restore generation was superseded");
    this.activeRestoreGeneration = generation;
    this.publish({
      ...state,
      restoreInvoked: true,
      // Only retained resume reactivates the source described by the receipt.
      sourceRetired: providerObjectId ? false : state.sourceRetired,
      providerObjectId: providerObjectId ?? null,
    });
  }

  /** The pending reference belongs to this generation, unlike a row handle left by a prior one. */
  async recordPendingProviderHandle(
    generation: SandboxGeneration,
    reference: string,
    lifetime: Extract<SandboxLifetime, { kind: "finite" }>
  ): Promise<void> {
    const state = this.deps.store.read();
    if (!state || !this.current(state) || !this.matches(state, generation)) return;
    const settings = parsePersistedSandboxSettings(
      this.deps.session.getSession()?.sandbox_settings ?? null
    );
    const expiresAtMs = lifetime.expiresAtMs;
    const next: ShutdownRecord = {
      ...state,
      providerObjectId: reference,
      sourceRetired: false,
      lifetimeKind: "finite",
      lifetimeSource: lifetime.source,
      expiresAtMs,
      drainAtMs:
        state.lifecyclePolicy === "legacy"
          ? null
          : expiresAtMs - (settings.finalSnapshotBufferMs ?? DEFAULT_FINAL_SNAPSHOT_BUFFER_MS),
    };
    this.publish(next);
    if (next.phase !== "running" || next.drainAtMs === null) return;
    if (this.now() >= next.drainAtMs) await this.requestShutdown("sandbox_lifetime_expiring");
    else await this.deps.alarm.schedule(next.drainAtMs);
  }

  async recordProviderStartup(
    generation: SandboxGeneration,
    lifetime: SandboxLifetime
  ): Promise<void> {
    const state = this.deps.store.read();
    if (
      !state ||
      !this.current(state) ||
      state.generation.createdAt !== generation.createdAt ||
      state.generation.sandboxId !== generation.sandboxId
    )
      return;
    const row = this.deps.sandbox.getSandbox();
    const settings = parsePersistedSandboxSettings(
      this.deps.session.getSession()?.sandbox_settings ?? null
    );
    const buffer = settings.finalSnapshotBufferMs ?? DEFAULT_FINAL_SNAPSHOT_BUFFER_MS;
    const lifetimeToRecord =
      state.lifetimeKind === "finite" &&
      state.expiresAtMs !== null &&
      (lifetime.kind !== "finite" || state.expiresAtMs <= lifetime.expiresAtMs)
        ? {
            kind: "finite" as const,
            expiresAtMs: state.expiresAtMs,
            source: state.lifetimeSource,
          }
        : lifetime;
    const expiresAtMs = lifetimeToRecord.kind === "finite" ? lifetimeToRecord.expiresAtMs : null;
    const legacy = state.lifecyclePolicy === "legacy";
    const next: ShutdownRecord = {
      ...state,
      phase: state.phase === "restoring" ? "running" : state.phase,
      restoreInvoked: undefined,
      providerObjectId: row?.modal_object_id ?? null,
      sourceRetired: false,
      lifetimeKind: lifetimeToRecord.kind,
      lifetimeSource: lifetimeToRecord.kind === "finite" ? lifetimeToRecord.source : undefined,
      expiresAtMs,
      drainAtMs: legacy || expiresAtMs === null ? null : expiresAtMs - buffer,
    };
    this.publish(next);
    if (legacy) {
      this.notifyLifecycleChange();
      return;
    }
    if (next.lifetimeKind === "unknown") {
      this.fail(
        next,
        "unknown",
        "Provider expiry could not be established; automatic dispatch is held."
      );
      return;
    }
    if (next.phase !== "running") return;
    this.bindGeneration(next);
    if (next.drainAtMs !== null) {
      if (this.now() >= next.drainAtMs) await this.requestShutdown("sandbox_lifetime_expiring");
      else await this.deps.alarm.schedule(next.drainAtMs);
    }
    this.notifyLifecycleChange();
  }

  runtimeReady(version?: 1): void {
    const state = this.deps.store.read();
    if (!state || !this.current(state)) return;
    const next = { ...state, runtimeReady: true, protocolVersion: version };
    this.publish(next);
    if (state.lifecyclePolicy === "legacy") {
      this.notifyLifecycleChange();
      return;
    }
    if (version !== 1) {
      this.fail(
        next,
        "failed",
        "This sandbox runtime does not support confirmed graceful shutdown. Upgrade the runtime before resuming work."
      );
      return;
    }
    this.bindGeneration(next);
  }

  private bindGeneration(state: ShutdownRecord): void {
    const socket = this.deps.sockets.getSandboxSocket();
    if (socket && state.protocolVersion === 1) {
      this.deps.sockets.send(socket, { type: "sandbox_generation", generation: state.generation });
    }
  }

  generationReady(event: Extract<SandboxEvent, { type: "sandbox_generation_ready" }>): void {
    const state = this.deps.store.read();
    if (!state || !this.matches(state, event.generation) || !this.current(state)) return;
    this.publish({ ...state, generationReady: true });
    if (state.phase === "draining") this.kickAdvance();
    else this.notifyLifecycleChange();
  }

  /** Synchronous admission gate; call again after every dispatch-path await. */
  admissionDecision(): SandboxWorkAdmission {
    const state = this.normalizeInterruptedRestore();
    if (!state) return "unmanaged";
    if (state.phase === "saved" && this.continuationPaused(state)) return "held";
    if (state.phase === "saved") return "restore_required";
    if (state.phase === "restoring" && !state.restoreInvoked) return "restore_required";
    if (state.phase !== "running" || !this.current(state)) return "held";
    if (!this.providerMatches(state)) return "held";
    if (state.restoreInvoked) return "held";
    if (state.lifecyclePolicy === "legacy") {
      return state.checkpointInFlight ? "held" : "ready";
    }
    // A runtime that never became ready served no work, so its death is a
    // failed boot: the spawn path retries it (restoring any saved state)
    // under the circuit breaker. Unknown shutdown state never does.
    const row = this.deps.sandbox.getSandbox();
    if (!state.runtimeReady && row && isDeadSandboxStatus(row.status)) return "spawn_required";
    if (state.drainAtMs !== null && this.now() >= state.drainAtMs) {
      this.deps.background.submit(() => this.requestShutdown("sandbox_lifetime_expiring"), {
        name: "sandbox.preserve",
      });
      return "held";
    }
    return state.lifetimeKind !== "unknown" && state.generationReady && !state.checkpointInFlight
      ? "ready"
      : "held";
  }

  isHolding(): boolean {
    const state = this.normalizeInterruptedRestore();
    if (
      state?.phase === "restoring" &&
      (!state.restoreInvoked ||
        (this.activeRestoreGeneration && this.matches(state, this.activeRestoreGeneration)))
    )
      return false;
    const phase = state?.phase;
    return (
      state?.checkpointInFlight === true ||
      (state !== null && phase === "saved" && this.continuationPaused(state)) ||
      (phase !== undefined && phase !== "running" && phase !== "saved")
    );
  }

  startupDecision(): SandboxStartupDecision {
    const state = this.normalizeInterruptedRestore();
    if (!state) return { kind: "normal" };
    if (
      (state.provider !== undefined && state.provider !== this.deps.provider.name) ||
      (state.receipt && state.receipt.provider !== this.deps.provider.name)
    ) {
      const reason = "The configured sandbox provider changed";
      if (state.phase !== "unknown") this.fail(state, "unknown", reason);
      return { kind: "hold", reason };
    }
    if (!this.current(state))
      return { kind: "hold", reason: "Sandbox generation changed during graceful shutdown" };
    const receipt =
      (state.phase === "saved" && !this.continuationPaused(state)) ||
      (state.phase === "restoring" && !state.restoreInvoked)
        ? state.receipt
        : undefined;
    if (receipt?.kind === "snapshot")
      return {
        kind: "restore_snapshot",
        snapshotId: receipt.artifactId,
        runtimeVersion: receipt.runtimeVersion,
      };
    if (receipt?.kind === "retained")
      return {
        kind: "resume_retained",
        providerObjectId: receipt.artifactId,
        runtimeVersion: receipt.runtimeVersion,
      };
    return this.isHolding()
      ? { kind: "hold", reason: state.error ?? "Sandbox shutdown is held" }
      : { kind: "normal" };
  }

  holdFailedRecovery(error: string, generation?: SandboxGeneration): void {
    const state = this.deps.store.read();
    const row = this.deps.sandbox.getSandbox();
    if (
      !row?.modal_sandbox_id ||
      (generation &&
        (row.modal_sandbox_id !== generation.sandboxId ||
          row.created_at !== generation.createdAt)) ||
      (state && !this.current(state))
    )
      return;
    if (!state?.receipt && !row.snapshot_image_id) return;
    // Old snapshot projections lack receipt provenance. Retain them in place,
    // without fabricating a verified receipt or permission to restore.
    this.fail(
      {
        ...(state ?? legacyShutdownRecord(row, this.deps.provider.name)),
        sourceRetired: state?.sourceRetired === true || state?.phase === "saved",
      },
      "unknown",
      `Saved sandbox could not be restored: ${error}. No fresh sandbox was substituted. The snapshot reference is retained; contact your operator for recovery or start a separate session.`
    );
  }

  /** Only an explicit authenticated, currently eligible user choice may leave a hold. */
  async recover(action: ShutdownRecoveryAction): Promise<void> {
    const state = this.normalizeInterruptedRestore();
    if (!state || !this.availableRecoveryActions(state).includes(action))
      throw new ShutdownRecoveryRejectedError();
    if (action === "discard") {
      await this.discard(state);
      return;
    }
    if (state.phase === "saved" && this.continuationPaused(state)) {
      this.publish({ ...state, continuationPaused: false });
      this.notifyLifecycleChange();
      return;
    }
    if (action === "retry") {
      await this.retryCapture(state);
      return;
    }
    const next: ShutdownRecord = {
      ...state,
      phase: "retiring",
      reason: "restore_saved_state",
      error: undefined,
      continuationPaused: false,
      operationId: crypto.randomUUID(),
      retireByMs: this.now() + RETIRE_MS,
    };
    this.publish(next);
    if (
      state.lifetimeSource === "provider" &&
      state.expiresAtMs !== null &&
      this.now() >= state.expiresAtMs
    ) {
      // The hard provider deadline independently proves the old execution ended.
      this.finish(next);
    } else if (state.providerObjectId && this.canStopSource()) {
      // Stop a known source even when retirement was recorded: an interrupted
      // restore keeps the proof about the source it replaced, not its own.
      await this.retire(next);
    } else if (state.sourceRetired) this.finish(next);
    else
      this.fail(
        next,
        "unknown",
        "The source provider handle is unknown; retirement cannot be verified."
      );
  }

  private availableRecoveryActions(state: ShutdownRecord): ShutdownRecoveryAction[] {
    if (
      !this.current(state) ||
      (state.provider !== undefined && state.provider !== this.deps.provider.name) ||
      (state.receipt && state.receipt.provider !== this.deps.provider.name)
    )
      return [];
    if (state.phase === "failed" || state.phase === "unknown") {
      // A claimed discard can only be completed, and is resubmittable only
      // when no call in this instance is still stopping its source.
      if (state.discarding) return this.discardingOperation === null ? ["discard"] : [];
      const actions: ShutdownRecoveryAction[] = [];
      if (this.canRetryShutdown(state)) actions.push("retry");
      if (this.canRestoreSaved(state)) actions.push("restore_saved");
      if (this.canDiscard(state)) actions.push("discard");
      return actions;
    }
    if (state.phase === "saved" && this.continuationPaused(state))
      return this.canRestoreSaved(state) ? ["restore_saved"] : [];
    return [];
  }

  private canRestoreSaved(state: ShutdownRecord): boolean {
    if (!state.receipt || state.receipt.provider !== this.deps.provider.name) return false;
    return (
      state.phase === "saved" ||
      state.sourceRetired === true ||
      (state.lifetimeSource === "provider" &&
        state.expiresAtMs !== null &&
        this.now() >= state.expiresAtMs) ||
      (!!state.providerObjectId && this.canStopSource())
    );
  }

  /**
   * Another capture of a source that may still hold unsaved work. It needs no
   * runtime, so it is offered whether or not the runtime responds. The source
   * is kept for it until a fixed time after the shutdown began, which retries
   * do not extend.
   */
  private canRetryShutdown(state: ShutdownRecord): boolean {
    const provider = this.deps.provider;
    const canCapture =
      (provider.capabilities.supportsPersistentResume === true && this.canStopSource()) ||
      (provider.capabilities.supportsSnapshots === true && !!provider.takeSnapshot);
    const now = this.now();
    return (
      !state.discarding &&
      !state.restoreInvoked &&
      !state.checkpointInFlight &&
      state.sourceRetired !== true &&
      !!state.providerObjectId &&
      !this.receiptCoversSource(state) &&
      state.stopByMs !== undefined &&
      state.captureByMs !== undefined &&
      now < state.stopByMs + RETRY_WINDOW_MS &&
      canCapture &&
      this.emergencyWindow(state, now).captureByMs > now + MARGIN_MS
    );
  }

  /** Captures the held source again under a new operation, without waiting for its runtime. */
  private async retryCapture(state: ShutdownRecord): Promise<void> {
    if (this.activeOperation !== null || !this.owns(state) || !this.canRetryShutdown(state)) return;
    const next: ShutdownRecord = {
      ...state,
      error: undefined,
      operationId: crypto.randomUUID(),
      ...this.emergencyWindow(state, this.now()),
    };
    this.fenceRuntime();
    await this.capture(next);
  }

  /**
   * Nothing may still write to the source once it is discarded, so a known
   * source must be stoppable. Recorded retirement is trusted only when it is
   * not: it may describe an earlier source than an interrupted restore created.
   */
  private canDiscard(state: ShutdownRecord): boolean {
    return (
      this.checkpointOperationId === null &&
      (!state.providerObjectId || this.canStopSource() || state.sourceRetired === true)
    );
  }

  private canStopSource(): boolean {
    return (
      this.deps.provider.capabilities.supportsExplicitStop === true &&
      !!this.deps.provider.stopSandbox
    );
  }

  /** The receipt was captured from this generation's source rather than carried from an earlier one. */
  private receiptCoversSource(state: ShutdownRecord): boolean {
    return !!state.receipt && state.receipt.savedAtMs >= state.generation.createdAt;
  }

  /** One absolute budget for a capture that does not wait for the runtime. */
  private emergencyWindow(
    state: ShutdownRecord | null,
    now: number
  ): { captureByMs: number; retireByMs: number } {
    const end = Math.min(state?.expiresAtMs ?? Infinity, now + CAPTURE_MS + RETIRE_MS + MARGIN_MS);
    return { captureByMs: end - RETIRE_MS - MARGIN_MS, retireByMs: end - MARGIN_MS };
  }

  /**
   * A runtime refused at reconnect normally exits, which ends its sandbox.
   * While a capture needs that sandbox the runtime is told to retry instead.
   * A save that failed while the runtime was unresponsive is attempted again
   * now that it is back, at most once per capture window.
   */
  onRefusedReconnect(): "retry" | "exit" {
    const state = this.deps.store.read();
    if (!state || !this.current(state)) return "exit";
    if (state.phase === "draining" || state.phase === "prepared" || state.phase === "capturing")
      return "retry";
    if ((state.phase !== "failed" && state.phase !== "unknown") || !this.canRetryShutdown(state))
      return "exit";
    if (this.activeOperation === null && this.now() >= state.captureByMs!) {
      this.deps.log?.info("Retrying a failed save after the runtime reconnected", {
        event: "sandbox.preservation_retry",
        operation_id: state.operationId,
        reason: state.reason,
      });
      this.deps.background.submit(() => this.retryCapture(state), {
        name: "sandbox.preservation_retry",
      });
    }
    return "retry";
  }

  /**
   * Explicitly abandons unsaved work: stops the source, then leaves a record
   * with no receipt and no provider handle so the next start is fresh.
   */
  private async discard(state: ShutdownRecord): Promise<void> {
    // Claimed durably before any provider I/O, so no other recovery can act on
    // this source while it is being stopped, including after a restart.
    const claim: ShutdownRecord = { ...state, discarding: crypto.randomUUID(), error: undefined };
    this.discardingOperation = claim.discarding!;
    try {
      this.publish(claim);
      if (claim.providerObjectId && this.canStopSource()) {
        try {
          await this.stopSource(
            claim,
            claim.providerObjectId,
            "discard",
            "destroy",
            this.now() + RETIRE_MS
          );
        } catch {
          if (this.ownsDiscard(claim)) {
            const error = "The sandbox could not be stopped, so nothing was discarded. Try again.";
            this.publish({ ...claim, discarding: undefined, error });
            this.broadcast({ type: "sandbox_warning", message: error });
          }
          return;
        }
      }
      if (this.ownsDiscard(claim)) this.completeDiscard(claim);
    } finally {
      this.discardingOperation = null;
    }
  }

  private ownsDiscard(claim: ShutdownRecord): boolean {
    const current = this.deps.store.read();
    return this.current(claim) && current?.discarding === claim.discarding;
  }

  private completeDiscard(state: ShutdownRecord): void {
    const next: ShutdownRecord = {
      phase: "running",
      generation: state.generation,
      provider: this.deps.provider.name,
      providerObjectId: null,
      sourceRetired: true,
      lifetimeKind: "unknown",
      expiresAtMs: null,
      drainAtMs: null,
      generationReady: false,
      lifecyclePolicy: state.lifecyclePolicy,
    };
    this.deps.session.transaction(() => {
      if (!this.deps.sandbox.discardSandboxState(state.generation))
        throw new Error("Sandbox generation was superseded");
      this.deps.store.write(next);
    });
    this.deps.log?.info("Sandbox discarded", {
      event: "sandbox.discarded",
      sandbox_id: state.generation.sandboxId,
      previous_phase: state.phase,
      had_recovery_point: !!state.receipt,
    });
    this.announce(next);
    this.deps.retireAccess();
    this.broadcast({ type: "sandbox_status", status: "stopped" });
    this.notifyLifecycleChange();
  }

  /** Owns an ordinary capture from admission through durable outcome classification. */
  async captureCheckpoint(
    generation: SandboxGeneration,
    reason: string
  ): Promise<SandboxCheckpointOutcome> {
    if (this.checkpointOperationId || generation.sandboxId === null) return { outcome: "held" };
    const checkpointGeneration = { ...generation, sandboxId: generation.sandboxId };
    const now = this.now();
    let state = this.deps.store.read();
    if (state) {
      if (
        this.admissionDecision() !== "ready" ||
        !this.matches(state, generation) ||
        state.checkpointInFlight
      )
        return { outcome: "held" };
      if (state.drainAtMs !== null && now + CAPTURE_MS + MARGIN_MS > state.drainAtMs)
        return { outcome: "held" };
    } else {
      const row = this.deps.sandbox.getSandbox();
      if (
        !row ||
        row.modal_sandbox_id !== generation.sandboxId ||
        row.created_at !== generation.createdAt
      )
        return { outcome: "held" };
      state = legacyShutdownRecord(row, this.deps.provider.name);
    }

    const deadlineAtMs = Math.min(
      now + CAPTURE_MS,
      state.drainAtMs === null ? Number.POSITIVE_INFINITY : state.drainAtMs - MARGIN_MS
    );
    const id = crypto.randomUUID();
    this.deps.store.write({ ...state, checkpointInFlight: true });
    this.checkpointOperationId = id;
    this.checkpointGeneration = checkpointGeneration;
    const row = this.deps.sandbox.getSandbox();
    const session = this.deps.session.getSession();
    if (!row?.modal_object_id || !session) {
      this.endCheckpoint(id, false);
      return { outcome: "held" };
    }
    const previousStatus = row.status;
    const statusChanged =
      !isDeadSandboxStatus(previousStatus) &&
      this.deps.sandbox.transitionSandboxStatus(
        checkpointGeneration,
        previousStatus,
        "snapshotting"
      );
    if (statusChanged) this.broadcast({ type: "sandbox_status", status: "snapshotting" });
    try {
      const result = await this.captureSnapshot(
        row.modal_object_id,
        session.session_name || session.id,
        reason,
        deadlineAtMs
      );
      const current = this.deps.sandbox.getSandbox();
      if (
        this.checkpointOperationId !== id ||
        current?.modal_sandbox_id !== checkpointGeneration.sandboxId ||
        current.created_at !== checkpointGeneration.createdAt ||
        !this.deps.sandbox.recordSandboxSnapshot(
          checkpointGeneration.sandboxId,
          result.imageId,
          row.runtime_version
        )
      ) {
        this.endCheckpoint(id, true);
        return { outcome: "unknown" };
      }
      this.broadcast({ type: "snapshot_saved", imageId: result.imageId, reason });
      if (result.sourceStopped) {
        this.deps.sandbox.updateSandboxStatus("stopped");
        this.deps.retireAccess();
        this.broadcast({ type: "sandbox_status", status: "stopped" });
      } else if (
        statusChanged &&
        reason !== "heartbeat_timeout" &&
        this.deps.sandbox.transitionSandboxStatus(
          checkpointGeneration,
          "snapshotting",
          previousStatus
        )
      ) {
        this.broadcast({ type: "sandbox_status", status: previousStatus });
        if (previousStatus === "ready") this.broadcast({ type: "sandbox_access_changed" });
      }
      this.endCheckpoint(id, false);
      return {
        outcome: "saved",
        imageId: result.imageId,
        sourceStopped: result.sourceStopped,
      };
    } catch {
      this.endCheckpoint(id, true);
      return { outcome: "unknown" };
    }
  }

  private endCheckpoint(id: string, uncertain: boolean): void {
    if (this.checkpointOperationId !== id) return;
    this.checkpointOperationId = null;
    const state = this.deps.store.read();
    const generation = this.checkpointGeneration;
    this.checkpointGeneration = null;
    if (
      !generation ||
      !state ||
      state.generation.sandboxId !== generation.sandboxId ||
      state.generation.createdAt !== generation.createdAt
    )
      return;
    if (!state?.checkpointInFlight) return;
    if (uncertain) {
      this.fail(
        { ...state, checkpointInFlight: false },
        "unknown",
        "Checkpoint provider outcome is unknown; destructive follow-up remains held."
      );
      return;
    }
    this.deps.store.write({ ...state, checkpointInFlight: false });
    if (state.phase === "draining") this.kickAdvance();
    else this.notifyLifecycleChange();
  }

  /** Commit termination ownership before any teardown; emergency capture cannot prove quiescence. */
  async requestShutdown(
    reason: string,
    mode: "graceful" | "emergency" = "graceful"
  ): Promise<"owned" | "held" | "unmanaged"> {
    const row = this.deps.sandbox.getSandbox();
    const state = this.deps.store.read();
    if (state && (!this.current(state) || !this.providerMatches(state))) return "held";
    if (!row?.modal_sandbox_id) return state ? "held" : "unmanaged";
    const emergency = mode === "emergency";
    const recovering = state?.restoreInvoked === true || state?.phase === "restoring";
    if (state && state.phase !== "running" && !(emergency && recovering)) return "held";
    if (!emergency && (!state || state.lifecyclePolicy === "legacy"))
      return state?.checkpointInFlight ? "held" : "unmanaged";
    if (emergency && state?.checkpointInFlight) return "held";
    if (emergency && !recovering && row.status !== "ready") return "unmanaged";
    // A graceful stop reserves the prompt-stop allowance; an emergency cannot
    // obtain runtime preparation and uses only the bounded capture/retire budget.
    const now = this.now();
    const end = emergency
      ? Math.min(state?.expiresAtMs ?? Infinity, now + CAPTURE_MS + RETIRE_MS + MARGIN_MS)
      : (state!.expiresAtMs ?? now + STOP_MS + CAPTURE_MS + RETIRE_MS + MARGIN_MS);
    const stopByMs = emergency ? now : Math.min(now + STOP_MS, end - RETIRE_MS - MARGIN_MS);
    const next: ShutdownRecord = {
      ...(state ?? legacyShutdownRecord(row, this.deps.provider.name)),
      providerObjectId: emergency ? row.modal_object_id : state!.providerObjectId,
      sourceRetired: emergency && !recovering ? false : state?.sourceRetired,
      phase: emergency ? (recovering ? "unknown" : "capturing") : "draining",
      error:
        emergency && recovering
          ? "The runtime failed during recovery; the provider startup outcome is unknown."
          : undefined,
      reason,
      operationId: crypto.randomUUID(),
      stopByMs,
      captureByMs: Math.min(stopByMs + CAPTURE_MS, end - RETIRE_MS - MARGIN_MS),
      retireByMs: end - MARGIN_MS,
      continuationPaused: emergency || state?.continuationPaused,
    };
    const failure = this.deps.session.transaction(() => {
      const message = this.deps.messages.getProcessingMessage();
      if (message) {
        next.messageId = message.id;
        next.continuationPaused = true;
      }
      this.deps.store.write(next);
      if (emergency) this.deps.sandbox.updateSandboxStatus("stale");
      return message
        ? this.deps.failures.record(
            message.id,
            INTERRUPTION_MESSAGES[reason] ?? "The sandbox was stopped.",
            now,
            "processing"
          )
        : null;
    });
    this.announce(next);
    if (failure) this.deps.failures.deliver(failure);
    this.broadcast({ type: "processing_status", isProcessing: false });
    this.deps.background.submit(() => this.deps.reconcileStatusFromMessages(), {
      name: "sandbox.preservation_status",
    });
    if (emergency) {
      this.broadcast({ type: "sandbox_status", status: "stale" });
      this.deps.retireAccess();
      if (!recovering) await this.capture(next);
      return recovering ? "held" : "owned";
    }
    await this.advance();
    return "owned";
  }

  prepared(event: Extract<SandboxEvent, { type: "preservation_prepared" }>): void {
    const state = this.deps.store.read();
    if (
      !state ||
      !this.current(state) ||
      !this.matches(state, event.generation) ||
      state.operationId !== event.operationId ||
      state.phase !== "draining"
    )
      return;
    if (!event.executionStopped || this.now() > state.stopByMs!) {
      const detail = event.error ?? "execution_stop_late";
      this.deps.background.submit(() => this.captureUnconfirmed(state, detail), {
        name: "sandbox.preservation_advance",
      });
      return;
    }
    this.publish({ ...state, phase: "prepared" }); // Durable evidence before the critical-event ACK.
    this.kickAdvance();
  }

  /**
   * The runtime did not confirm that execution stopped, because it is
   * unresponsive or could not stop its work. Holding the session would
   * preserve nothing, so the source is captured without it. The capture
   * cannot prove quiescence, so queued work waits for the user.
   */
  private async captureUnconfirmed(state: ShutdownRecord, detail: string): Promise<void> {
    if (!this.owns(state)) return;
    if (state.checkpointInFlight) {
      // A live checkpoint re-drives the drain when it ends. One whose result
      // was lost to a restart may still be running at the provider, so no
      // capture may race it.
      if (!this.checkpointOperationId)
        this.fail(state, "unknown", "An earlier checkpoint has an unknown result.");
      return;
    }
    this.deps.log?.warn("Runtime did not confirm shutdown; capturing without it", {
      event: "sandbox.preservation_unconfirmed",
      operation_id: state.operationId,
      reason: state.reason,
      detail,
    });
    this.fenceRuntime();
    await this.capture({ ...state, continuationPaused: true });
  }

  /** A capture without runtime cooperation first cuts the runtime off from new work. */
  private fenceRuntime(): void {
    const row = this.deps.sandbox.getSandbox();
    if (row && !isDeadSandboxStatus(row.status)) {
      this.deps.sandbox.updateSandboxStatus("stale");
      this.broadcast({ type: "sandbox_status", status: "stale" });
    }
    this.deps.retireAccess();
  }

  /** Runs before generic watchdogs, and reasserts the absolute deadline on every alarm. */
  async handleAlarm(): Promise<"continue" | "hold_watchdogs"> {
    const state = this.normalizeInterruptedRestore();
    if (!state) return "continue";
    if (state.phase === "running") {
      if (state.checkpointInFlight && !this.checkpointOperationId) {
        this.fail(state, "unknown", "Checkpoint result was lost during a control-plane restart.");
        return "hold_watchdogs";
      }
      if (state.drainAtMs !== null) {
        if (this.now() >= state.drainAtMs) await this.requestShutdown("sandbox_lifetime_expiring");
        else await this.deps.alarm.schedule(state.drainAtMs);
      }
      return this.isHolding() ? "hold_watchdogs" : "continue";
    }
    if (state.phase === "saved")
      return this.continuationPaused(state) ? "hold_watchdogs" : "continue";
    await this.advance();
    return "hold_watchdogs";
  }

  private async advance(): Promise<void> {
    const state = this.deps.store.read();
    if (!state || !this.current(state) || !state.operationId) return;
    if (!this.providerMatches(state)) return;
    if (state.phase === "draining") {
      if (this.now() >= state.stopByMs!) {
        await this.captureUnconfirmed(state, "stop_deadline_exceeded");
        return;
      }
      await this.deps.alarm.schedule(state.stopByMs!);
      if (state.checkpointInFlight) {
        if (!this.checkpointOperationId)
          this.fail(state, "unknown", "An earlier checkpoint has an unknown result.");
        return;
      }
      if (!state.generationReady || state.protocolVersion !== 1) return;
      const socket = this.deps.sockets.getSandboxSocket();
      if (socket)
        this.deps.sockets.send(socket, {
          type: "prepare_preservation",
          operationId: state.operationId,
          generation: state.generation,
          messageId: state.messageId,
          stopByMs: state.stopByMs!,
        });
      return;
    }
    if (state.phase === "capturing") {
      if (this.activeOperation !== state.operationId)
        this.fail(
          state,
          "unknown",
          "The save was interrupted by a control-plane restart; its result is unknown."
        );
      return;
    }
    if (state.phase === "prepared") await this.capture(state);
    else if (state.phase === "retiring") await this.retire(state);
  }

  private normalizeInterruptedRestore(): ShutdownRecord | null {
    const state = this.deps.store.read();
    if (
      (state?.phase !== "restoring" && state?.phase !== "running") ||
      !state.restoreInvoked ||
      (this.activeRestoreGeneration && this.matches(state, this.activeRestoreGeneration)) ||
      !this.current(state)
    )
      return state;
    const row = this.deps.sandbox.getSandbox();
    const unknown: ShutdownRecord = {
      ...state,
      phase: "unknown",
      providerObjectId: row?.modal_object_id ?? state.providerObjectId,
      error:
        "Saved sandbox restore was interrupted after provider invocation; its outcome is unknown.",
    };
    this.publish(unknown);
    return unknown;
  }

  private async capture(state: ShutdownRecord): Promise<void> {
    const { provider } = this.deps;
    if (!state.providerObjectId || this.now() >= state.captureByMs!) {
      this.fail(state, "failed", "No time or provider handle remained to save the sandbox.");
      return;
    }
    this.activeOperation = state.operationId!;
    const capturing = { ...state, phase: "capturing" as const };
    this.publish(capturing);
    await this.deps.alarm.schedule(state.captureByMs!);
    try {
      const retained =
        !!provider.capabilities.supportsPersistentResume &&
        !provider.capabilities.supportsSnapshots;
      const session = this.deps.session.getSession()!;
      const common = {
        providerObjectId: state.providerObjectId,
        sessionId: session.session_name || session.id,
        reason: state.reason!,
        deadlineAtMs: state.captureByMs!,
      };
      let artifactId = state.providerObjectId;
      let sourceStopped = retained;
      let sourceObjectId: string | undefined;
      if (retained) {
        if (!provider.stopSandbox) throw new Error("Provider cannot preserve-stop this sandbox");
        const result = await this.bounded(state.captureByMs!, (signal) =>
          provider.stopSandbox!({ ...common, intent: "preserve", signal })
        );
        if (!result.success)
          throw new Error(result.error ?? "Provider did not confirm graceful shutdown");
      } else {
        const result = await this.captureSnapshot(
          state.providerObjectId,
          common.sessionId,
          state.reason!,
          state.captureByMs!
        );
        artifactId = result.imageId;
        sourceStopped = result.sourceStopped;
        sourceObjectId = result.sourceObjectId;
      }
      if (!this.owns(capturing)) return;
      const retiring = this.commitCaptureReceipt(
        capturing,
        artifactId,
        retained ? "retained" : "snapshot",
        sourceObjectId
      );
      if (sourceStopped) this.finish(retiring);
      else await this.retire(retiring);
    } catch (error) {
      if (this.owns(capturing))
        this.fail(
          capturing,
          "unknown",
          error instanceof ShutdownDeadlineError
            ? "The save did not finish before its deadline; its result is unknown."
            : "The provider did not confirm the save. The previous recovery point is unchanged."
        );
    } finally {
      this.activeOperation = null;
    }
  }

  private commitCaptureReceipt(
    state: ShutdownRecord,
    artifactId: string,
    kind: "retained" | "snapshot",
    sourceObjectId?: string
  ): ShutdownRecord {
    const receipt = {
      kind,
      artifactId,
      ...(sourceObjectId ? { sourceObjectId } : {}),
      provider: this.deps.provider.name,
      savedAtMs: this.now(),
      runtimeVersion: this.deps.sandbox.getSandbox()?.runtime_version ?? null,
    };
    const retiring: ShutdownRecord = {
      ...state,
      phase: "retiring",
      error: undefined,
      receipt,
      savedAtMs: receipt.savedAtMs,
    };
    // Receipt and legacy projection describe the same capture. Either both
    // commit for this generation or neither may authorize source retirement.
    this.deps.session.transaction(() => {
      if (!this.owns(state)) throw new Error("Snapshot generation was superseded");
      if (
        kind === "snapshot" &&
        !this.deps.sandbox.recordSandboxSnapshot(
          state.generation.sandboxId,
          artifactId,
          receipt.runtimeVersion
        )
      )
        throw new Error("Snapshot generation was superseded");
      this.deps.store.write(retiring);
    });
    this.announce(retiring);
    return retiring;
  }

  private async retire(state: ShutdownRecord): Promise<void> {
    if (this.retiringOperation === state.operationId) return;
    if (!state.receipt || !state.providerObjectId) return;
    if (this.now() >= state.retireByMs!) {
      this.fail(state, "unknown", "Recovery point saved, but source retirement was not confirmed.");
      return;
    }
    this.retiringOperation = state.operationId!;
    try {
      await this.deps.alarm.schedule(Math.min(state.retireByMs!, this.now() + RETIRE_MS));
      // A receipt carried from an earlier generation names that generation's
      // source; the one to stop is the source this generation is running.
      await this.stopSource(
        state,
        this.receiptCoversSource(state)
          ? (state.receipt.sourceObjectId ?? state.providerObjectId)
          : state.providerObjectId,
        state.reason!,
        state.receipt.kind === "snapshot" ? "destroy" : "preserve",
        state.retireByMs!
      );
      if (this.owns(state)) this.finish(state);
    } catch {
      if (this.owns(state))
        this.fail(
          state,
          "unknown",
          "A recovery point is saved, but source retirement could not be confirmed."
        );
    } finally {
      this.retiringOperation = null;
    }
  }

  private finish(state: ShutdownRecord): void {
    this.deps.sandbox.updateSandboxStatus("stopped");
    this.deps.retireAccess();
    this.publish({ ...state, phase: "saved", sourceRetired: true });
    this.broadcast({ type: "sandbox_status", status: "stopped" });
    this.notifyLifecycleChange();
  }

  private fail(state: ShutdownRecord, phase: "failed" | "unknown", error: string): void {
    this.publish({ ...state, phase, error });
    this.broadcast({
      type: "sandbox_warning",
      message: `${phase === "failed" ? "Sandbox save failed" : "Sandbox save could not be confirmed"}: ${error}`,
    });
  }

  /** Confirmed provider stop of one source, bounded by the caller's deadline. */
  private async stopSource(
    state: ShutdownRecord,
    providerObjectId: string,
    reason: string,
    intent: "destroy" | "preserve",
    retireByMs: number
  ): Promise<void> {
    if (!this.deps.provider.stopSandbox)
      throw new Error("Provider cannot confirm source retirement");
    const session = this.deps.session.getSession()!;
    const deadlineAtMs = Math.min(retireByMs, this.now() + RETIRE_MS);
    const result = await this.bounded(deadlineAtMs, (signal) =>
      this.deps.provider.stopSandbox!({
        providerObjectId,
        sessionId: session.session_name || session.id,
        reason,
        intent,
        deadlineAtMs,
        signal,
        generationCreatedAtMs: state.generation.createdAt,
      })
    );
    if (!result.success) throw new Error(result.error ?? "Source retirement failed");
  }

  private owns(state: ShutdownRecord): boolean {
    const current = this.deps.store.read();
    return (
      this.current(state) &&
      current !== null &&
      current.operationId === state.operationId &&
      current.phase === state.phase
    );
  }

  private matches(state: ShutdownRecord, generation: SandboxGeneration): boolean {
    return (
      state.generation.sandboxId === generation.sandboxId &&
      state.generation.createdAt === generation.createdAt
    );
  }

  private providerMatches(state: ShutdownRecord): boolean {
    if (!state.provider || state.provider === this.deps.provider.name) return true;
    if (state.phase !== "unknown")
      this.fail(
        state,
        "unknown",
        "The sandbox provider changed; its existing source cannot be preserved through a different provider."
      );
    return false;
  }

  /** Old interrupted records lacked the explicit flag but retained the message marker. */
  private continuationPaused(state: ShutdownRecord): boolean {
    return state.continuationPaused ?? state.messageId !== undefined;
  }

  private notifyLifecycleChange(): void {
    this.deps.background.submit(() => this.deps.onLifecycleChange(), {
      name: "sandbox.lifecycle_change",
    });
  }

  private kickAdvance(): void {
    this.deps.background.submit(() => this.advance(), { name: "sandbox.preservation_advance" });
  }

  private async bounded<T>(
    deadline: number,
    operation: (signal: AbortSignal) => Promise<T>
  ): Promise<T> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => {
          controller.abort();
          reject(
            new ShutdownDeadlineError(
              "Provider graceful shutdown deadline exceeded; result unknown"
            )
          );
        },
        Math.max(0, deadline - this.now())
      );
    });
    try {
      return await Promise.race([operation(controller.signal), timeout]);
    } finally {
      clearTimeout(timer!);
    }
  }

  /** Shared snapshot invocation and conservative classification for checkpoint and shutdown. */
  private async captureSnapshot(
    providerObjectId: string,
    sessionId: string,
    reason: string,
    deadlineAtMs: number
  ): Promise<{ imageId: string; sourceStopped: boolean; sourceObjectId?: string }> {
    if (!this.deps.provider.takeSnapshot) throw new Error("Provider has no snapshot operation");
    const result = await this.bounded(deadlineAtMs, (signal) =>
      this.deps.provider.takeSnapshot!({
        providerObjectId,
        sessionId,
        reason,
        deadlineAtMs,
        signal,
      })
    );
    if (!result.success || !result.imageId)
      throw new Error(result.error ?? "Provider snapshot result is unknown");
    return {
      imageId: result.imageId,
      sourceStopped: result.sourceStopped === true,
      sourceObjectId: result.sourceObjectId,
    };
  }
}
