import type { SandboxGeneration } from "../sandbox/lifecycle/ports";
import type { SandboxShutdownStorage } from "./sandbox-ports";
import type {
  ShutdownRecord,
  ShutdownRecoveryReceipt,
  ShutdownStore,
} from "./sandbox-shutdown-repository";
import type { TransactionSync } from "./sql-storage";

interface CommitContext {
  operationId: string;
  generation: SandboxGeneration;
  provider: string;
  providerObjectId: string;
}

interface SnapshotArtifact {
  kind: "snapshot";
  artifactId: string;
  runtimeVersion: string | null;
}

interface RetainedArtifact {
  kind: "retained";
  artifactId: string;
  runtimeVersion: string | null;
}

export type RecoveryPointCommitResult =
  | { kind: "committed"; record: ShutdownRecord }
  | { kind: "rejected" };

export interface SandboxRecoveryPointStore {
  commitCheckpointSnapshot(command: CommitContext & SnapshotArtifact): RecoveryPointCommitResult;
  commitFinalCapture(
    command: CommitContext & { artifact: SnapshotArtifact | RetainedArtifact }
  ): RecoveryPointCommitResult;
}

/** Atomically commits verified provider artifacts to both recovery projections. */
export class SandboxRecoveryPointRepository implements SandboxRecoveryPointStore {
  constructor(
    private readonly transaction: TransactionSync,
    private readonly shutdown: ShutdownStore,
    private readonly sandbox: SandboxShutdownStorage,
    private readonly now: () => number = Date.now
  ) {}

  commitCheckpointSnapshot(command: CommitContext & SnapshotArtifact): RecoveryPointCommitResult {
    return this.commit(command, (state) =>
      state.checkpointInFlight === true &&
      state.checkpointOperationId === command.operationId &&
      (state.phase === "running" || state.phase === "draining")
        ? {
            ...state,
            checkpointInFlight: false,
            checkpointOperationId: undefined,
          }
        : null
    );
  }

  commitFinalCapture(
    command: CommitContext & { artifact: SnapshotArtifact | RetainedArtifact }
  ): RecoveryPointCommitResult {
    return this.commit({ ...command, ...command.artifact }, (state) =>
      state.phase === "capturing" && state.operationId === command.operationId
        ? { ...state, phase: "retiring" }
        : null
    );
  }

  private commit(
    command: CommitContext & (SnapshotArtifact | RetainedArtifact),
    claim: (state: ShutdownRecord) => ShutdownRecord | null
  ): RecoveryPointCommitResult {
    let result: RecoveryPointCommitResult = { kind: "rejected" };
    this.transaction(() => {
      const state = this.shutdown.read();
      const row = this.sandbox.getSandbox();
      const claimed = state && claim(state);
      if (
        !claimed ||
        state.generation.sandboxId !== command.generation.sandboxId ||
        state.generation.createdAt !== command.generation.createdAt ||
        row?.modal_sandbox_id !== command.generation.sandboxId ||
        row.created_at !== command.generation.createdAt ||
        row.modal_object_id !== command.providerObjectId ||
        (state.provider ?? command.provider) !== command.provider ||
        state.providerObjectId !== command.providerObjectId
      )
        return;

      const receipt: ShutdownRecoveryReceipt = {
        kind: command.kind,
        artifactId: command.artifactId,
        provider: command.provider,
        savedAtMs: this.now(),
        runtimeVersion: command.runtimeVersion,
      };
      if (
        command.kind === "snapshot" &&
        !this.sandbox.recordSandboxSnapshot(
          command.generation,
          command.artifactId,
          command.runtimeVersion
        )
      )
        return;

      const record = { ...claimed, receipt, savedAtMs: receipt.savedAtMs };
      this.shutdown.write(record);
      result = { kind: "committed", record };
    });
    return result;
  }
}
