import { DEFAULT_FINAL_SNAPSHOT_BUFFER_MS } from "@open-inspect/shared/types/integrations";
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
import type { SandboxShutdownStorage } from "./sandbox-ports";
import type { SessionCoreRepository } from "./session-core-repository";
import type { MessageRepository } from "./message-repository";
import type { MessageFailureService } from "./message-failure-service";
import type { SessionMessenger } from "./messenger";
import type { SessionWebSocketManager } from "./websocket-manager";
import type {
  CheckpointOperation,
  ShutdownRecord,
  ShutdownStore,
} from "./sandbox-shutdown-repository";

const STOP_MS = 60_000;
const CAPTURE_MS = 300_000;
const RETIRE_MS = 30_000;
const MARGIN_MS = 30_000;

class ShutdownDeadlineError extends Error {}

export interface ShutdownDependencies {
  store: ShutdownStore;
  provider: SandboxProvider;
  sandbox: SandboxShutdownStorage;
  session: Pick<SessionCoreRepository, "getSession" | "transaction">;
  messages: Pick<MessageRepository, "getProcessingMessage">;
  failures: Pick<MessageFailureService, "record" | "deliver">;
  messenger: Pick<SessionMessenger, "broadcast">;
  sockets: Pick<SessionWebSocketManager, "getSandboxSocket" | "send">;
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
  private checkpointOperation: string | null = null;
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
    this.deps.messenger.broadcast({
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
    this.publish({
      ...state,
      restoreInvoked: true,
      sourceRetired: false,
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
    if (!state) return this.legacyCheckpointRow() ? "held" : "unmanaged";
    if (state.phase === "saved" && this.continuationPaused(state)) return "held";
    if (state.phase === "saved") return "restore_required";
    if (state.phase === "restoring" && !state.restoreInvoked) return "restore_required";
    if (state.phase !== "running" || !this.current(state)) return "held";
    if (!this.providerMatches(state)) return "held";
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
    return state.lifetimeKind !== "unknown" && state.generationReady ? "ready" : "held";
  }

  isHolding(): boolean {
    const state = this.normalizeInterruptedRestore();
    if (!state) return this.legacyCheckpointRow();
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
    if (!state)
      return this.legacyCheckpointRow()
        ? { kind: "hold", reason: "Legacy checkpoint ownership is unknown" }
        : { kind: "normal" };
    if (this.unresolvedCheckpoint(state) || state.checkpointInFlight)
      return { kind: "hold", reason: "A checkpoint still owns the source sandbox" };
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
    if (!state || !this.current(state) || (generation && !this.matches(state, generation))) return;
    if (state.receipt)
      this.fail(
        { ...state, sourceRetired: state.sourceRetired || state.phase === "saved" },
        "unknown",
        `Saved sandbox could not be restored: ${error}. No fresh sandbox was substituted.`
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
      !this.unresolvedCheckpoint(state) &&
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
    const provider = this.deps.provider;
    if (this.checkpointOperation || generation.sandboxId === null)
      return { outcome: "held", reason: "capture_owned" };
    if (provider.capabilities.snapshotStopsSandbox === true) {
      await this.requestShutdown(reason);
      return { outcome: "held", reason: "final_shutdown_requested" };
    }
    if (!provider.takeSnapshot || provider.capabilities.snapshotStopsSandbox !== false)
      return { outcome: "held", reason: "non_destructive_capture_not_supported" };
    const state = this.deps.store.read();
    if (!state) return { outcome: "held", reason: "capture_owner_unavailable" };
    if (
      state.phase !== "running" ||
      this.admissionDecision() !== "ready" ||
      !this.matches(state, generation) ||
      this.unresolvedCheckpoint(state) ||
      state.checkpointInFlight
    )
      return { outcome: "held", reason: "shutdown_held" };
    const now = this.now();
    if (state.drainAtMs !== null && now + CAPTURE_MS + MARGIN_MS > state.drainAtMs)
      return { outcome: "held", reason: "insufficient_capture_headroom" };
    const row = this.deps.sandbox.getSandbox();
    const session = this.deps.session.getSession();
    if (
      !row?.modal_object_id ||
      !session ||
      (row.status !== "ready" && !(row.status === "stale" && reason === "heartbeat_timeout"))
    )
      return { outcome: "held", reason: "sandbox_not_ready" };
    const startedAtMs = now;
    const operation: CheckpointOperation = {
      version: 1,
      operationId: crypto.randomUUID(),
      generation: state.generation,
      provider: provider.name,
      providerObjectId: row.modal_object_id,
      runtimeVersion: row.runtime_version,
      reason,
      startedAtMs,
      deadlineAtMs: Math.min(startedAtMs + CAPTURE_MS, state.expiresAtMs ?? Infinity),
      nonDestructive: true,
      phase: "capturing",
    };
    this.deps.store.write({ ...state, checkpoint: operation });
    this.checkpointOperation = operation.operationId;
    let captureStarted = false;
    try {
      await this.deps.alarm.schedule(operation.deadlineAtMs);
      if (!this.ownsCheckpoint(operation)) return { outcome: "held", reason: "superseded" };
      if (this.now() >= operation.deadlineAtMs) {
        this.deps.store.write({ ...this.deps.store.read()!, checkpoint: state.checkpoint });
        return { outcome: "failed", reason: "checkpoint_deadline_elapsed_before_capture" };
      }
      captureStarted = true;
      const result = await this.bounded(operation.deadlineAtMs, (signal) =>
        provider.takeSnapshot!({
          providerObjectId: operation.providerObjectId,
          sessionId: session.session_name || session.id,
          reason,
          deadlineAtMs: operation.deadlineAtMs,
          signal,
        })
      );
      if (!this.ownsCheckpoint(operation)) return { outcome: "held", reason: "superseded" };
      if (this.now() >= operation.deadlineAtMs) throw new ShutdownDeadlineError();
      if (result.sourceStopped) {
        const current = this.deps.store.read()!;
        const error = "Provider stopped the source during a non-destructive checkpoint.";
        this.fail(
          { ...current, checkpoint: { ...operation, phase: "unknown", error } },
          "unknown",
          error
        );
        return { outcome: "unknown", operationId: operation.operationId, reason: error };
      }
      if (!result.success || !result.imageId)
        throw new Error("Provider did not confirm a non-destructive checkpoint");
      const current = this.deps.store.read()!;
      const savedAtMs = this.now();
      this.deps.session.transaction(() => {
        if (
          !this.deps.sandbox.recordSandboxSnapshot(
            operation.generation.sandboxId,
            result.imageId!,
            operation.runtimeVersion
          )
        )
          throw new Error("Checkpoint generation was not recorded");
        this.deps.store.write({
          ...current,
          checkpoint: { ...operation, phase: "completed", imageId: result.imageId!, savedAtMs },
        });
      });
      this.deps.messenger.broadcast({ type: "snapshot_saved", imageId: result.imageId, reason });
      return { outcome: "saved", operationId: operation.operationId, imageId: result.imageId };
    } catch {
      const current = this.deps.store.read();
      const completed = current?.checkpoint;
      if (completed?.operationId === operation.operationId && completed.phase === "completed")
        return {
          outcome: "saved",
          operationId: operation.operationId,
          imageId: completed.imageId,
        };
      if (!this.ownsCheckpoint(operation)) return { outcome: "held", reason: "superseded" };
      if (!captureStarted) {
        this.deps.store.write({ ...current!, checkpoint: state.checkpoint });
        return { outcome: "failed", reason: "checkpoint_deadline_could_not_be_armed" };
      }
      const error = "Checkpoint result is unknown; capture will not be repeated automatically.";
      this.deps.store.write({
        ...current!,
        checkpoint: { ...operation, phase: "unknown", error },
      });
      return { outcome: "unknown", operationId: operation.operationId, reason: error };
    } finally {
      if (this.checkpointOperation === operation.operationId) this.checkpointOperation = null;
      if (this.deps.store.read()?.phase === "waiting_for_checkpoint") this.kickAdvance();
    }
  }

  private ownsCheckpoint(operation: CheckpointOperation): boolean {
    const state = this.deps.store.read();
    const row = this.deps.sandbox.getSandbox();
    return (
      !!state &&
      this.current(state) &&
      state.checkpoint?.operationId === operation.operationId &&
      state.checkpoint.phase === "capturing" &&
      state.generation.sandboxId === operation.generation.sandboxId &&
      state.generation.createdAt === operation.generation.createdAt &&
      row?.modal_object_id === operation.providerObjectId &&
      state.providerObjectId === operation.providerObjectId &&
      this.deps.provider.name === operation.provider
    );
  }

  /** Heartbeat recovery may retire its own checkpoint, never a final owner's source. */
  async retireHeartbeatCheckpoint(operationId: string): Promise<boolean> {
    const state = this.deps.store.read();
    const checkpoint = state?.checkpoint;
    if (
      !state ||
      state.phase !== "running" ||
      !this.current(state) ||
      checkpoint?.phase !== "completed" ||
      checkpoint.operationId !== operationId ||
      checkpoint.reason !== "heartbeat_timeout" ||
      checkpoint.provider !== this.deps.provider.name ||
      this.deps.sandbox.getSandbox()?.modal_object_id !== checkpoint.providerObjectId
    )
      return false;
    const retiring: ShutdownRecord = {
      ...state,
      phase: "retiring",
      operationId,
      reason: "heartbeat_timeout",
      retireByMs: Math.min(this.now() + RETIRE_MS, state.expiresAtMs ?? Infinity),
      receipt: {
        kind: "snapshot",
        artifactId: checkpoint.imageId,
        provider: checkpoint.provider,
        savedAtMs: checkpoint.savedAtMs,
        runtimeVersion: checkpoint.runtimeVersion,
      },
      savedAtMs: checkpoint.savedAtMs,
    };
    this.publish(retiring);
    await this.retire(retiring);
    return true;
  }

  async requestShutdown(reason: string): Promise<"owned" | "unmanaged" | "held"> {
    const state = this.deps.store.read();
    if (!state) return "unmanaged";
    if (!this.current(state) || state.phase !== "running" || !this.providerMatches(state))
      return "held";
    if (state.lifecyclePolicy === "legacy") {
      return state.checkpointInFlight || this.unresolvedCheckpoint(state) ? "held" : "unmanaged";
    }
    const now = this.now();
    const waiting = this.unresolvedCheckpoint(state) || !!state.checkpointInFlight;
    const waitEnd = waiting ? Math.max(now, state.checkpoint?.deadlineAtMs ?? now) : now;
    const end = state.expiresAtMs ?? waitEnd + STOP_MS + CAPTURE_MS + RETIRE_MS + MARGIN_MS;
    const retireByMs = end - MARGIN_MS;
    const next: ShutdownRecord = {
      ...state,
      phase: waiting ? "waiting_for_checkpoint" : "draining",
      reason,
      operationId: crypto.randomUUID(),
      ...(waiting
        ? {
            waitByMs: Math.min(waitEnd, retireByMs - RETIRE_MS - STOP_MS),
            stopByMs: undefined,
            captureByMs: undefined,
          }
        : this.preparationBudget(now, retireByMs)),
      retireByMs,
    };
    const failure = this.deps.session.transaction(() => {
      const message = this.deps.messages.getProcessingMessage();
      if (message) {
        next.messageId = message.id;
        next.continuationPaused = true;
      }
      this.deps.store.write(next); // Fence before any asynchronous work or terminal publication.
      return message ? this.deps.failures.record(message.id, reason, now, "processing") : null;
    });
    this.publish(next);
    if (failure) this.deps.failures.deliver(failure);
    this.deps.messenger.broadcast({ type: "sandbox_access_changed" });
    this.deps.messenger.broadcast({ type: "processing_status", isProcessing: false });
    this.deps.background.submit(() => this.deps.reconcileStatusFromMessages(), {
      name: "sandbox.preservation_status",
    });
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
      this.unresolvedCheckpoint(state) ||
      state.checkpointInFlight ||
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
    let state = this.normalizeInterruptedRestore();
    if (!state) {
      const row = this.deps.sandbox.getSandbox();
      if (row?.status !== "snapshotting" || !row.modal_sandbox_id) return "continue";
      state = {
        phase: "unknown",
        generation: { sandboxId: row.modal_sandbox_id, createdAt: row.created_at },
        provider: this.deps.provider.name,
        providerObjectId: row.modal_object_id,
        sourceRetired: false,
        lifetimeKind: "unknown",
        expiresAtMs: null,
        drainAtMs: null,
        generationReady: false,
        lifecyclePolicy: "legacy",
        reason: "legacy_checkpoint",
        error: "Legacy checkpoint ownership is unknown.",
      };
      this.publish(state);
      return "hold_watchdogs";
    }
    if (state.phase === "running") {
      if (
        state.checkpoint?.phase === "capturing" &&
        (this.checkpointOperation !== state.checkpoint.operationId ||
          this.now() >= state.checkpoint.deadlineAtMs)
      )
        this.deps.store.write({
          ...state,
          checkpoint: {
            ...state.checkpoint,
            phase: "unknown",
            error: "Checkpoint result was lost or exceeded its deadline.",
          },
        });
      else if (state.checkpoint?.phase === "capturing")
        await this.deps.alarm.schedule(state.checkpoint.deadlineAtMs);
      if (state.checkpointInFlight) {
        this.fail(state, "unknown", "Legacy checkpoint ownership is unknown.");
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
    let state = this.deps.store.read();
    if (!state || !this.current(state) || !state.operationId) return;
    if (!this.providerMatches(state)) return;
    if (state.phase === "waiting_for_checkpoint") {
      if (this.unresolvedCheckpoint(state) || state.checkpointInFlight) {
        if (
          state.checkpoint?.phase !== "capturing" ||
          this.checkpointOperation !== state.checkpoint.operationId ||
          this.now() >= state.waitByMs!
        ) {
          this.fail(
            state,
            "unknown",
            "An earlier checkpoint has an unknown result or exceeded the final wait deadline."
          );
          return;
        }
        await this.deps.alarm.schedule(state.waitByMs!);
        if (!this.owns(state)) return;
        state = this.deps.store.read()!;
        if (this.unresolvedCheckpoint(state)) return;
      }
      if (this.now() >= state.waitByMs!) {
        this.fail(
          state,
          "failed",
          "No preparation budget remains after waiting for the checkpoint."
        );
        return;
      }
      state = {
        ...state,
        phase: "draining",
        ...this.preparationBudget(this.now(), state.retireByMs!),
      };
      this.publish(state);
    }
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
      state?.phase !== "restoring" ||
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
    const runtimeVersion = this.deps.sandbox.getSandbox()?.runtime_version ?? null;
    const capturing = { ...state, phase: "capturing" as const };
    this.publish(capturing);
    let providerInvoked = false;
    try {
      await this.deps.alarm.schedule(state.captureByMs!);
      if (!this.owns(capturing)) return;
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
        const result = await this.bounded(state.captureByMs!, (signal) => {
          providerInvoked = true;
          return provider.stopSandbox!({ ...common, intent: "preserve", signal });
        });
        if (!result.success)
          throw new Error(result.error ?? "Provider did not confirm graceful shutdown");
      } else {
        if (!provider.takeSnapshot) throw new Error("Provider has no snapshot operation");
        const result = await this.bounded(state.captureByMs!, (signal) => {
          providerInvoked = true;
          return provider.takeSnapshot!({ ...common, signal });
        });
        if (!result.success || !result.imageId)
          throw new Error(result.error ?? "Provider did not return a ready snapshot");
        artifactId = result.imageId;
        sourceStopped = result.sourceStopped === true;
      }
      if (!this.owns(capturing)) return;
      if (this.now() >= state.captureByMs!) throw new ShutdownDeadlineError();
      const receipt = {
        kind: retained ? ("retained" as const) : ("snapshot" as const),
        artifactId,
        provider: provider.name,
        savedAtMs: this.now(),
        runtimeVersion,
      };
      const retiring: ShutdownRecord = {
        ...capturing,
        phase: "retiring",
        receipt,
        savedAtMs: receipt.savedAtMs,
      };
      this.publish(retiring); // Commit recovery locator BEFORE separately retiring the source.
      if (!retained)
        this.deps.sandbox.recordSandboxSnapshot(
          state.generation.sandboxId,
          artifactId,
          receipt.runtimeVersion
        );
      if (sourceStopped) this.finish(retiring);
      else await this.retire(retiring);
    } catch (error) {
      if (this.owns(capturing))
        this.fail(
          capturing,
          providerInvoked ? "unknown" : "failed",
          !providerInvoked
            ? "Final graceful shutdown failed before provider invocation and can be retried."
            : error instanceof ShutdownDeadlineError
              ? "Provider graceful shutdown deadline exceeded; result unknown."
              : "The provider did not confirm final graceful shutdown. The previous recovery point is unchanged."
        );
    } finally {
      this.activeOperation = null;
    }
  }

  private preparationBudget(now: number, retireByMs: number) {
    const stopByMs = Math.min(now + STOP_MS, retireByMs - RETIRE_MS);
    return { stopByMs, captureByMs: Math.min(stopByMs + CAPTURE_MS, retireByMs - RETIRE_MS) };
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
    this.publish({ ...state, phase: "saved", sourceRetired: true, checkpointInFlight: undefined });
    this.deps.messenger.broadcast({ type: "sandbox_status", status: "stopped" });
    this.notifyLifecycleChange();
  }

  private fail(state: ShutdownRecord, phase: "failed" | "unknown", error: string): void {
    this.publish({ ...state, phase, error });
    this.deps.messenger.broadcast({
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

  private unresolvedCheckpoint(state: ShutdownRecord | null): boolean {
    return state?.checkpoint?.phase === "capturing" || state?.checkpoint?.phase === "unknown";
  }

  private legacyCheckpointRow(): boolean {
    return this.deps.sandbox.getSandbox()?.status === "snapshotting";
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
    if (this.now() >= deadline) throw new ShutdownDeadlineError();
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
}
