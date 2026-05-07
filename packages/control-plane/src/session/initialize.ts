import type { Env } from "../types";
import type { RequestContext } from "../routes/shared";
import type { SpawnSource, SandboxSettings } from "@open-inspect/shared";
import { SessionIndexStore } from "../db/session-index";
import { buildSessionInternalUrl, SessionInternalPaths } from "./contracts";
import { createLogger } from "../logger";

const logger = createLogger("session-init");

/**
 * All data needed to initialize a new session (create or spawn).
 * Shared between the router and the DO init handler to prevent type drift.
 */
export interface SessionInitInput {
  sessionId: string;

  // Repository
  repoOwner: string;
  repoName: string;
  repoId?: number | null;
  defaultBranch?: string;
  branch?: string;

  // Session config
  title?: string;
  model: string;
  reasoningEffort: string | null;
  codeServerEnabled?: boolean;
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
  const now = Date.now();

  // Step 1: D1 index (must succeed before DO init starts sandbox warming)
  const sessionStore = new SessionIndexStore(env.DB);
  await sessionStore.create({
    id: input.sessionId,
    title: input.title || null,
    repoOwner: input.repoOwner,
    repoName: input.repoName,
    model: input.model,
    reasoningEffort: input.reasoningEffort,
    baseBranch: input.branch || input.defaultBranch || "main",
    status: "created",
    parentSessionId: input.parentSessionId,
    spawnSource: input.spawnSource,
    spawnDepth: input.spawnDepth,
    scmLogin: input.scmLogin || null,
    userId: input.platformUserId,
    createdAt: now,
    updatedAt: now,
  });

  // Step 2: DO init
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
          defaultBranch: input.defaultBranch,
          branch: input.branch,
          title: input.title,
          model: input.model,
          reasoningEffort: input.reasoningEffort,
          userId: input.participantUserId,
          scmLogin: input.scmLogin,
          scmName: input.scmName,
          scmEmail: input.scmEmail,
          scmTokenEncrypted: input.scmTokenEncrypted,
          scmRefreshTokenEncrypted: input.scmRefreshTokenEncrypted,
          scmTokenExpiresAt: input.scmTokenExpiresAt,
          scmUserId: input.scmUserId,
          codeServerEnabled: input.codeServerEnabled,
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
