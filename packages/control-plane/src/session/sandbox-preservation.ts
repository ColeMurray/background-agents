import { DEFAULT_FINAL_SNAPSHOT_BUFFER_MS } from "@open-inspect/shared/types/integrations";
import type { SandboxEvent } from "@open-inspect/shared/types/sandbox-events";
import {
  sandboxPreservationSchema,
  type SandboxPreservationState,
} from "@open-inspect/shared/types/sandbox-preservation";
import type { AlarmScheduler, BackgroundTasks } from "../platform-ports";
import type { Logger } from "../logger";
import type { SandboxLifetime, SandboxProvider } from "../sandbox/provider";
import { parsePersistedSandboxSettings } from "../sandbox/settings";
import type { SandboxGeneration } from "../sandbox/lifecycle/manager";
import type { SandboxRepository } from "./sandbox-repository";
import type { SessionCoreRepository } from "./session-core-repository";
import type { MessageRepository } from "./message-repository";
import type { MessageFailureService } from "./message-failure-service";
import type { SessionMessenger } from "./messenger";
import type { SessionWebSocketManager } from "./websocket-manager";
import type { PreservationRecord, PreservationStore } from "./sandbox-preservation-repository";

const STOP_MS = 60_000;
const CAPTURE_MS = 300_000;
const RETIRE_MS = 30_000;
const MARGIN_MS = 30_000;

class PreservationDeadlineError extends Error {}

interface PreservationDeps {
  store: PreservationStore;
  provider: SandboxProvider;
  sandbox: SandboxRepository;
  session: SessionCoreRepository;
  messages: MessageRepository;
  failures: MessageFailureService;
  messenger: SessionMessenger;
  sockets: SessionWebSocketManager;
  alarm: AlarmScheduler;
  background: BackgroundTasks;
  processQueue(): Promise<void>;
  reconcileStatus(): Promise<void>;
  retireAccess(): void;
  now?: () => number;
  log?: Logger;
}

/** One durable owner of planned stopping. Provider side effects never imply a saved receipt. */
export class SandboxPreservation {
  private activeOperation: string | null = null;
  private checkpointActive = false;
  private checkpointGeneration: SandboxGeneration | null = null;
  private retiringOperation: string | null = null;
  private readonly now: () => number;

  constructor(private readonly deps: PreservationDeps) {
    this.now = deps.now ?? Date.now;
  }

  snapshot(): SandboxPreservationState | null {
    const state = this.deps.store.read();
    return state
      ? sandboxPreservationSchema.parse({
          ...state,
          savedAtMs: state.receipt?.savedAtMs ?? state.savedAtMs,
          hasRecoveryPoint: !!state.receipt,
        })
      : null;
  }

  private current(state: PreservationRecord): boolean {
    const row = this.deps.sandbox.getSandbox();
    return (
      row?.modal_sandbox_id === state.generation.sandboxId &&
      row.created_at === state.generation.createdAt
    );
  }

