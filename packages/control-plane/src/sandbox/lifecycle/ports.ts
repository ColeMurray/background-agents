/** Attempt identity captured before asynchronous lifecycle effects. */
export interface SandboxGeneration {
  sandboxId: string | null;
  createdAt: number;
}

/** Coordinator-owned checkpoint result; unknown never authorizes a destructive retry. */
export type SandboxCheckpointOutcome =
  | { outcome: "saved"; imageId: string; sourceStopped: boolean }
  | { outcome: "held" }
  | { outcome: "unknown" };

/**
 * Startup policy hides persisted receipt representation from lifecycle consumers.
 * `normal` defers to existing startup checks; it is not permission to discard saved state.
 * Recovery variants keep snapshot locators distinct from retained provider-object locators.
 */
export type SandboxStartupDecision =
  | { kind: "normal" }
  | { kind: "hold"; reason: string }
  | { kind: "restore_snapshot"; snapshotId: string; runtimeVersion: string | null }
  | { kind: "resume_retained"; providerObjectId: string; runtimeVersion: string | null };

/** Internal facts used by lifecycle queue and push policies, not a caller-assembled protocol. */
export type SandboxWorkAdmission =
  | "unmanaged"
  | "ready"
  | "restore_required"
  | "spawn_required"
  | "held";

/** Only unmanaged sessions retain the legacy manual-push fallback when no socket exists. */
export type SandboxPushAdmission = "ready" | "unmanaged" | "held" | "start_required";

/** A recovery command was well formed but is unsafe for the current durable generation. */
export class ShutdownRecoveryRejectedError extends Error {
  constructor(message = "Shutdown recovery is unavailable") {
    super(message);
    this.name = "ShutdownRecoveryRejectedError";
  }
}

/** Accepts an authenticated runtime observation; false means no transition. */
export interface SandboxReadiness {
  onRuntimeReady(timestamp: number, harness?: string, protocolVersion?: 1): boolean;
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
