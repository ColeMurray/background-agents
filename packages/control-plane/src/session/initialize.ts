import type { Env } from "../types";
import type { RequestContext } from "../routes/shared";
import type { SpawnSource } from "@open-inspect/shared/types/sessions";
import type { RepositoryRef } from "@open-inspect/shared/types/repositories";
import type { SandboxSettings } from "@open-inspect/shared/types/integrations";
import { SessionIndexStore } from "../db/session-index";
import { buildSessionInternalUrl, SessionInternalPaths } from "./contracts";
import { createLogger } from "../logger";

const logger = createLogger("session-init");

function hasBranchContext(value: string | null | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Thrown when a GitHub-review session-create fence loses the race: a newer
 * claim already moved `github_review_state.latest_generation` past the
 * generation this create was fenced on. The caller (routes/session-create.ts)
 * maps this to a 409 without creating any D1 session row or DO.
 */
export class ReviewGenerationSupersededError extends Error {
  constructor() {
    super("review generation superseded");
    this.name = "ReviewGenerationSupersededError";
  }
}

/**
 * All data needed to initialize a new session (create or spawn).
 * Shared between the router and the DO init handler to prevent type drift.
 */
export interface SessionInitInput {
  sessionId: string;

  // Repository
  repoOwner: string | null;
  repoName: string | null;
  repoId?: number | null;
  defaultBranch?: string | null;
  branch?: string | null;
  /**
   * Ordered member list for multi-repo sessions ([0] = primary, which must
   * match the scalar mirror above). Absent/empty for scalar callers — a
   * one-entry list is synthesized from the scalar fields.
   */
  repositories?: RepositoryRef[];
  /**
   * The environment this session was launched from (design §7.6). Null for
   * repo-launched/ad-hoc sessions. Recorded as provenance; the members are
   * already snapshotted into `repositories`.
   */
  environmentId?: string | null;

  // Session config
  title?: string;
  model: string;
  reasoningEffort: string | null;
  codeServerEnabled?: boolean;
  vncEnabled?: boolean;
  sandboxSettings?: SandboxSettings;

  // Identity
  /** Participant identity for the session creator — becomes the owner participant's user_id in the DO. */
  participantUserId: string;
  /** Canonical platform user ID for D1 analytics attribution. Null when unresolved. */
  platformUserId: string | null;

  // SCM credentials
  scmLogin?: string | null;
  scmName?: string | null;
  scmEmail?: string | null;
  scmUserId?: string | null;
  scmTokenEncrypted: string | null;
  scmRefreshTokenEncrypted: string | null;
  scmTokenExpiresAt?: number | null;

  // Lineage
  parentSessionId?: string | null;
  spawnSource?: SpawnSource;
  spawnDepth?: number;
  automationId?: string | null;
  automationRunId?: string | null;

  // GitHub review-generation fence (design: review-supersede). Present only
  // for github-bot-created review sessions; routes/session-create.ts rejects
  // it from any other caller.
  githubReview?: {
    repoId: number;
    prNumber: number;
    generation: number;
    headSha: string;
  };
}

/**
 * Initialize a new session: write D1 index first, then initialize the DO.
 *
 * D1 is written first so that failures are caught before any sandbox is spawned.
 * This ordering is an invariant that both create and spawn must respect.
 *
 * @throws if D1 write or DO init fails
 */
export async function initializeSession(
  env: Env,
  input: SessionInitInput,
  ctx: RequestContext
): Promise<{ sessionId: string; status: string }> {
  const hasRepoOwner = input.repoOwner !== null;
  const hasRepoName = input.repoName !== null;
  const hasRepoId = input.repoId != null;
  if (
    hasRepoOwner !== hasRepoName ||
    (!hasRepoOwner && hasRepoId) ||
    (hasRepoOwner && !hasRepoId)
  ) {
    throw new Error("Repository context must include repoOwner, repoName, and repoId together");
  }
  if (!hasRepoOwner && (hasBranchContext(input.branch) || hasBranchContext(input.defaultBranch))) {
    throw new Error("No-repository sessions must not include branch context");
  }
  const branch = hasRepoOwner ? input.branch : null;
  const defaultBranch = hasRepoOwner ? input.defaultBranch : null;

  const now = Date.now();
  const baseBranch = hasRepoOwner ? branch || defaultBranch || "main" : null;

  if (input.repositories?.length) {
    const primary = input.repositories[0];
    if (
      primary.repoOwner !== input.repoOwner ||
      primary.repoName !== input.repoName ||
      primary.repoId !== input.repoId ||
      primary.baseBranch !== baseBranch
    ) {
      throw new Error("repositories[0] must match the scalar repository mirror");
    }
  }
  const repositories: RepositoryRef[] = input.repositories?.length
    ? input.repositories
    : hasRepoOwner && input.repoOwner && input.repoName && input.repoId != null && baseBranch
      ? [
          {
            repoOwner: input.repoOwner,
            repoName: input.repoName,
            repoId: input.repoId,
            baseBranch,
          },
        ]
      : [];

  // Step 1: GitHub review-generation fence. Runs before the D1 session row
  // and DO exist at all — a stale generation here means a newer review
  // already claimed this PR, so this create must leave no trace. Run as its
  // own statement rather than batched with the session insert below (D1
  // batch would work, but sessionStore.create() already owns its own
  // multi-statement batch and threading a foreign statement through it would
  // obscure that boundary for one call site); on a later init failure the
  // orphaned review row is swept by the next claim's sweep (404 rule).
  if (input.githubReview) {
    const { repoId, prNumber, generation, headSha } = input.githubReview;
    const fenceResult = await ctx.db
      .prepare(
        `INSERT INTO github_review_sessions (repo_id, pr_number, generation, session_id, head_sha, created_at)
         SELECT ?, ?, ?, ?, ?, ? FROM github_review_state
         WHERE repo_id = ? AND pr_number = ? AND latest_generation = ?`
      )
      .bind(
        repoId,
        prNumber,
        generation,
        input.sessionId,
        headSha,
        now,
        repoId,
        prNumber,
        generation
      )
      .run();
    if ((fenceResult.meta?.changes ?? 0) === 0) {
      throw new ReviewGenerationSupersededError();
    }
  }

  // Step 2: D1 index (must succeed before DO init starts sandbox warming)
  const sessionStore = new SessionIndexStore(ctx.db);
  await sessionStore.create({
    id: input.sessionId,
    title: input.title || null,
    repoOwner: input.repoOwner,
    repoName: input.repoName,
    model: input.model,
    reasoningEffort: input.reasoningEffort,
    baseBranch,
    repositories,
    environmentId: input.environmentId ?? null,
    status: "created",
    parentSessionId: input.parentSessionId,
    spawnSource: input.spawnSource,
    spawnDepth: input.spawnDepth,
    automationId: input.automationId,
    automationRunId: input.automationRunId,
    scmLogin: input.scmLogin || null,
    userId: input.platformUserId,
    createdAt: now,
    updatedAt: now,
  });

  // Step 3: DO init
  const doId = env.SESSION.idFromName(input.sessionId);
  const stub = env.SESSION.get(doId);

  const headers = new Headers({
    "Content-Type": "application/json",
  });
  headers.set("x-trace-id", ctx.trace_id);
  headers.set("x-request-id", ctx.request_id);

  let initResponse: Response;
  try {
    initResponse = await stub.fetch(
      new Request(buildSessionInternalUrl(SessionInternalPaths.init), {
        method: "POST",
        headers,
        body: JSON.stringify({
          sessionName: input.sessionId,
          repoOwner: input.repoOwner,
          repoName: input.repoName,
          repoId: input.repoId,
          defaultBranch,
          branch,
          repositories,
          environmentId: input.environmentId ?? null,
          title: input.title,
          model: input.model,
          reasoningEffort: input.reasoningEffort,
          userId: input.participantUserId,
          canonicalUserId: input.platformUserId,
          scmLogin: input.scmLogin,
          scmName: input.scmName,
          scmEmail: input.scmEmail,
          scmTokenEncrypted: input.scmTokenEncrypted,
          scmRefreshTokenEncrypted: input.scmRefreshTokenEncrypted,
          scmTokenExpiresAt: input.scmTokenExpiresAt,
          scmUserId: input.scmUserId,
          codeServerEnabled: input.codeServerEnabled,
          vncEnabled: input.vncEnabled,
          sandboxSettings: input.sandboxSettings,
          parentSessionId: input.parentSessionId,
          spawnSource: input.spawnSource,
          spawnDepth: input.spawnDepth,
        }),
      })
    );
  } catch (transportError) {
    await markSessionFailed(sessionStore, input.sessionId, ctx.trace_id);
    throw transportError;
  }

  if (!initResponse.ok) {
    await markSessionFailed(sessionStore, input.sessionId, ctx.trace_id);
    const errorText = await initResponse.text().catch(() => "unknown");
    logger.error("DO init failed", {
      session_id: input.sessionId,
      status: initResponse.status,
      error: errorText,
      trace_id: ctx.trace_id,
    });
    throw new Error(`Failed to initialize session DO: ${initResponse.status}`);
  }

  // Step 4: re-verify the review generation now that the DO exists. Between
  // the fence insert (Step 1) and DO init (Step 3), a newer generation's
  // sweep may have hit this session's not-yet-initialized DO, received a
  // 404, and deleted our fence row as an orphan — leaving this session live
  // but invisible to every future sweep. Re-checking after init closes that
  // window: either the sweep arrived post-init (its cancel landed on a live
  // DO), or we observe the newer generation here and tear ourselves down.
  if (input.githubReview) {
    const { repoId, prNumber, generation } = input.githubReview;
    const state = await ctx.db
      .prepare(
        "SELECT latest_generation FROM github_review_state WHERE repo_id = ? AND pr_number = ?"
      )
      .bind(repoId, prNumber)
      .first<{ latest_generation: number }>();
    if (!state || state.latest_generation !== generation) {
      // Delete our fence row only after a confirmed-terminal cancel
      // (2xx / 409 already-terminal). On any other outcome retain the row —
      // it is the only pointer a future sweep has to this session. If the
      // newer generation's sweep already 404-deleted the row AND this cancel
      // fails, the session leaks until its sandbox timeout: log it loudly.
      let cancelConfirmed = false;
      try {
        const cancelResponse = await stub.fetch(
          new Request(buildSessionInternalUrl(SessionInternalPaths.cancel), {
            method: "POST",
            headers,
          })
        );
        cancelConfirmed = cancelResponse.ok || cancelResponse.status === 409;
      } catch {
        cancelConfirmed = false;
      }
      if (cancelConfirmed) {
        await ctx.db
          .prepare(
            "DELETE FROM github_review_sessions WHERE repo_id = ? AND pr_number = ? AND generation = ?"
          )
          .bind(repoId, prNumber, generation)
          .run();
      } else {
        logger.error("Superseded review session teardown failed; possible leak", {
          event: "review_supersede.leak",
          session_id: input.sessionId,
          repo_id: repoId,
          pr_number: prNumber,
          generation,
          trace_id: ctx.trace_id,
        });
      }
      throw new ReviewGenerationSupersededError();
    }
  }

  return { sessionId: input.sessionId, status: "created" };
}

/**
 * Best-effort compensation: mark the D1 session row as failed so it
 * doesn't appear as a phantom "created" session in listings.
 */
async function markSessionFailed(
  sessionStore: SessionIndexStore,
  sessionId: string,
  traceId: string
): Promise<void> {
  try {
    await sessionStore.updateStatus(sessionId, "failed");
  } catch (compensationError) {
    logger.error("Failed to mark session as failed after DO init error", {
      session_id: sessionId,
      trace_id: traceId,
      error:
        compensationError instanceof Error ? compensationError.message : String(compensationError),
    });
  }
}
