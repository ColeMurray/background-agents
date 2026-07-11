/**
 * PR lifecycle tracking on the webhook path (design §5.2). Piggybacks the
 * normalized `/internal/github-event` forward: a `pull_request` event updates
 * the D1 authority record and pushes the fresh snapshot into the owning
 * session DO's artifact mirror. Additive and independent — a failure here
 * never affects automation matching.
 *
 * Correlation is identity-first: `(repository_external_id, pr_number)` via
 * the store's single identity boundary. Branch-name derivation is a guarded
 * fallback only (Superset cross-fork lesson): the derived session must exist
 * AND already be associated with the event's repository, the session must
 * hold a matching DO `pr` artifact, and cross-repository (fork) heads are
 * dropped as not-ours.
 */

import {
  extractSessionIdFromBranch,
  prArtifactBelongsToRepo,
  type GitHubAutomationEvent,
  type GitHubPullRequestEventFacts,
  type PullRequestStatus,
} from "@open-inspect/shared";
import type {
  SessionPullRequestRecord,
  SessionPullRequestStore,
} from "../db/session-pull-request-store";
import type { Logger } from "../logger";
import { snapshotToRecord } from "../session/pull-request-snapshot";
import type { PullRequestSnapshot } from "../source-control";

/** A DO artifact as served by GET /internal/artifacts (metadata pre-parsed). */
export interface SessionArtifactSummary {
  id: string;
  type: string;
  url: string | null;
  metadata: Record<string, unknown> | null;
}

/** The slice of session-index state the processor needs. */
export interface PullRequestLifecycleSessions {
  /** Primary-repo identity for the legacy identity-less-artifact convention. */
  get(id: string): Promise<{ repoOwner: string | null; repoName: string | null } | null>;
  isRepositoryAssociated(sessionId: string, repoOwner: string, repoName: string): Promise<boolean>;
}

export interface PullRequestLifecycleDeps {
  store: Pick<SessionPullRequestStore, "getByIdentity" | "upsert">;
  sessions: PullRequestLifecycleSessions;
  listSessionArtifacts: (sessionId: string) => Promise<SessionArtifactSummary[]>;
  pushSnapshotToSession: (
    sessionId: string,
    artifactId: string,
    snapshot: PullRequestSnapshot
  ) => Promise<void>;
  log: Logger;
  now: () => number;
}

export type PullRequestLifecycleOutcome =
  | "not_pull_request"
  | "cross_repository"
  | "no_state"
  | "updated"
  | "stale"
  | "no_branch_session"
  | "session_not_associated"
  | "no_matching_artifact"
  | "insufficient_payload"
  | "inserted";

/**
 * Lifecycle/draft from webhook facts. Null when the payload carried no state
 * — the event is skipped and read-through repairs later. The `merged` flag
 * disambiguates merged from closed; draft is only meaningful while open.
 */
function deriveStatusFromFacts(facts: GitHubPullRequestEventFacts): PullRequestStatus | null {
  if (!facts.state) return null;
  if (facts.state === "closed") {
    return { lifecycleState: facts.merged === true ? "merged" : "closed", isDraft: false };
  }
  return { lifecycleState: "open", isDraft: facts.draft === true };
}

function repoIdentityFromMetadata(
  metadata: Record<string, unknown> | null
): { repoOwner: string; repoName: string } | null {
  if (!metadata) return null;
  const { repoOwner, repoName } = metadata;
  return typeof repoOwner === "string" && typeof repoName === "string"
    ? { repoOwner, repoName }
    : null;
}

function equalsIgnoreCase(a: string | null | undefined, b: string): boolean {
  return typeof a === "string" && a.toLowerCase() === b.toLowerCase();
}

export async function processPullRequestLifecycleEvent(
  deps: PullRequestLifecycleDeps,
  event: GitHubAutomationEvent
): Promise<PullRequestLifecycleOutcome> {
  const facts = event.pullRequest;
  if (!facts) return "not_pull_request";
  // Agents push branches to the base repo (single-App model), so a fork
  // head is never an agent PR — even if the record lookup would match.
  if (facts.isCrossRepository === true) return "cross_repository";

  const status = deriveStatusFromFacts(facts);
  if (!status) return "no_state";

  const record = await deps.store.getByIdentity({
    repositoryExternalId: facts.repositoryExternalId,
    repoOwner: event.repoOwner,
    repoName: event.repoName,
    prNumber: facts.number,
  });

  if (record) {
    return applyToRecord(deps, event, facts, status, record);
  }
  return insertViaBranchFallback(deps, event, facts, status);
}

