/**
 * The one effectful snapshot application for callers running inside the
 * session DO (read-through refresh and creation-time repair; the webhook path
 * reaches the same sequence through the snapshot-push endpoint). Order is the
 * authority-then-mirror rule (design §5): upsert the D1 record first — a
 * snapshot its monotonic guard rejects as stale must never reach the mirror,
 * while a *thrown* upsert stays best-effort — then re-read the artifact at
 * apply time (a webhook push can land between awaits, and the staleness guard
 * must evaluate the current row), then perform the guarded mirror write.
 * Returns the artifact_updated payload as data; the caller broadcasts it.
 */

import type { SessionArtifact } from "@open-inspect/shared/types/artifacts";
import type { SessionPullRequestStore } from "../db/session-pull-request-store";
import type { ArtifactRepository } from "./artifact-repository";
import {
  preparePullRequestArtifactUpdate,
  snapshotToRecord,
  type PullRequestSnapshotInput,
} from "./pull-request-snapshot";

export interface ApplyPullRequestSnapshotDeps {
  artifactRepository: Pick<ArtifactRepository, "getArtifactById" | "updateArtifact">;
  sessionPullRequests: Pick<SessionPullRequestStore, "upsert"> | null;
}

export interface ApplyPullRequestSnapshotTarget {
  artifactId: string;
  sessionId: string;
  /** Creation timestamp preserved on the D1 record across upserts. */
  artifactCreatedAt: number;
}

export interface ApplyPullRequestSnapshotResult {
  /** artifact_updated payload when the mirror materially changed; else null. */
  updatedArtifact: SessionArtifact | null;
  /** The D1 upsert's thrown error (best-effort path — mirror still updated). */
  recordWriteError: unknown | null;
}

export async function applyPullRequestSnapshot(
  deps: ApplyPullRequestSnapshotDeps,
  target: ApplyPullRequestSnapshotTarget,
  snapshot: PullRequestSnapshotInput
): Promise<ApplyPullRequestSnapshotResult> {
  let recordWriteError: unknown | null = null;
  if (deps.sessionPullRequests) {
    const record = snapshotToRecord(snapshot, {
      artifactId: target.artifactId,
      sessionId: target.sessionId,
      createdAt: target.artifactCreatedAt,
      updatedAt: Date.now(),
    });
    try {
      const { applied } = await deps.sessionPullRequests.upsert(record);
      if (!applied) return { updatedArtifact: null, recordWriteError: null };
    } catch (error) {
      recordWriteError = error ?? new Error("session pull request upsert failed");
    }
  }

  const currentArtifact = deps.artifactRepository.getArtifactById(target.artifactId);
  if (!currentArtifact) return { updatedArtifact: null, recordWriteError };

  const artifactUpdate = preparePullRequestArtifactUpdate(currentArtifact, snapshot, Date.now());
  if (!artifactUpdate) return { updatedArtifact: null, recordWriteError };

  deps.artifactRepository.updateArtifact(currentArtifact.id, artifactUpdate.update);
  return { updatedArtifact: artifactUpdate.artifact, recordWriteError };
}
