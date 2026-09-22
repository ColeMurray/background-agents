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
  private activeRestoreGeneration: SandboxGeneration | null = null;
  private readonly now: () => number;

  constructor(private readonly deps: ShutdownDependencies) {
    this.now = deps.now ?? Date.now;
  }

  snapshot(): SandboxShutdownState | null {
    const state = this.normalizeInterruptedRestore();
    return state
      ? sandboxShutdownSchema.parse({
          ...state,
          savedAtMs: state.receipt?.savedAtMs ?? state.savedAtMs,
          hasRecoveryPoint: !!state.receipt,
          continuationPaused: this.continuationPaused(state),
          availableRecoveryActions: this.availableRecoveryActions(state),
        })
      : null;
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
      provider: this.deps.provider.name,
      sandbox_id: state.generation.sandboxId,
      generation_created_at: state.generation.createdAt,
      operation_id: state.operationId,
      expires_at_ms: state.expiresAtMs,
    });
    this.broadcast({
      type: "sandbox_preservation",
      preservation: sandboxShutdownSchema.parse({
        ...state,
        savedAtMs: state.receipt?.savedAtMs ?? state.savedAtMs,
        hasRecoveryPoint: !!state.receipt,
        continuationPaused: this.continuationPaused(state),
        availableRecoveryActions: this.availableRecoveryActions(state),
      }),
    });
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
    const expiresAtMs = lifetime.kind === "finite" ? lifetime.expiresAtMs : null;
    const legacy = state.lifecyclePolicy === "legacy";
    const next: ShutdownRecord = {
      ...state,
      phase: state.phase === "restoring" ? "running" : state.phase,
      restoreInvoked: undefined,
      providerObjectId: row?.modal_object_id ?? null,
      sourceRetired: false,
      lifetimeKind: lifetime.kind,
      lifetimeSource: lifetime.kind === "finite" ? lifetime.source : undefined,
      expiresAtMs,
      drainAtMs: legacy || expiresAtMs === null ? null : expiresAtMs - buffer,
    };
    this.publish(next);
    if (legacy) {
      this.notifyLifecycleChange();
      return;
    }
    if (lifetime.kind === "unknown") {
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
    // A provider-create failure with no connected runtime/receipt still uses
    // the existing fresh-spawn retry policy. Unknown shutdown state never does.
    if (
      !state.runtimeReady &&
      !state.receipt &&
      !state.providerObjectId &&
      this.deps.sandbox.getSandbox()?.status === "failed"
    )
      return "spawn_required";
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
      throw new ShutdownRecoveryRejectedError(
        state?.phase === "unknown" && action === "retry"
          ? "An unknown provider result cannot be retried safely; restore a saved recovery point or start a separate session."
          : undefined
      );
    if (state.phase === "saved" && this.continuationPaused(state)) {
      this.publish({ ...state, continuationPaused: false });
      this.notifyLifecycleChange();
      return;
    }
    if (action === "retry") {
      this.publish({ ...state, phase: "running", error: undefined });
      await this.requestShutdown(state.reason ?? "preservation_retry");
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
      state.sourceRetired ||
      (state.lifetimeSource === "provider" &&
        state.expiresAtMs !== null &&
        this.now() >= state.expiresAtMs)
    ) {
      // The hard provider deadline independently proves the old execution ended.
      this.finish(next);
    } else if (state.providerObjectId) await this.retire(next);
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
    if (state.phase === "failed") {
      const actions: ShutdownRecoveryAction[] = [];
      if (this.canRetryShutdown(state)) actions.push("retry");
      if (this.canRestoreSaved(state)) actions.push("restore_saved");
      return actions;
    }
    if (state.phase === "unknown") return this.canRestoreSaved(state) ? ["restore_saved"] : [];
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
      (!!state.providerObjectId &&
        this.deps.provider.capabilities.supportsExplicitStop === true &&
        !!this.deps.provider.stopSandbox)
    );
  }

  private canRetryShutdown(state: ShutdownRecord): boolean {
    const provider = this.deps.provider;
    const canCapture =
      (provider.capabilities.supportsPersistentResume === true &&
        provider.capabilities.supportsExplicitStop === true &&
        !!provider.stopSandbox) ||
      (provider.capabilities.supportsSnapshots === true && !!provider.takeSnapshot);
    return (
      state.lifecyclePolicy !== "legacy" &&
      state.protocolVersion === 1 &&
      state.generationReady &&
      !state.checkpointInFlight &&
      !!state.providerObjectId &&
      canCapture &&
      (state.expiresAtMs === null || this.now() + RETIRE_MS + MARGIN_MS < state.expiresAtMs)
    );
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
      return message ? this.deps.failures.record(message.id, reason, now, "processing") : null;
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
      this.fail(
        state,
        "failed",
        event.error ?? "Active execution did not stop before the graceful shutdown deadline."
      );
      return;
    }
    this.publish({ ...state, phase: "prepared" }); // Durable evidence before the critical-event ACK.
    this.kickAdvance();
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
        this.fail(
          state,
          "failed",
          "Could not confirm prompt/tool shutdown before the graceful shutdown deadline."
        );
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
          "Graceful shutdown was interrupted; the provider result is unknown. No destructive retry was made."
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
      this.fail(state, "failed", "No time or provider handle remains for a final snapshot.");
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
      }
      if (!this.owns(capturing)) return;
      const receipt = {
        kind: retained ? ("retained" as const) : ("snapshot" as const),
        artifactId,
        provider: provider.name,
        savedAtMs: this.now(),
        runtimeVersion: this.deps.sandbox.getSandbox()?.runtime_version ?? null,
      };
      const retiring: ShutdownRecord = {
        ...capturing,
        phase: "retiring",
        receipt,
        savedAtMs: receipt.savedAtMs,
      };
      // Receipt and legacy projection describe the same capture. Either both
      // commit for this generation or neither may authorize source retirement.
      this.deps.session.transaction(() => {
        if (!this.owns(capturing)) throw new Error("Snapshot generation was superseded");
        if (
          !retained &&
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
      if (sourceStopped) this.finish(retiring);
      else await this.retire(retiring);
    } catch (error) {
      if (this.owns(capturing))
        this.fail(
          capturing,
          "unknown",
          error instanceof ShutdownDeadlineError
            ? "Provider graceful shutdown deadline exceeded; result unknown."
            : "The provider did not confirm final graceful shutdown. The previous recovery point is unchanged."
        );
    } finally {
      this.activeOperation = null;
    }
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
      if (!this.deps.provider.stopSandbox)
        throw new Error("Provider cannot confirm source retirement");
      const session = this.deps.session.getSession()!;
      const deadlineAtMs = Math.min(state.retireByMs!, this.now() + RETIRE_MS);
      await this.deps.alarm.schedule(deadlineAtMs);
      const result = await this.bounded(deadlineAtMs, (signal) =>
        this.deps.provider.stopSandbox!({
          providerObjectId: state.providerObjectId!,
          sessionId: session.session_name || session.id,
          reason: state.reason!,
          intent: state.receipt!.kind === "snapshot" ? "destroy" : "preserve",
          deadlineAtMs,
          signal,
        })
      );
      if (!result.success) throw new Error(result.error ?? "Source retirement failed");
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
      message: `Sandbox graceful shutdown ${phase}: ${error}`,
    });
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
  ): Promise<{ imageId: string; sourceStopped: boolean }> {
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
    return { imageId: result.imageId, sourceStopped: result.sourceStopped === true };
  }
}