/** Hit path: guarded update of the existing record, then mirror to the DO. */
async function applyToRecord(
  deps: PullRequestLifecycleDeps,
  event: GitHubAutomationEvent,
  facts: GitHubPullRequestEventFacts,
  status: PullRequestStatus,
  record: SessionPullRequestRecord
): Promise<PullRequestLifecycleOutcome> {
  const snapshot: PullRequestSnapshot = {
    number: facts.number,
    url: facts.url ?? record.url,
    lifecycleState: status.lifecycleState,
    isDraft: status.isDraft,
    headBranch: event.branch ?? record.headBranch,
    baseBranch: event.targetBranch ?? record.baseBranch,
    headSha: facts.headSha ?? record.headSha ?? undefined,
    // The webhook carries the repository's current canonical location —
    // refreshes stored owner/name after a rename/transfer.
    repoOwner: event.repoOwner,
    repoName: event.repoName,
    repositoryExternalId: facts.repositoryExternalId ?? record.repositoryExternalId ?? undefined,
    providerUpdatedAt: facts.providerUpdatedAt ?? record.providerUpdatedAt ?? undefined,
  };

  const { applied } = await deps.store.upsert(
    snapshotToRecord(snapshot, {
      artifactId: record.artifactId,
      sessionId: record.sessionId,
      createdAt: record.createdAt,
      updatedAt: deps.now(),
    })
  );
  if (!applied) return "stale";

  await deps.pushSnapshotToSession(record.sessionId, record.artifactId, snapshot);
  return "updated";
}

/**
 * Miss path: derive the session from the branch convention, verify the
 * guards, and repair the missing record against the session's own DO `pr`
 * artifact (e.g. when the best-effort creation write failed).
 */
async function insertViaBranchFallback(
  deps: PullRequestLifecycleDeps,
  event: GitHubAutomationEvent,
  facts: GitHubPullRequestEventFacts,
  status: PullRequestStatus
): Promise<PullRequestLifecycleOutcome> {
  const sessionId = event.branch ? extractSessionIdFromBranch(event.branch) : null;
  if (!sessionId) return "no_branch_session";

  const associated = await deps.sessions.isRepositoryAssociated(
    sessionId,
    event.repoOwner,
    event.repoName
  );
  if (!associated) return "session_not_associated";

  const session = await deps.sessions.get(sessionId);
  const isPrimary =
    session !== null &&
    equalsIgnoreCase(session.repoOwner, event.repoOwner) &&
    equalsIgnoreCase(session.repoName, event.repoName);

  const artifacts = await deps.listSessionArtifacts(sessionId);
  const artifact = artifacts.find(
    (candidate) =>
      candidate.type === "pr" &&
      prArtifactBelongsToRepo(
        repoIdentityFromMetadata(candidate.metadata),
        { repoOwner: event.repoOwner, repoName: event.repoName },
        isPrimary
      )
  );
  if (!artifact) return "no_matching_artifact";

  // The record mirrors this specific artifact — a different PR number means
  // this webhook is not about the session's PR.
  const artifactNumber = artifact.metadata?.number;
  if (typeof artifactNumber === "number" && artifactNumber !== facts.number) {
    return "no_matching_artifact";
  }

  const url = facts.url ?? artifact.url;
  if (!url || !event.branch || !event.targetBranch) return "insufficient_payload";

  const now = deps.now();
  const snapshot: PullRequestSnapshot = {
    number: facts.number,
    url,
    lifecycleState: status.lifecycleState,
    isDraft: status.isDraft,
    headBranch: event.branch,
    baseBranch: event.targetBranch,
    headSha: facts.headSha,
    repoOwner: event.repoOwner,
    repoName: event.repoName,
    repositoryExternalId: facts.repositoryExternalId,
    providerUpdatedAt: facts.providerUpdatedAt,
  };

  await deps.store.upsert(
    snapshotToRecord(snapshot, {
      artifactId: artifact.id,
      sessionId,
      createdAt: now,
      updatedAt: now,
    })
  );

  await deps.pushSnapshotToSession(sessionId, artifact.id, snapshot);
  return "inserted";
}
