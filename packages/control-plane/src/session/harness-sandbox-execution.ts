import {
  DEFAULT_SANDBOX_COMMAND_TIMEOUT_MS,
  MAX_SANDBOX_COMMAND_TIMEOUT_MS,
  type SandboxExecutionCommand,
  type SandboxRuntimeMode,
} from "@open-inspect/shared";
import type {
  SandboxCommandAuthority,
  SandboxCommandRecord,
  SandboxCommandState,
} from "./sandbox-command-repository";

type ExecuteCommand = Extract<SandboxExecutionCommand, { type: "command_execute" }>;

interface CommandLedger {
  admit(
    command: ExecuteCommand,
    operationId: string,
    authority: SandboxCommandAuthority,
    now: number
  ): { kind: "created" | "duplicate"; command: SandboxCommandRecord };
  markDispatchAttempt(
    commandId: string,
    sandboxId: string,
    bridgeInstanceId: string,
    now: number,
    deadlineAt: number
  ): boolean;
  requestCancellation(commandId: string, now: number): SandboxCommandState;
  requestOperationCancellation(operationId: string, now: number): string[];
  recordCancelAttempt(commandId: string, now: number): boolean;
  markIndeterminate(commandId: string, error: string, now: number): boolean;
  get(commandId: string): SandboxCommandRecord | null;
  listOperation(operationId: string): SandboxCommandRecord[];
  nextQueued(): SandboxCommandRecord | null;
  recoveryCommands(
    sandboxId: string,
    bridgeInstanceId: string,
    now: number
  ): SandboxExecutionCommand[];
  claimExpired(now: number): string[];
  claimDueDispatchRetries(now: number): ExecuteCommand[];
  claimDispatchExhaustions(now: number): string[];
  claimDueCancellationRetries(now: number): string[];
  claimCancellationEscalations(now: number): string[];
  getNextDeadline(): number | null;
  prune(now: number): void;
}

interface SandboxStore {
  getSandbox(): {
    status: string;
    runtime_mode?: SandboxRuntimeMode;
    modal_sandbox_id?: string | null;
    execution_bridge_id?: string | null;
  } | null;
  createSandbox(data: {
    id: string;
    status: "pending";
    gitSyncStatus: "pending";
    createdAt: number;
    runtimeMode: "execution";
  }): void;
}

interface HarnessSandboxExecutionDependencies {
  commands: CommandLedger;
  sandboxes: SandboxStore;
  lifecycle: {
    spawnSandbox(intent: "spawn", runtimeMode: "execution"): Promise<void>;
    replaceExecutionSandbox(reason: string): Promise<void>;
  };
  sockets: { sendToSandbox(message: object): boolean };
  alarmScheduler: { schedule(timestamp: number): Promise<void> };
  getSession(): { id: string; harness: string } | null;
  isFenced(): boolean;
  generateId(): string;
  now(): number;
}

/**
 * The command coordinator for a Pi session's execution sandbox.
 *
 * This is the coordinator the *session* holds, not the agent. The model
 * reaches process execution only through the `run_shell` / `run_build` /
 * `run_tests` tools, which are model-visible and are admitted by the
 * session: the capability must allow it, the live deployment mode must
 * allow it, and the turn must have an actor. The coordinator is what the
 * session calls once that admission has happened.
 *
 * The sandbox it drives is the *execution* one: credential-free, with no
 * repository checkout, no harness and no user environment
 * (`sandbox/execution-isolation.ts`). That is what re-contains the
 * arbitrary exec the sandbox harness would have contained.
 *
 * New-session admission belongs to the adapter's durable capability snapshot;
 * this coordinator deliberately has no live deployment-flag gate so admitted
 * command recovery continues after a feature rollback.
 */
export class HarnessSandboxExecutionCoordinator {
  constructor(private readonly deps: HarnessSandboxExecutionDependencies) {}

  async submit(
    command: ExecuteCommand,
    operationId: string,
    authority: SandboxCommandAuthority
  ): Promise<SandboxCommandRecord> {
    this.assertAvailable();
    const now = this.deps.now();
    const admission = this.deps.commands.admit(command, operationId, authority, now);
    if (
      ["succeeded", "failed", "cancelled", "timed_out", "indeterminate"].includes(
        admission.command.state
      )
    ) {
      return admission.command;
    }

    let sandbox = this.deps.sandboxes.getSandbox();
    if (!sandbox) {
      this.deps.sandboxes.createSandbox({
        id: this.deps.generateId(),
        status: "pending",
        gitSyncStatus: "pending",
        createdAt: now,
        runtimeMode: "execution",
      });
      sandbox = this.deps.sandboxes.getSandbox();
    }
    if (!sandbox || sandbox.runtime_mode !== "execution") {
      throw new Error("Pi command execution requires a dedicated execution sandbox");
    }
    if (sandbox.status === "ready" && (await this.dispatch(command))) {
      return this.requireCommand(command.commandId);
    }
    await this.deps.lifecycle.spawnSandbox("spawn", "execution");
    return this.requireCommand(command.commandId);
  }

