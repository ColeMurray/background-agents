/**
 * The canonical PR lifecycle projection boundary (design §5). Every writer —
 * creation, and the webhook/read-through paths in later slices — projects a
 * provider snapshot through this module, so the field mapping between the
 * snapshot, the D1 authority record, the DO artifact metadata, and the
 * artifact_updated broadcast has exactly one home and cannot drift per-writer.
 *
 * Application rules: merge metadata preserving unknown legacy keys, reject
 * stale snapshots by the same monotonic providerUpdatedAt rule as the D1
 * store, no-op when nothing materially changed, and broadcast exactly one
 * artifact_updated on change.
 */

import { toDisplayStatus, type SessionArtifact } from "@open-inspect/shared";
import { z } from "zod";
import type { SessionPullRequestRecord } from "../db/session-pull-request-store";
import type { UpdateArtifactData } from "./repository";
import type { ArtifactRow } from "./types";

/**
 * Mirrors PullRequestSnapshot (source-control/types.ts) — the wire body the
 * webhook and read-through paths push into the DO. Draft is only meaningful
 * while open (shared-contract invariant, same rule as the D1 CHECK).
 */
export const pullRequestSnapshotSchema = z
  .object({
    number: z.number().int().positive(),
    url: z.string(),
    lifecycleState: z.enum(["open", "closed", "merged"]),
    isDraft: z.boolean(),
    headBranch: z.string(),
    baseBranch: z.string(),
    headSha: z.string().optional(),
    repoOwner: z.string(),
    repoName: z.string(),
    repositoryExternalId: z.string().optional(),
    providerUpdatedAt: z.number().optional(),
  })
  .refine((snapshot) => snapshot.lifecycleState === "open" || !snapshot.isDraft, {
    message: "isDraft is only valid while the pull request is open",
  });

export type PullRequestSnapshotInput = z.infer<typeof pullRequestSnapshotSchema>;

/**
 * Project a snapshot into the D1 authority record for an artifact — the
 * single snapshot→record field mapping shared by every record writer.
 */
export function snapshotToRecord(
  snapshot: PullRequestSnapshotInput,
  identity: { artifactId: string; sessionId: string; createdAt: number; updatedAt: number }
): SessionPullRequestRecord {
  return {
    artifactId: identity.artifactId,
    sessionId: identity.sessionId,
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
    createdAt: identity.createdAt,
    updatedAt: identity.updatedAt,
  };
}

/** Tolerant metadata read: malformed or non-object metadata degrades to {}. */
export function parsePullRequestArtifactMetadata(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/**
 * Merge a snapshot into artifact metadata, preserving unknown legacy keys and
 * keeping the legacy `state` display key current for older clients. Creation
 * passes {} as the base; update paths pass the stored metadata.
 */
export function mergeSnapshotMetadata(
  existing: Record<string, unknown>,
  snapshot: PullRequestSnapshotInput
): Record<string, unknown> {
  const next: Record<string, unknown> = {
    ...existing,
    number: snapshot.number,
    state: toDisplayStatus(snapshot),
    lifecycleState: snapshot.lifecycleState,
    isDraft: snapshot.isDraft,
    head: snapshot.headBranch,
    base: snapshot.baseBranch,
    repoOwner: snapshot.repoOwner,
    repoName: snapshot.repoName,
  };
  if (snapshot.headSha !== undefined) next.headSha = snapshot.headSha;
  if (snapshot.repositoryExternalId !== undefined) {
    next.repositoryExternalId = snapshot.repositoryExternalId;
  }
  if (snapshot.providerUpdatedAt !== undefined) {
    next.providerUpdatedAt = snapshot.providerUpdatedAt;
  }
  return next;
}

export interface ApplyPullRequestSnapshotDeps {
  updateArtifact: (artifactId: string, data: UpdateArtifactData) => void;
  broadcastArtifactUpdated: (artifact: SessionArtifact) => void;
  now: () => number;
}

/**
 * Apply a snapshot to an existing `pr` artifact. Returns whether a write (and
 * one artifact_updated broadcast) happened; stale and materially identical
 * snapshots are no-ops.
 */
export function applyPullRequestSnapshot(
  deps: ApplyPullRequestSnapshotDeps,
  artifact: ArtifactRow,
  snapshot: PullRequestSnapshotInput
): { applied: boolean } {
  const existing = parsePullRequestArtifactMetadata(artifact.metadata);

  // Same monotonic rule as the D1 store's upsert guard: only a snapshot
  // strictly older than the stored provider timestamp is rejected; a
  // missing timestamp on either side is authoritative.
  const existingProviderUpdatedAt =
    typeof existing.providerUpdatedAt === "number" ? existing.providerUpdatedAt : null;
  if (
    snapshot.providerUpdatedAt !== undefined &&
    existingProviderUpdatedAt !== null &&
    snapshot.providerUpdatedAt < existingProviderUpdatedAt
  ) {
    return { applied: false };
  }

  const nextMetadata = mergeSnapshotMetadata(existing, snapshot);
  const urlChanged = snapshot.url !== artifact.url;
  const metadataChanged = JSON.stringify(nextMetadata) !== JSON.stringify(existing);
  if (!urlChanged && !metadataChanged) {
    return { applied: false };
  }

  const updatedAt = deps.now();
  deps.updateArtifact(artifact.id, {
    url: snapshot.url,
    metadata: JSON.stringify(nextMetadata),
    updatedAt,
  });
  deps.broadcastArtifactUpdated({
    id: artifact.id,
    type: "pr",
    url: snapshot.url,
    metadata: nextMetadata,
    createdAt: artifact.created_at,
    updatedAt,
  });

  return { applied: true };
}
