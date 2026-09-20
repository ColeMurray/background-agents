import type { GitSyncStatus, SandboxBootPhase } from "@open-inspect/shared/types/sandbox-events";
import type { SandboxStatus } from "@open-inspect/shared/types/sessions";
import type { SandboxRow } from "./types";

/** Read-side state. Lifecycle mutations are not part of a session consumer's port. */
export interface SandboxStateReader {
  getSandbox(): SandboxRow | null;
}

/** Socket identity and liveness belong to transport, not lifecycle transitions. */
export interface SandboxSocketStore extends SandboxStateReader {
  setActiveSocketId(socketId: string): void;
  revokeActiveSocketId(): void;
}

/** Observed runtime facts do not authorize lifecycle transitions. */
export interface SandboxRuntimeFacts {
  updateSandboxHeartbeat(timestamp: number): void;
  recordReportedSandboxRuntimeVersion(runtimeVersion: string | null): void;
  recordBootProgress(phase: SandboxBootPhase, bootSeq: number): boolean;
  updateSandboxGitSyncStatus(status: GitSyncStatus): void;
}

/** Persistence used by final graceful shutdown without exposing the repository aggregate. */
export interface SandboxShutdownStorage extends SandboxStateReader {
  recordSandboxSnapshot(
    sandboxId: string | null,
    snapshotId: string,
    runtimeVersion: string | null
  ): boolean;
  updateSandboxStatus(status: SandboxStatus): void;
  transitionSandboxStatus(
    generation: { sandboxId: string | null; createdAt: number },
    from: SandboxStatus,
    to: SandboxStatus
  ): boolean;
}

/** Aggregate initialization is separate from transitions of an existing sandbox. */
export interface SandboxInitializer {
  createSandbox(data: {
    id: string;
    status: SandboxStatus;
    gitSyncStatus: GitSyncStatus;
    createdAt: number;
  }): void;
}
