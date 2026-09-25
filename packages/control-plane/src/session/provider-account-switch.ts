import { harnessSupportsProviderAuth } from "@open-inspect/shared/harnesses";
import type { SubscriptionProviderId } from "@open-inspect/shared/types/provider-accounts";
import type {
  ProviderAccountSwitchRequest,
  ProviderAccountSwitchOperation,
  ProviderAccountSwitchEvent,
  ProviderAccountSwitchCommand,
  SessionProviderAuthState,
} from "@open-inspect/shared/types/provider-account-switch";
import type { SessionIndexStore } from "../db/session-index";
import type { SessionProviderBindingStore } from "../db/session-provider-binding";
import type { ProviderSwitchStore } from "./provider-account-switch-repository";
import type { SessionRow, SandboxRow } from "./types";
import type { SandboxShutdownState } from "@open-inspect/shared/types/sandbox-shutdown";
import type { LifecycleWorkOwner } from "../sandbox/lifecycle/ports";

// Conservative initial bounds. Live qualification measures these before enablement.
export const PROVIDER_SWITCH_TIMEOUT_MS = 120_000;
type Generation = { sandboxId: string; createdAt: number };
interface Dependencies {
  store: ProviderSwitchStore;
  session(): SessionRow | null;
  sessionId(): string;
  sandbox(): SandboxRow | null;
  pendingCount(): number;
  processing(): boolean;
  canAdmit(): boolean;
  enabled(): boolean;
  claim(operation: ProviderAccountSwitchOperation, persist: () => void): void;
  owns(operation: ProviderAccountSwitchOperation): boolean;
  release(operationId: string): void;
  preservation(): SandboxShutdownState | null;
  retain(operation: ProviderAccountSwitchOperation): Promise<void>;
  inactivityMs(): number;
  deliverAudit(): Promise<void>;
  canRestore(): boolean;
  restore(operationId: string): Promise<void>;
  index: Pick<SessionIndexStore, "getCompleteProviderAuth" | "getProviderAuthForProvider">;
  bindings: Pick<SessionProviderBindingStore, "commit">;
  prepare(provider: SubscriptionProviderId, accountId: string, actorId: string): Promise<void>;
  send(command: ProviderAccountSwitchCommand): boolean;
  schedule(deadline: number): Promise<void>;
  changed(operation: ProviderAccountSwitchOperation): void;
  pump(): Promise<void>;
  now?: () => number;
}
export class ProviderSwitchError extends Error {}

