import {
  MAX_SANDBOX_COMMAND_TIMEOUT_MS,
  type SandboxExecutionCommand,
  type SandboxRuntimeMode,
} from "@open-inspect/shared";
import type { SandboxCommandState } from "./sandbox-command-repository";

type ExecuteCommand = Extract<SandboxExecutionCommand, { type: "command_execute" }>;

interface CommandLedger {
  admit(
    command: ExecuteCommand,
    operationId: string,
    now: number
  ): { kind: "created" | "duplicate"; command: { state: SandboxCommandState } };
  markDispatched(
    commandId: string,
    sandboxId: string,
    bridgeInstanceId: string,
    now: number,
    deadlineAt: number
  ): boolean;
  requestCancellation(commandId: string, now: number): SandboxCommandState;
  recoveryCommands(
    sandboxId: string,
    bridgeInstanceId: string,
    now: number
  ): SandboxExecutionCommand[];
  claimExpired(now: number): string[];
  getNextDeadline(): number | null;
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

interface PiSandboxExecutionDependencies {
  enabled: boolean;
  commands: CommandLedger;
  sandboxes: SandboxStore;
  lifecycle: {
    spawnSandbox(intent: "spawn", runtimeMode: "execution"): Promise<void>;
  };
  sockets: { sendToSandbox(message: object): boolean };
  alarmScheduler: { schedule(timestamp: number): Promise<void> };
  getSession(): { id: string; harness: string } | null;
  isFenced(): boolean;
  generateId(): string;
  now(): number;
}

/**
 * Dormant command coordinator for Pi sessions.
 *
 * This is intentionally not a Pi extension or model-visible tool. A later
 * authority layer may call it after approval and credential policy are in
 * place; until then the feature flag alone cannot expose process execution.
 */
export class PiSandboxExecutionCoordinator {
  constructor(private readonly deps: PiSandboxExecutionDependencies) {}

  async submit(command: ExecuteCommand, operationId: string): Promise<void> {
    this.assertAvailable();
    const now = this.deps.now();
    const admission = this.deps.commands.admit(command, operationId, now);
    if (
      ["succeeded", "failed", "cancelled", "timed_out", "indeterminate"].includes(
        admission.command.state
      )
    ) {
      return;
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
    if (sandbox.status === "ready" && (await this.dispatch(command))) return;
    await this.deps.lifecycle.spawnSandbox("spawn", "execution");
  }

  async onSandboxReady(): Promise<void> {
    const sandbox = this.deps.sandboxes.getSandbox();
    if (
      !this.deps.enabled ||
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
      this.deps.sockets.sendToSandbox({ type: "command_cancel", commandId });
    }
    return state;
  }

  async handleAlarm(): Promise<void> {
    const now = this.deps.now();
    for (const commandId of this.deps.commands.claimExpired(now)) {
      this.deps.sockets.sendToSandbox({ type: "command_cancel", commandId });
    }
    await this.scheduleNextDeadline();
  }

  private async dispatch(command: SandboxExecutionCommand): Promise<boolean> {
    const sandbox = this.deps.sandboxes.getSandbox();
    if (!sandbox?.modal_sandbox_id || !sandbox.execution_bridge_id) return false;
    if (command.type === "command_execute") {
      const now = this.deps.now();
      const claimed = this.deps.commands.markDispatched(
        command.commandId,
        sandbox.modal_sandbox_id,
        sandbox.execution_bridge_id,
        now,
        now + (command.timeoutMs ?? MAX_SANDBOX_COMMAND_TIMEOUT_MS)
      );
      if (!claimed) return false;
      await this.scheduleNextDeadline();
    }
    return this.deps.sockets.sendToSandbox(command);
  }

  private async scheduleNextDeadline(): Promise<void> {
    const deadline = this.deps.commands.getNextDeadline();
    if (deadline !== null) await this.deps.alarmScheduler.schedule(deadline);
  }

  private assertAvailable(): void {
    if (!this.deps.enabled) throw new Error("Pi sandbox execution is disabled");
    if (this.deps.isFenced()) throw new Error("Pi sandbox execution is fenced for preservation");
    if (this.deps.getSession()?.harness !== "pi") {
      throw new Error("Sandbox command execution is reserved for Pi sessions");
    }
  }
}
