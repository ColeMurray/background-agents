/**
 * Read-through refresh for a session's pull requests (design §5.3): on
 * session open and on the manual sync action, read each PR artifact's current
 * provider state (app-authed), repair/refresh the D1 authority record, and
 * apply the snapshot to the DO artifact mirror. This is the only
 * freshness path that reads the provider directly and the only one required
 * when the bot is off.
 *
 * The pass returns its effects as data — updated artifact_updated payloads
 * and per-artifact failures — and the caller broadcasts and logs them.
 */

import type { SessionArtifact } from "@open-inspect/shared";
import type { SessionPullRequestStore } from "../db/session-pull-request-store";
import type { PullRequestSnapshot, SourceControlProvider } from "../source-control";
import {
  parsePullRequestArtifactMetadata,
  preparePullRequestArtifactUpdate,
  snapshotToRecord,
} from "./pull-request-snapshot";
import type { UpdateArtifactData } from "./repository";
import type { ArtifactRow, SessionRow } from "./types";

export interface PullRequestRefreshRepository {
  getSession(): SessionRow | null;
  listArtifacts(): ArtifactRow[];
  getArtifactById(artifactId: string): ArtifactRow | null;
  updateArtifact(artifactId: string, data: UpdateArtifactData): void;
}

/** A per-artifact problem from a refresh pass; the caller decides logging. */
export interface PullRequestRefreshFailure {
  artifactId: string;
  reason: "not_refreshable" | "provider_read_failed" | "record_write_failed";
  prNumber?: number;
  repoOwner?: string;
  repoName?: string;
  error?: unknown;
}

export interface PullRequestRefreshResult {
  /** artifact_updated payloads for mirrors that materially changed. */
  updated: SessionArtifact[];
  failures: PullRequestRefreshFailure[];
}

/** The identity fields a refresh needs from a PR artifact's metadata. */
interface RefreshTarget {
  prNumber: number;
  repoOwner: string;
  repoName: string;
  repositoryExternalId: string | undefined;
}

function resolveRefreshTarget(
  metadata: Record<string, unknown>,
  session: SessionRow
): RefreshTarget | null {
  if (typeof metadata.number !== "number") return null;

  // Identity-less metadata predates multi-repo support and belongs to the
  // session's primary repository by convention (see pr-artifacts.ts).
  const repoOwner =
    typeof metadata.repoOwner === "string" ? metadata.repoOwner : session.repo_owner;
  const repoName = typeof metadata.repoName === "string" ? metadata.repoName : session.repo_name;
  if (!repoOwner || !repoName) return null;

  return {
    prNumber: metadata.number,
    repoOwner,
    repoName,
    repositoryExternalId:
      typeof metadata.repositoryExternalId === "string" ? metadata.repositoryExternalId : undefined,
  };
}

/**
 * One refresh pass over the session's PR artifacts.
 *
 * The D1 write is the authority step: a snapshot the monotonic guard rejects
 * as stale (a newer webhook write won while this read was in flight) never
 * reaches the mirror. It is otherwise best-effort — the mirror still updates
 * when D1 is absent (`sessionPullRequests` null) or errors, and the upsert
 * repairs records whose creation write failed.
 */
export async function refreshSessionPullRequests(
  repository: PullRequestRefreshRepository,
  sourceControlProvider: Pick<SourceControlProvider, "getPullRequest">,
  sessionPullRequests: Pick<SessionPullRequestStore, "upsert"> | null
): Promise<PullRequestRefreshResult> {
  const updated: SessionArtifact[] = [];
  const failures: PullRequestRefreshFailure[] = [];

  const session = repository.getSession();
  if (!session) return { updated, failures };
  const sessionId = session.session_name || session.id;

  const prArtifacts = repository.listArtifacts().filter((artifact) => artifact.type === "pr");

  for (const artifact of prArtifacts) {
    const target = resolveRefreshTarget(
      parsePullRequestArtifactMetadata(artifact.metadata),
      session
    );
    if (!target) {
      failures.push({ artifactId: artifact.id, reason: "not_refreshable" });
      continue;
    }

    let snapshot: PullRequestSnapshot;
    try {
      snapshot = await sourceControlProvider.getPullRequest({
        owner: target.repoOwner,
        name: target.repoName,
        number: target.prNumber,
        repositoryExternalId: target.repositoryExternalId,
      });
    } catch (error) {
      failures.push({
        artifactId: artifact.id,
        reason: "provider_read_failed",
        prNumber: target.prNumber,
        repoOwner: target.repoOwner,
        repoName: target.repoName,
        error,
      });
      continue;
    }

    let recordAccepted = true;
    if (sessionPullRequests) {
      const record = snapshotToRecord(snapshot, {
        artifactId: artifact.id,
        sessionId,
        createdAt: artifact.created_at,
        updatedAt: Date.now(),
      });
      try {
        recordAccepted = (await sessionPullRequests.upsert(record)).applied;
      } catch (error) {
        failures.push({
          artifactId: artifact.id,
          reason: "record_write_failed",
          prNumber: target.prNumber,
          repoOwner: target.repoOwner,
          repoName: target.repoName,
          error,
        });
      }
    }
    if (!recordAccepted) continue;

    // Re-read the row at apply time: a webhook snapshot push can land on this
    // DO between this pass's awaits, and the staleness guard must evaluate
    // against the artifact's current state, not the pre-await copy (the
    // snapshot-push handler re-reads the same way).
    const currentArtifact = repository.getArtifactById(artifact.id);
    if (!currentArtifact) continue;

    const artifactUpdate = preparePullRequestArtifactUpdate(currentArtifact, snapshot, Date.now());
    if (!artifactUpdate) continue;

    repository.updateArtifact(currentArtifact.id, artifactUpdate.update);
    updated.push(artifactUpdate.artifact);
  }

  return { updated, failures };
}