  async onSandboxReady(): Promise<void> {
    const sandbox = this.deps.sandboxes.getSandbox();
    if (
      sandbox?.status !== "ready" ||
      sandbox?.runtime_mode !== "execution" ||
      !sandbox.modal_sandbox_id ||
      !sandbox.execution_bridge_id
    )
      return;
    for (const command of this.deps.commands.recoveryCommands(
      sandbox.modal_sandbox_id,
      sandbox.execution_bridge_id,
      this.deps.now()
    )) {
      await this.dispatch(command);
    }
  }

  cancel(commandId: string): SandboxCommandState {
    this.assertAvailable();
    const state = this.deps.commands.requestCancellation(commandId, this.deps.now());
    if (state === "cancelling") {
      this.sendCancellation(commandId);
    }
    return state;
  }

  cancelOperation(operationId: string): SandboxCommandState[] {
    const ids = this.deps.commands.requestOperationCancellation(operationId, this.deps.now());
    return ids.map((commandId) => {
      const command = this.requireCommand(commandId);
      if (command.state === "cancelling") this.sendCancellation(commandId);
      return command.state;
    });
  }

  async handleAlarm(): Promise<void> {
    const now = this.deps.now();
    for (const command of this.deps.commands.claimDueDispatchRetries(now)) {
      await this.dispatch(command);
    }
    const dispatchExhaustions = this.deps.commands.claimDispatchExhaustions(now);
    for (const commandId of dispatchExhaustions) {
      this.deps.commands.markIndeterminate(
        commandId,
        "Command start was not acknowledged after bounded dispatch retries",
        now
      );
    }
    for (const commandId of this.deps.commands.claimExpired(now)) {
      this.sendCancellation(commandId);
    }
    for (const commandId of this.deps.commands.claimDueCancellationRetries(now)) {
      this.sendCancellation(commandId);
    }
    const escalations = this.deps.commands.claimCancellationEscalations(now);
    if (escalations.length > 0 || dispatchExhaustions.length > 0) {
      for (const commandId of escalations) {
        this.deps.commands.markIndeterminate(
          commandId,
          "Cancellation grace expired; sandbox generation was fenced",
          now
        );
      }
      await this.deps.lifecycle.replaceExecutionSandbox("command_cancellation_timeout");
    }
    this.deps.commands.prune(now);
    await this.scheduleNextDeadline();
  }

  async onCommandTerminal(): Promise<void> {
    const queued = this.deps.commands.nextQueued();
    if (queued) await this.dispatch(queued.request);
    await this.scheduleNextDeadline();
  }

  private async dispatch(command: SandboxExecutionCommand): Promise<boolean> {
    const sandbox = this.deps.sandboxes.getSandbox();
    if (!sandbox?.modal_sandbox_id || !sandbox.execution_bridge_id) return false;
    if (command.type === "command_execute") {
      const now = this.deps.now();
      const claimed = this.deps.commands.markDispatchAttempt(
        command.commandId,
        sandbox.modal_sandbox_id,
        sandbox.execution_bridge_id,
        now,
        now +
          Math.min(
            command.timeoutMs ?? DEFAULT_SANDBOX_COMMAND_TIMEOUT_MS,
            MAX_SANDBOX_COMMAND_TIMEOUT_MS
          )
      );
      if (!claimed) return false;
      await this.scheduleNextDeadline();
    }
    return this.deps.sockets.sendToSandbox(command);
  }

  private sendCancellation(commandId: string): boolean {
    const now = this.deps.now();
    this.deps.commands.recordCancelAttempt(commandId, now);
    return this.deps.sockets.sendToSandbox({ type: "command_cancel", commandId });
  }

  private requireCommand(commandId: string): SandboxCommandRecord {
    const command = this.deps.commands.get(commandId);
    if (!command) throw new Error(`Sandbox command ${commandId} was not persisted`);
    return command;
  }

  private async scheduleNextDeadline(): Promise<void> {
    const deadline = this.deps.commands.getNextDeadline();
    if (deadline !== null) await this.deps.alarmScheduler.schedule(deadline);
  }

  private assertAvailable(): void {
    if (this.deps.isFenced()) throw new Error("Pi sandbox execution is fenced for preservation");
    if (this.deps.getSession()?.harness !== "pi") {
      throw new Error("Sandbox command execution is reserved for Pi sessions");
    }
  }
}
