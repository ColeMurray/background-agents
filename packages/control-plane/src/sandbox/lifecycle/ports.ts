/** Attempt identity captured before asynchronous lifecycle effects. */
export interface SandboxGeneration {
  sandboxId: string | null;
  createdAt: number;
}

export type CheckpointRunResult<T> = { outcome: "completed"; value: T } | { outcome: "uncertain" };

export interface SandboxCheckpointLease {
  readonly id: string;
  readonly generation: SandboxGeneration;
  readonly deadlineAtMs: number;
  run<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<CheckpointRunResult<T>>;
  finish(): void;
}

/** Accepts an authenticated runtime observation; false means no transition. */
export interface SandboxReadiness {
  onRuntimeReady(timestamp: number, harness?: string): boolean;
}

/** Applies sandbox cancellation after session work has been cancelled. */
export interface SandboxCancellation {
  cancelSandbox(): void;
}

/** Transport attachment reports facts without granting ordinary command readiness. */
export interface SandboxAttachment {
  scheduleDisconnectCheck(): Promise<void>;
  isProviderStartupPending(): boolean;
  onSandboxConnected(): void;
  onSandboxSocketAttached(generation: SandboxGeneration): void;
}

/** The lifecycle result consumed by the existing alarm coordinator. */
export type SandboxAlarmResult =
  | "no_action"
  | "sandbox_failed"
  | "sandbox_terminated"
  | { kind: "boot_budget_exceeded"; reason: string };

export interface SandboxAlarm {
  handleAlarm(): Promise<SandboxAlarmResult>;
}