/** One durable operation owns the dispatch hold through uncertain stop/apply outcomes. */
export class ProviderAccountSwitchCoordinator {
  private readonly now: () => number;
  private advancing = false;
  constructor(private readonly deps: Dependencies) {
    this.now = deps.now ?? Date.now;
  }
  epoch(): number {
    return this.deps.store.read().epoch;
  }
  held(): boolean {
    return this.deps.store.read().operation?.hold ?? false;
  }
  operation(): ProviderAccountSwitchOperation | null {
    return this.deps.store.read().operation;
  }
  generationReserved(
    owner: LifecycleWorkOwner | undefined,
    generation: Generation
  ): LifecycleWorkOwner | undefined {
    const state = this.deps.store.read();
    const previous = state.operation;
    const applied = state.lastAppliedOperation;
    if (
      owner?.kind === "provider_switch" &&
      previous?.operationId === owner.operationId &&
      previous.phase === "restoring"
    )
      this.deps.store.write({
        ...state,
        operation: { ...previous, generation },
        epoch: state.epoch + 1,
      });
    else if (applied && !previous?.hold && !this.sameGeneration(applied.generation, generation)) {
      // Ordinary idle restore also invalidates the retained credential client's
      // generation. Reserve a reapplication hold in the startup transaction,
      // before provider I/O or readiness can dispatch the queued prompt.
      const operationId = crypto.randomUUID();
      this.deps.store.write({
        ...state,
        history: previous ? [...state.history, previous].slice(-32) : state.history,
        epoch: state.epoch + 1,
        operation: {
          ...applied,
          operationId,
          generation,
          sourceAccountId: applied.targetAccountId,
          expectedBindingRevision: applied.bindingRevision,
          bindingRevision: applied.bindingRevision + 1,
          deadlineMs: this.now() + PROVIDER_SWITCH_TIMEOUT_MS,
          phase: "restoring",
          hold: true,
          interrupted: this.deps.processing() || this.deps.pendingCount() > 0,
          reason: undefined,
        },
      });
      return { kind: "provider_switch", operationId };
    }
    return owner;
  }
  private generation(): Generation | null {
    const row = this.deps.sandbox();
    return row?.modal_sandbox_id && !row.fenced
      ? { sandboxId: row.modal_sandbox_id, createdAt: row.created_at }
      : null;
  }
  private sameGeneration(a: Generation | null, b: Generation | null): boolean {
    return !!a && !!b && a.sandboxId === b.sandboxId && a.createdAt === b.createdAt;
  }
  async runtimeReady(supportedProviders: SubscriptionProviderId[]): Promise<void> {
    const state = this.deps.store.read();
    this.deps.store.write({
      ...state,
      capability: supportedProviders.length ? this.generation() : null,
      supportedProviders,
    });
    if (this.operation() && supportedProviders.includes(this.operation()!.provider))
      await this.reconcile();
  }
  private usable(operation: ProviderAccountSwitchOperation): boolean {
    const session = this.deps.session();
    return (
      !!session &&
      !["archived", "cancelled"].includes(session.status) &&
      this.sameGeneration(this.generation(), operation.generation) &&
      this.operation()?.operationId === operation.operationId &&
      this.operation()?.phase !== "cancelled" &&
      this.deps.owns(operation)
    );
  }
  private publish(operation: ProviderAccountSwitchOperation): void {
    const state = this.deps.store.read();
    this.deps.store.write({
      ...state,
      operation,
      lastAppliedOperation: operation.phase === "applied" ? operation : state.lastAppliedOperation,
      epoch: state.epoch + 1,
    });
    this.deps.changed(operation);
  }
  async snapshot(): Promise<SessionProviderAuthState> {
    await this.deps.deliverAudit();
    const bindings = await this.deps.index.getCompleteProviderAuth(this.deps.sessionId());
    const state = this.deps.store.read();
    const available =
      this.deps.enabled() &&
      state.supportedProviders.some((provider) =>
        this.deps.session()?.model.startsWith(`${provider}/`)
      ) &&
      this.sameGeneration(state.capability, this.generation()) &&
      (this.deps.sandbox()?.status === "ready" || this.deps.canRestore());
    return {
      bindings,
      operation: this.operation(),
      switchAvailable: available,
      preservation: this.deps.preservation(),
      ...(!available
        ? {
            unavailableReason:
              "This runtime/provider path has not been qualified for account switching.",
          }
        : {}),
      pendingCount: this.deps.pendingCount(),
    };
  }
  async start(
    provider: SubscriptionProviderId,
    request: ProviderAccountSwitchRequest,
    actorId: string
  ): Promise<void> {
    return this.begin(provider, request, actorId, false);
  }
  private async begin(
    provider: SubscriptionProviderId,
    request: ProviderAccountSwitchRequest,
    actorId: string,
    recoveringCurrentBinding: boolean
  ): Promise<void> {
    const state = this.deps.store.read();
    const duplicate = [state.operation, ...state.history].find(
      (op) => op?.operationId === request.operationId
    );
    if (duplicate) {
      if (
        duplicate.provider !== provider ||
        duplicate.targetAccountId !== request.targetAccountId ||
        duplicate.expectedBindingRevision !== request.expectedBindingRevision ||
        duplicate.actorId !== actorId
      )
        throw new ProviderSwitchError("provider_switch_operation_conflict");
      if (duplicate === state.operation && duplicate.hold) await this.reconcile();
      return;
    }
    const restoring = this.deps.canRestore();
    if (state.operation?.hold && !restoring)
      throw new ProviderSwitchError("provider_switch_operation_conflict");
    const session = this.deps.session();
    const generation = this.generation();
    if (
      !session ||
      !session.agent_session_id ||
      !generation ||
      !state.supportedProviders.includes(provider) ||
      (!recoveringCurrentBinding && !this.deps.enabled()) ||
      !this.deps.canAdmit() ||
      (!restoring && this.deps.sandbox()?.status !== "ready") ||
      !this.sameGeneration(generation, state.capability)
    )
      throw new ProviderSwitchError("unsupported_provider_switch_runtime");
    if (
      !harnessSupportsProviderAuth(session.harness, provider, "provider_account") ||
      !session.model.startsWith(`${provider}/`)
    )
      throw new ProviderSwitchError("unsupported_provider_switch_auth_mode");
    const op: ProviderAccountSwitchOperation = {
      ...request,
      provider,
      actorId,
      generation,
      sourceAccountId: request.targetAccountId,
      bindingRevision: request.expectedBindingRevision + 1,
      conversationId: session.agent_session_id,
      phase: "validating",
      deadlineMs: this.now() + PROVIDER_SWITCH_TIMEOUT_MS,
      hold: true,
      interrupted: this.deps.processing() || this.deps.pendingCount() > 0,
    };
    // No await before the durable hold: competing pumps and operations now see ownership.
    this.deps.claim(op, () =>
      this.deps.store.write({
        ...state,
        history: state.operation ? [...state.history, state.operation].slice(-32) : state.history,
        operation: op,
        epoch: state.epoch + 1,
      })
    );
    try {
      await this.deps.schedule(op.deadlineMs);
      const binding = await this.deps.index.getProviderAuthForProvider(
        this.deps.sessionId(),
        provider
      );
      if (!restoring && !this.usable(op)) return;
      if (
        this.operation()?.operationId !== op.operationId ||
        this.operation()?.phase === "cancelled"
      )
        return;
      if (
        !binding ||
        binding.authMode !== "provider_account" ||
        (binding.bindingRevision ?? 1) !== request.expectedBindingRevision ||
        (!state.operation?.hold && binding.providerAccountId === request.targetAccountId)
      )
        throw new ProviderSwitchError("stale_provider_binding");
      await this.deps.prepare(provider, request.targetAccountId, actorId);
      if (
        this.operation()?.operationId !== op.operationId ||
        this.operation()?.phase === "cancelled"
      )
        return;
      if (restoring) {
        this.publish({ ...op, sourceAccountId: binding.providerAccountId, phase: "restoring" });
        await this.deps.restore(op.operationId);
        if (this.sameGeneration(this.deps.store.read().capability, this.generation()))
          await this.reconcile();
        return;
      }
      if (!this.usable(op)) return;
      const quiescing = {
        ...op,
        sourceAccountId: binding.providerAccountId,
        phase: "quiescing" as const,
      };
      this.publish(quiescing);
      if (!this.send(quiescing, "provider_account_quiesce"))
        this.fail(quiescing, "stop_not_confirmed");
    } catch (error) {
      if (
        this.operation()?.operationId === op.operationId &&
        this.operation()?.phase === "validating"
      ) {
        this.publish({ ...op, phase: "failed", hold: false, reason: "ineligible_target" });
        this.deps.release(op.operationId);
        await this.deps.pump();
      } else if (
        this.operation()?.operationId === op.operationId &&
        this.operation()?.phase === "restoring"
      )
        this.publish({
          ...this.operation()!,
          phase: "needs_reconciliation",
          reason: "workspace_unavailable",
          hold: true,
        });
      throw error;
    }
  }
  private send(
    op: ProviderAccountSwitchOperation,
    type: ProviderAccountSwitchCommand["type"]
  ): boolean {
    const session = this.deps.session();
    if (!session || !session.model.startsWith(`${op.provider}/`)) return false;
    return this.deps.send({
      type,
      operationId: op.operationId,
      provider: op.provider,
      bindingRevision: op.bindingRevision,
      generation: op.generation,
      conversationId: op.conversationId,
      deadlineMs: op.deadlineMs,
      model: session.model,
      reasoningEffort: session.reasoning_effort ?? null,
    });
  }
  private fail(
    op: ProviderAccountSwitchOperation,
    reason: ProviderAccountSwitchOperation["reason"]
  ): void {
    if (this.usable(op)) this.publish({ ...op, phase: "needs_reconciliation", hold: true, reason });
  }
  async event(event: ProviderAccountSwitchEvent): Promise<void> {
    const op = this.operation();
    if (
      !op ||
      !this.usable(op) ||
      event.operationId !== op.operationId ||
      event.provider !== op.provider ||
      event.bindingRevision !== op.bindingRevision ||
      event.conversationId !== op.conversationId ||
      !this.sameGeneration(event.generation, op.generation)
    )
      return;
    if (op.phase === "applied" || op.phase === "failed") return;
    if (event.outcome === "failed") {
      this.fail(op, event.reason ?? "apply_outcome_unknown");
      return;
    }
    if (event.outcome === "quiesced" && op.phase === "quiescing") {
      if (this.advancing) return;
      this.advancing = true;
      try {
        await this.deps.prepare(op.provider, op.targetAccountId, op.actorId);
        if (!this.usable(op) || this.now() >= op.deadlineMs) return;
        await this.deps.bindings.commit({
          sessionId: this.deps.sessionId(),
          provider: op.provider,
          operationId: op.operationId,
          actorId: op.actorId,
          sourceAccountId: op.sourceAccountId,
          targetAccountId: op.targetAccountId,
          expectedBindingRevision: op.expectedBindingRevision,
        });
        await this.deps.deliverAudit();
        if (!this.usable(op)) return;
        const applying = { ...op, phase: "applying" as const };
        this.publish(applying);
        if (!this.send(applying, "provider_account_apply"))
          this.fail(applying, "apply_outcome_unknown");
      } catch {
        this.fail(op, "apply_outcome_unknown");
      } finally {
        this.advancing = false;
      }
    } else if (
      event.outcome === "applied" &&
      ["applying", "needs_reconciliation"].includes(op.phase)
    ) {
      const binding = await this.deps.index.getProviderAuthForProvider(
        this.deps.sessionId(),
        op.provider
      );
      if (
        !this.usable(op) ||
        binding?.authMode !== "provider_account" ||
        binding.providerAccountId !== op.targetAccountId ||
        binding.bindingRevision !== op.bindingRevision ||
        binding.lastSwitchOperationId !== op.operationId
      )
        return;
      try {
        await this.deps.prepare(op.provider, op.targetAccountId, op.actorId);
      } catch {
        this.fail(op, "credential_unavailable");
        return;
      }
      if (this.usable(op)) {
        const hold = op.interrupted || this.deps.pendingCount() > 0;
        this.publish({ ...op, phase: "applied", reason: undefined, hold });
        if (!hold) this.deps.release(op.operationId);
      }
    }
  }
  async reconcile(): Promise<void> {
    const op = this.operation();
    if (!op || !this.usable(op) || !op.hold || op.phase === "applied") return;
    const state = this.deps.store.read();
    if (
      !this.sameGeneration(state.capability, op.generation) ||
      !state.supportedProviders.includes(op.provider)
    )
      return;
    const binding = await this.deps.index.getProviderAuthForProvider(
      this.deps.sessionId(),
      op.provider
    );
    if (!this.usable(op)) return;
    if (this.now() >= op.deadlineMs) {
      this.fail(op, "deadline_expired");
      return;
    }
    if (
      (binding?.lastSwitchOperationId === op.operationId &&
        binding.bindingRevision === op.bindingRevision) ||
      (binding?.authMode === "provider_account" &&
        binding.providerAccountId === op.sourceAccountId &&
        binding.bindingRevision === op.expectedBindingRevision)
    ) {
      // Re-establish containment after a bridge restart before replaying apply. The
      // global binding receipt makes the subsequent commit idempotent.
      const quiescing = { ...op, phase: "quiescing" as const, reason: undefined };
      this.publish(quiescing);
      if (!this.send(quiescing, "provider_account_quiesce"))
        this.fail(quiescing, "stop_not_confirmed");
    } else this.fail(op, "apply_outcome_unknown");
  }
  async alarm(): Promise<"continue" | "hold_watchdogs"> {
    await this.deps.deliverAudit();
    const op = this.operation();
    if (!op?.hold) return "continue";
    if (op.phase === "cancelled") return "continue";
    if (!this.sameGeneration(this.generation(), op.generation)) {
      this.publish({ ...op, phase: "cancelled", reason: "workspace_unavailable", hold: true });
      return "hold_watchdogs";
    }
    const preservation = this.deps.preservation();
    if (preservation && preservation.phase !== "running") {
      if (
        op.phase === "restoring" &&
        preservation.phase === "restoring" &&
        this.now() < op.deadlineMs
      ) {
        await this.deps.schedule(op.deadlineMs);
        return "hold_watchdogs";
      }
      if (preservation.expiresAtMs && preservation.expiresAtMs > this.now())
        await this.deps.schedule(preservation.expiresAtMs);
      if (op.phase !== "applied" && op.reason !== "preservation_unavailable")
        this.publish({ ...op, phase: "needs_reconciliation", reason: "preservation_unavailable" });
      return "hold_watchdogs";
    }
    if (this.now() >= op.deadlineMs && op.phase !== "applied") this.fail(op, "deadline_expired");
    else if (op.phase !== "applied") await this.deps.schedule(op.deadlineMs);
    const idleAt = (this.deps.sandbox()?.last_activity ?? this.now()) + this.deps.inactivityMs();
    if (
      (op.phase !== "applied" && this.now() >= op.deadlineMs) ||
      (op.phase === "applied" && this.now() >= idleAt)
    )
      await this.deps.retain(op);
    else if (op.phase === "applied") await this.deps.schedule(idleAt);
    // Expiry is not authority to destroy the workspace. Explicit cancel/archive still wins.
    return "hold_watchdogs";
  }
  cancel(): void {
    const op = this.operation();
    if (op) this.publish({ ...op, phase: "cancelled", hold: true });
  }
  async resume(operationId: string, bindingRevision: number, actorId?: string): Promise<void> {
    const op = this.operation();
    const canResume = () =>
      !!op &&
      this.operation()?.operationId === operationId &&
      this.operation()?.phase === "applied" &&
      !["archived", "cancelled"].includes(this.deps.session()?.status ?? "cancelled") &&
      (this.usable(op) || this.deps.preservation()?.phase === "saved");
    if (
      !op ||
      !canResume() ||
      op.operationId !== operationId ||
      op.bindingRevision !== bindingRevision ||
      op.phase !== "applied"
    )
      throw new ProviderSwitchError("provider_switch_not_applied");
    const resumeActor = actorId ?? op.actorId;
    await this.deps.prepare(op.provider, op.targetAccountId, resumeActor);
    if (!canResume()) throw new ProviderSwitchError("provider_switch_operation_conflict");
    if (!this.operation()?.hold) return;
    if (this.deps.preservation()?.phase === "saved") {
      // A retained process has the previous generation's credential cache. A
      // fresh bounded operation must confirm the current generation before work
      // can continue; this is not an extension of the expired operation.
      await this.begin(
        op.provider,
        {
          operationId: crypto.randomUUID(),
          targetAccountId: op.targetAccountId,
          expectedBindingRevision: bindingRevision,
        },
        resumeActor,
        true
      );
      return;
    }
    if (!canResume()) throw new ProviderSwitchError("provider_switch_operation_conflict");
    this.deps.release(op.operationId);
    this.publish({ ...op, hold: false });
    await this.deps.pump();
  }
}