  private publish(state: PreservationRecord): void {
    this.deps.store.write(state);
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
      preservation: sandboxPreservationSchema.parse({
        ...state,
        savedAtMs: state.receipt?.savedAtMs ?? state.savedAtMs,
        hasRecoveryPoint: !!state.receipt,
      }),
    });
  }

  /** Called before the provider can start a bridge for this generation. */
  beginGeneration(generation: SandboxGeneration): void {
    if (!generation.sandboxId) throw new Error("Missing sandbox generation");
    const previous = this.deps.store.read();
    this.publish({
      phase: "running",
      generation: { ...generation, sandboxId: generation.sandboxId },
      provider: this.deps.provider.name,
      providerObjectId: this.deps.sandbox.getSandbox()?.modal_object_id ?? null,
      lifetimeKind: "unknown",
      expiresAtMs: null,
      drainAtMs: null,
      generationReady: false,
      receipt: previous?.receipt,
    });
  }

  async started(generation: SandboxGeneration, lifetime?: SandboxLifetime): Promise<void> {
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
    const expiresAtMs = lifetime?.kind === "finite" ? lifetime.expiresAtMs : null;
    const next: PreservationRecord = {
      ...state,
      providerObjectId: row?.modal_object_id ?? null,
      lifetimeKind: lifetime?.kind ?? "unknown",
      expiresAtMs,
      drainAtMs: expiresAtMs === null ? null : expiresAtMs - buffer,
    };
    this.publish(next);
    if (!lifetime || lifetime.kind === "unknown") {
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
      if (this.now() >= next.drainAtMs) await this.request("sandbox_lifetime_expiring");
      else await this.deps.alarm.schedule(next.drainAtMs);
    }
    this.kickQueue();
  }

  runtimeReady(version?: 1): void {
    const state = this.deps.store.read();
    if (!state || !this.current(state)) return;
    const next = { ...state, runtimeReady: true, protocolVersion: version };
    this.publish(next);
    if (version !== 1) {
      this.fail(
        next,
        "failed",
        "This sandbox runtime does not support confirmed preservation. Upgrade the runtime before resuming work."
      );
      return;
    }
    this.bindGeneration(next);
  }

  private bindGeneration(state: PreservationRecord): void {
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
    else this.kickQueue();
  }

  /** Synchronous admission gate; call again after every dispatch-path await. */
  mayDispatch(): boolean {
    const state = this.deps.store.read();
    if (!state) return true; // Legacy generations retain their existing policy until a new launch.
    if (state.phase === "saved") return true; // Existing queue drives restore, never prompt replay.
    if (state.phase !== "running" || !this.current(state)) return false;
    if (!this.providerMatches(state)) return false;
    // A provider-create failure with no connected runtime/receipt still uses
    // the existing fresh-spawn retry policy. Unknown preservation never does.
    if (
      !state.runtimeReady &&
      !state.receipt &&
      !state.providerObjectId &&
      this.deps.sandbox.getSandbox()?.status === "failed"
    )
      return true;
    if (state.drainAtMs !== null && this.now() >= state.drainAtMs) {
      this.deps.background.submit(() => this.request("sandbox_lifetime_expiring"), {
        name: "sandbox.preserve",
      });
      return false;
    }
    return state.lifetimeKind !== "unknown" && state.generationReady && !state.checkpointInFlight;
  }

  isHolding(): boolean {
    const phase = this.deps.store.read()?.phase;
    return phase !== undefined && phase !== "running" && phase !== "saved";
  }

  recoveryReceipt() {
    const state = this.deps.store.read();
    return state?.phase === "saved" ? state.receipt : undefined;
  }

  restoreFailed(error: string): void {
    const state = this.deps.store.read();
    if (state?.receipt)
      this.fail(
        state,
        "unknown",
        `Saved sandbox could not be restored: ${error}. No fresh sandbox was substituted.`
      );
  }

  /** Only an explicit authenticated user choice may leave a failed/unknown hold. */
  async recover(action: "retry" | "restore_saved"): Promise<void> {
    const state = this.deps.store.read();
    if (!state || (state.phase !== "failed" && state.phase !== "unknown") || !this.current(state))
      return;
    if (action === "retry") {
      // Unknown means provider I/O may still have run; never repeat that capture blindly.
      if (state.phase !== "failed")
        throw new Error(
          "An unknown provider result cannot be retried safely; restore a saved recovery point or start a separate session."
        );
      this.publish({ ...state, phase: "running", error: undefined });
      await this.request(state.reason ?? "preservation_retry");
      return;
    }
    if (!state.receipt || state.receipt.provider !== this.deps.provider.name)
      throw new Error("No saved recovery point for the configured provider is available.");
    const next: PreservationRecord = {
      ...state,
      phase: "retiring",
      reason: "restore_saved_state",
      error: undefined,
      operationId: crypto.randomUUID(),
      retireByMs: this.now() + RETIRE_MS,
    };
    this.publish(next);
    if (state.expiresAtMs !== null && this.now() >= state.expiresAtMs) {
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

  /** Ordinary non-destructive checkpoints share the capture gate. */
  beginCheckpoint(): boolean {
    if (this.checkpointActive) return false;
    const state = this.deps.store.read();
    if (!state) return true;
    if (!this.mayDispatch()) return false;
    this.checkpointActive = true;
    this.checkpointGeneration = state.generation;
    this.deps.store.write({ ...state, checkpointInFlight: true });
    return true;
  }

  endCheckpoint(): void {
    this.checkpointActive = false;
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
    this.deps.store.write({ ...state, checkpointInFlight: false });
    if (state.phase === "draining") this.kickAdvance();
    else this.kickQueue();
  }

  async request(reason: string): Promise<boolean> {
    const state = this.deps.store.read();
    if (!state || !this.current(state) || state.phase !== "running") return false;
    if (!this.providerMatches(state)) return true;
    const now = this.now();
    const end = state.expiresAtMs ?? now + STOP_MS + CAPTURE_MS + RETIRE_MS + MARGIN_MS;
    // A shorter buffer reduces capture time, not the prompt-stop allowance.
    // Always leave room for source retirement and the final safety margin.
    const stopByMs = Math.min(now + STOP_MS, end - RETIRE_MS - MARGIN_MS);
    const next: PreservationRecord = {
      ...state,
      phase: "draining",
      reason,
      operationId: crypto.randomUUID(),
      stopByMs,
      captureByMs: Math.min(stopByMs + CAPTURE_MS, end - RETIRE_MS - MARGIN_MS),
      retireByMs: end - MARGIN_MS,
    };
    const failure = this.deps.session.transaction(() => {
      const message = this.deps.messages.getProcessingMessage();
      if (message) next.messageId = message.id;
      this.deps.store.write(next); // Fence before any asynchronous work or terminal publication.
      return message ? this.deps.failures.record(message.id, reason, now, "processing") : null;
    });
    this.publish(next);
    if (failure) this.deps.failures.deliver(failure);
    this.deps.messenger.broadcast({ type: "processing_status", isProcessing: false });
    this.deps.background.submit(() => this.deps.reconcileStatus(), {
      name: "sandbox.preservation_status",
    });
    await this.advance();
    return true;
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
        event.error ?? "Active execution did not stop before the preservation deadline."
      );
      return;
    }
    this.publish({ ...state, phase: "prepared" }); // Durable evidence before the critical-event ACK.
    this.kickAdvance();
  }

  /** Runs before generic watchdogs, and reasserts the absolute deadline on every alarm. */
  async handleAlarm(): Promise<boolean> {
    const state = this.deps.store.read();
    if (!state) return false;
    if (state.phase === "running") {
      if (state.checkpointInFlight && !this.checkpointActive) {
        this.fail(state, "unknown", "Checkpoint result was lost during a control-plane restart.");
        return true;
      }
      if (state.drainAtMs !== null) {
        if (this.now() >= state.drainAtMs) await this.request("sandbox_lifetime_expiring");
        else await this.deps.alarm.schedule(state.drainAtMs);
      }
      return this.isHolding();
    }
    if (state.phase === "saved") return false;
    await this.advance();
    return true;
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
          "Could not confirm prompt/tool shutdown before the preservation deadline."
        );
        return;
      }
      await this.deps.alarm.schedule(state.stopByMs!);
      if (state.checkpointInFlight) {
        if (!this.checkpointActive)
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
          "Preservation was interrupted; the provider result is unknown. No destructive retry was made."
        );
      return;
    }
    if (state.phase === "prepared") await this.capture(state);
    else if (state.phase === "retiring") await this.retire(state);
  }

  private async capture(state: PreservationRecord): Promise<void> {
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
          throw new Error(result.error ?? "Provider did not confirm preservation");
      } else {
        if (!provider.takeSnapshot) throw new Error("Provider has no snapshot operation");
        const result = await this.bounded(state.captureByMs!, (signal) =>
          provider.takeSnapshot!({ ...common, signal })
        );
        if (!result.success || !result.imageId)
          throw new Error(result.error ?? "Provider did not return a ready snapshot");
        artifactId = result.imageId;
        sourceStopped = result.sourceStopped === true;
      }
      if (!this.owns(capturing)) return;
      const receipt = {
        kind: retained ? ("retained" as const) : ("snapshot" as const),
        artifactId,
        provider: provider.name,
        savedAtMs: this.now(),
        runtimeVersion: this.deps.sandbox.getSandbox()?.runtime_version ?? null,
      };
      const retiring: PreservationRecord = {
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
          "unknown",
          error instanceof PreservationDeadlineError
            ? "Provider preservation deadline exceeded; result unknown."
            : "The provider did not confirm final preservation. The previous recovery point is unchanged."
        );
    } finally {
      this.activeOperation = null;
    }
  }

  private async retire(state: PreservationRecord): Promise<void> {
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

  private finish(state: PreservationRecord): void {
    this.deps.sandbox.updateSandboxStatus("stopped");
    this.deps.retireAccess();
    this.publish({ ...state, phase: "saved" });
    this.deps.messenger.broadcast({ type: "sandbox_status", status: "stopped" });
    this.kickQueue();
  }

  private fail(state: PreservationRecord, phase: "failed" | "unknown", error: string): void {
    this.publish({ ...state, phase, error });
    this.deps.messenger.broadcast({
      type: "sandbox_warning",
      message: `Sandbox preservation ${phase}: ${error}`,
    });
  }

  private owns(state: PreservationRecord): boolean {
    const current = this.deps.store.read();
    return (
      this.current(state) &&
      current !== null &&
      current.operationId === state.operationId &&
      current.phase === state.phase
    );
  }

  private matches(
    state: PreservationRecord,
    generation: { sandboxId: string; createdAt: number }
  ): boolean {
    return (
      state.generation.sandboxId === generation.sandboxId &&
      state.generation.createdAt === generation.createdAt
    );
  }

  private providerMatches(state: PreservationRecord): boolean {
    if (!state.provider || state.provider === this.deps.provider.name) return true;
    if (state.phase !== "unknown")
      this.fail(
        state,
        "unknown",
        "The sandbox provider changed; its existing source cannot be preserved through a different provider."
      );
    return false;
  }

  private kickQueue(): void {
    this.deps.background.submit(() => this.deps.processQueue(), { name: "message_queue.process" });
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
            new PreservationDeadlineError("Provider preservation deadline exceeded; result unknown")
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
