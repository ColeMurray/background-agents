/**
 * Read-through refresh for a session's pull requests (design §5.3): on
 * session open and on the manual sync action, read each PR artifact's current
 * provider state (app-authed), repair/refresh the D1 authority record, and
 * apply the snapshot to the DO artifact mirror. This is the only freshness
 * path that reads the provider directly and the only one required when the
 * bot is off.
 */

import type { SessionArtifact } from "@open-inspect/shared";
import type {
  SessionPullRequestRecord,
  SessionPullRequestStore,
} from "../db/session-pull-request-store";
import type { Logger } from "../logger";
import type { PullRequestSnapshot, SourceControlProvider } from "../source-control";
import {
  applyPullRequestSnapshot,
  parsePullRequestArtifactMetadata,
} from "./pull-request-snapshot";
import type { UpdateArtifactData } from "./repository";
import type { ArtifactRow, SessionRow } from "./types";

/** Minimum spacing between provider reads for the same PR artifact. */
export const PULL_REQUEST_REFRESH_MIN_INTERVAL_MS = 60_000;

export interface PullRequestRefreshRepository {
  getSession(): SessionRow | null;
  listArtifacts(): ArtifactRow[];
  updateArtifact(artifactId: string, data: UpdateArtifactData): void;
}

export interface PullRequestRefreshDeps {
  repository: PullRequestRefreshRepository;
  sourceControlProvider: Pick<SourceControlProvider, "getPullRequest">;
  /** D1 authority store; absent when the deployment has no D1 binding. */
  sessionPullRequests?: Pick<SessionPullRequestStore, "upsert">;
  broadcastArtifactUpdated: (artifact: SessionArtifact) => void;
  log: Logger;
  now: () => number;
}

export interface PullRequestRefreshResult {
  /** Artifacts whose DO mirror actually changed. */
  refreshed: number;
  /** Artifacts skipped by the per-PR rate limit. */
  skipped: number;
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
 * One refresh pass over the session's PR artifacts. Instances are
 * DO-instance-scoped: the per-artifact rate-limit window lives in memory and
 * must survive across requests (like PullRequestCreationClaims).
 */
export class SessionPullRequestRefreshService {
  private readonly lastAttemptAtByArtifact = new Map<string, number>();

  constructor(private readonly deps: PullRequestRefreshDeps) {}

  async refresh(): Promise<PullRequestRefreshResult> {
    const session = this.deps.repository.getSession();
    if (!session) return { refreshed: 0, skipped: 0 };
    const sessionId = session.session_name || session.id;

    const prArtifacts = this.deps.repository
      .listArtifacts()
      .filter((artifact) => artifact.type === "pr");

    let refreshed = 0;
    let skipped = 0;
    for (const artifact of prArtifacts) {
      const target = resolveRefreshTarget(
        parsePullRequestArtifactMetadata(artifact.metadata),
        session
      );
      if (!target) {
        this.deps.log.warn("Pull request artifact not refreshable", {
          artifact_id: artifact.id,
        });
        continue;
      }

      const now = this.deps.now();
      const lastAttemptAt = this.lastAttemptAtByArtifact.get(artifact.id);
      if (
        lastAttemptAt !== undefined &&
        now - lastAttemptAt < PULL_REQUEST_REFRESH_MIN_INTERVAL_MS
      ) {
        skipped += 1;
        continue;
      }
      // Attempt-time stamp: a failing provider is not retried any faster.
      this.lastAttemptAtByArtifact.set(artifact.id, now);

      let snapshot: PullRequestSnapshot;
      try {
        snapshot = await this.deps.sourceControlProvider.getPullRequest({
          owner: target.repoOwner,
          name: target.repoName,
          number: target.prNumber,
          repositoryExternalId: target.repositoryExternalId,
        });
      } catch (error) {
        this.deps.log.error("Pull request read-through failed", {
          artifact_id: artifact.id,
          pr_number: target.prNumber,
          repo_owner: target.repoOwner,
          repo_name: target.repoName,
          error: error instanceof Error ? error : String(error),
        });
        continue;
      }

      await this.upsertRecord(artifact, sessionId, snapshot);

      const { applied } = applyPullRequestSnapshot(
        {
          updateArtifact: (artifactId, data) =>
            this.deps.repository.updateArtifact(artifactId, data),
          broadcastArtifactUpdated: this.deps.broadcastArtifactUpdated,
          now: this.deps.now,
        },
        artifact,
        snapshot
      );
      if (applied) refreshed += 1;
    }

    return { refreshed, skipped };
  }

  /**
   * Refresh/repair the D1 authority record from the provider snapshot —
   * insert-if-absent covers records whose creation write failed. Best-effort:
   * the DO mirror still updates when D1 is unavailable.
   */
  private async upsertRecord(
    artifact: ArtifactRow,
    sessionId: string,
    snapshot: PullRequestSnapshot
  ): Promise<void> {
    const store = this.deps.sessionPullRequests;
    if (!store) return;

    const record: SessionPullRequestRecord = {
      artifactId: artifact.id,
      sessionId,
      repositoryExternalId: snapshot.repositoryExternalId ?? null,
      repoOwner: snapshot.repoOwner,
      repoName: snapshot.repoName,
      prNumber: snapshot.number,
      url: snapshot.url,
      lifecycleState: snapshot.lifecycleState,
      isDraft: snapshot.isDraft,
      headBranch: snapshot.headBranch,
      baseBranch: snapshot.baseBranch,
      headSha: snapshot.headSha ?? null,
      providerUpdatedAt: snapshot.providerUpdatedAt ?? null,
      createdAt: artifact.created_at,
      updatedAt: this.deps.now(),
    };
    try {
      await store.upsert(record);
    } catch (error) {
      this.deps.log.error("Failed to write session pull request record", {
        artifact_id: record.artifactId,
        pr_number: record.prNumber,
        repo_owner: record.repoOwner,
        repo_name: record.repoName,
        error: error instanceof Error ? error : String(error),
      });
    }
  }
}
