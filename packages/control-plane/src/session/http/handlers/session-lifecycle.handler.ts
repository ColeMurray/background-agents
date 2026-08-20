import type { Logger } from "../../../logger";
import type { ParticipantRow, SandboxRow, SessionRow } from "../../types";
import type { RepositoryRef } from "@open-inspect/shared/types/repositories";
import { getValidModelOrDefault, isValidModel } from "@open-inspect/shared/models";
import { normalizeSandboxSettings } from "../../../sandbox/settings";
import type {
  SandboxStatus,
  SessionStatus,
  SpawnSource,
} from "@open-inspect/shared/types/sessions";
import type { SessionCoreRepository } from "../../session-core-repository";
import type { SandboxRepository } from "../../sandbox-repository";
import type { MessageRepository } from "../../message-repository";
import type { ParticipantRepository } from "../../participant-repository";
import type { SessionStatusService } from "../../session-status-service";
import {
  normalizeSessionTitle,
  type SessionTitleUpdateOptions,
  type SessionTitleUpdateResult,
} from "../../title";
import { z } from "zod";

const TERMINAL_STATUSES = new Set<SessionStatus>(["completed", "archived", "cancelled", "failed"]);

export interface SessionLifecycleHandlerDeps {
  sessionCoreRepository: SessionCoreRepository;
  sandboxRepository: SandboxRepository;
  messageRepository: MessageRepository;
  participantRepository: ParticipantRepository;
  getDurableObjectId: () => string;
  tokenEncryptionKey?: string;
  encryptToken: (token: string, encryptionKey: string) => Promise<string>;
  validateReasoningEffort: (model: string, effort: string | undefined) => string | null;
  generateId: (bytes?: number) => string;
  now: () => number;
  scheduleWarmSandbox: () => void;
  getSession: () => SessionRow | null;
  getSandbox: () => SandboxRow | null;
  getPublicSessionId: (session: SessionRow) => string;
  getParticipantByUserId: (userId: string) => ParticipantRow | null;
  statusService: SessionStatusService;
  applySessionTitleUpdate: (
    title: string,
    options?: SessionTitleUpdateOptions
  ) => SessionTitleUpdateResult;
  cancelSession: () => Promise<void>;
  getSandboxSocket: () => WebSocket | null;
  sendToSandbox: (ws: WebSocket, message: string | object) => boolean;
  updateSandboxStatus: (status: SandboxStatus) => void;
}

function sessionTitleUpdateStatus(
  result: Extract<SessionTitleUpdateResult, { ok: false }>
): 400 | 404 | 409 {
  switch (result.reason) {
    case "invalid":
      return 400;
    case "not_found":
      return 404;
    case "already_set":
      return 409;
  }
}

export interface SessionLifecycleHandler {
  init: (request: Request, log: Logger) => Promise<Response>;
  getState: () => Response;
  updateTitle: (request: Request) => Promise<Response>;
  archive: (request: Request) => Promise<Response>;
  unarchive: (request: Request) => Promise<Response>;
  expireDraft: () => Promise<Response>;
  cancel: () => Promise<Response>;
}

const repositoryRefSchema = z.object({
  repoOwner: z.string(),
  repoName: z.string(),
  repoId: z.number(),
  baseBranch: z.string(),
}) satisfies z.ZodType<RepositoryRef>;

const spawnSourceSchema = z.enum([
  "user",
  "agent",
  "automation",
  "github-bot",
  "linear-bot",
  "slack-bot",
] satisfies [SpawnSource, ...SpawnSource[]]);

/**
 * Request body for the /internal/init endpoint.
 * The router constructs this from SessionInitInput — see session/initialize.ts.
 * Note: `userId` here is the participantUserId from SessionInitInput.
 */
const initRequestSchema = z.object({
  sessionName: z.string(),
  repoOwner: z.string().nullable(),
  repoName: z.string().nullable(),
  repoId: z.number().nullable().optional(),
  defaultBranch: z.string().nullable().optional(),
  branch: z.string().nullable().optional(),
  /**
   * Ordered member list ([0] = primary, matching the scalar fields).
   * initialize.ts always sends it for repository sessions (synthesizing a
   * one-entry list for scalar callers) and an empty list for repo-less ones.
   */
  repositories: z.array(repositoryRefSchema).optional(),
  /** Launch environment provenance; null for repo-launched/ad-hoc sessions. */
  environmentId: z.string().nullable().optional(),
  title: z.string().optional(),
  model: z.string().optional(),
  reasoningEffort: z.string().nullable().optional(),
  userId: z.string(),
  /** Canonical platform user ID for analytics attribution; null when unresolved. */
  canonicalUserId: z.string().nullable().optional(),
  scmLogin: z.string().nullable().optional(),
  scmName: z.string().nullable().optional(),
  scmEmail: z.string().nullable().optional(),
  scmToken: z.string().nullable().optional(),
  scmTokenEncrypted: z.string().nullable().optional(),
  scmRefreshTokenEncrypted: z.string().nullable().optional(),
  scmTokenExpiresAt: z.number().nullable().optional(),
  scmUserId: z.string().nullable().optional(),
  parentSessionId: z.string().nullable().optional(),
  spawnSource: spawnSourceSchema.optional(),
  spawnDepth: z.number().optional(),
  codeServerEnabled: z.boolean().optional(),
  vncEnabled: z.boolean().optional(),
  /**
   * Opaque here on purpose: `normalizeSandboxSettings` is the single boundary
   * validator for this blob (port ranges, collisions, timeout shape). Restating
   * the field list as a Zod object would silently strip any setting added to
   * SandboxSettings later, so the shape is validated at the use site instead.
   */
  sandboxSettings: z.unknown().optional(),
});

type InitRequest = z.infer<typeof initRequestSchema>;

const userIdBodySchema = z.object({
  userId: z.string().optional(),
});

type UserIdBody = z.infer<typeof userIdBodySchema>;

const titleUpdateBodySchema = z.object({
  userId: z.string().optional(),
  title: z.string().optional(),
});

type TitleUpdateBody = z.infer<typeof titleUpdateBodySchema>;

export function createSessionLifecycleHandler(
  deps: SessionLifecycleHandlerDeps
): SessionLifecycleHandler {
  return {
    async init(request: Request, log: Logger): Promise<Response> {
      let raw: unknown;
      try {
        raw = await request.json();
      } catch {
        return Response.json({ error: "Invalid request body" }, { status: 400 });
      }

      const parseResult = initRequestSchema.safeParse(raw);
      if (!parseResult.success) {
        return Response.json({ error: "Invalid request body" }, { status: 400 });
      }

      const body: InitRequest = parseResult.data;

      const sessionId = deps.getDurableObjectId();
      const sessionName = body.sessionName;
      const now = deps.now();
      const repoOwner = body.repoOwner?.trim() || null;
      const repoName = body.repoName?.trim() || null;
      const hasRepoOwner = repoOwner !== null;
      const hasRepoName = repoName !== null;
      const hasRepoId = body.repoId != null;
      if (
        hasRepoOwner !== hasRepoName ||
        (!hasRepoOwner && hasRepoId) ||
        (hasRepoOwner && !hasRepoId)
      ) {
        return Response.json(
          { error: "Repository context must include repoOwner, repoName, and repoId together" },
          { status: 400 }
        );
      }

      let encryptedToken = body.scmTokenEncrypted ?? null;
      if (body.scmToken && deps.tokenEncryptionKey) {
        try {
          encryptedToken = await deps.encryptToken(body.scmToken, deps.tokenEncryptionKey);
          log.debug("Encrypted SCM token for storage");
        } catch (error) {
          log.error("Failed to encrypt SCM token", {
            error: error instanceof Error ? error : String(error),
          });
        }
      }

      const model = getValidModelOrDefault(body.model);
      if (body.model && !isValidModel(body.model)) {
        log.warn("Invalid model name, using default", {
          requested_model: body.model,
          default_model: model,
        });
      }

      const reasoningEffort = deps.validateReasoningEffort(
        model,
        body.reasoningEffort ?? undefined
      );
      const baseBranch = hasRepoOwner ? body.branch || body.defaultBranch || "main" : null;

      const repositories = body.repositories ?? [];
      if (repositories.length > 0) {
        const primary = repositories[0];
        if (
          !hasRepoOwner ||
          primary.repoOwner !== repoOwner ||
          primary.repoName !== repoName ||
          primary.repoId !== body.repoId ||
          primary.baseBranch !== baseBranch
        ) {
          return Response.json(
            { error: "repositories[0] must match the scalar repository mirror" },
            { status: 400 }
          );
        }
      } else if (hasRepoOwner && body.repositories !== undefined) {
        // An explicit empty list alongside scalar context is a producer bug —
        // initialize.ts synthesizes a one-entry list for scalar callers.
        return Response.json(
          { error: "repositories must include the scalar repository" },
          { status: 400 }
        );
      }

      deps.sessionCoreRepository.transaction(() => {
        deps.sessionCoreRepository.upsertSession({
          id: sessionId,
          sessionName,
          title: body.title ?? null,
          repoOwner,
          repoName,
          repoId: hasRepoOwner ? body.repoId : null,
          baseBranch,
          model,
          reasoningEffort,
          status: "created",
          parentSessionId: body.parentSessionId ?? null,
          spawnSource: body.spawnSource ?? "user",
          spawnDepth: body.spawnDepth ?? 0,
          codeServerEnabled: body.codeServerEnabled ?? false,
          vncEnabled: body.vncEnabled ?? false,
          sandboxSettings: body.sandboxSettings
            ? JSON.stringify(normalizeSandboxSettings(body.sandboxSettings, { invalid: "omit" }))
            : null,
          environmentId: body.environmentId ?? null,
          createdAt: now,
          updatedAt: now,
        });

        // Legacy scalar producers (spawn paths not yet list-aware) still get a
        // member row so spawn/read paths have one source of truth.
        const memberRepositories: RepositoryRef[] =
          repositories.length > 0
            ? repositories
            : repoOwner !== null && repoName !== null && body.repoId != null && baseBranch !== null
              ? [{ repoOwner, repoName, repoId: body.repoId, baseBranch }]
              : [];
        deps.sessionCoreRepository.replaceSessionRepositories(
          memberRepositories.map((repo, position) => ({
            position,
            repoOwner: repo.repoOwner,
            repoName: repo.repoName,
            repoId: repo.repoId,
            baseBranch: repo.baseBranch,
          }))
        );
        const sandboxId = deps.generateId();
        deps.sandboxRepository.createSandbox({
          id: sandboxId,
          status: "pending",
          gitSyncStatus: "pending",
          createdAt: 0,
        });

        const participantId = deps.generateId();
        deps.participantRepository.createParticipant({
          id: participantId,
          userId: body.userId,
          ...(body.canonicalUserId ? { canonicalUserId: body.canonicalUserId } : {}),
          scmUserId: body.scmUserId ?? null,
          scmLogin: body.scmLogin ?? null,
          scmName: body.scmName ?? null,
          scmEmail: body.scmEmail ?? null,
          scmAccessTokenEncrypted: encryptedToken,
          scmRefreshTokenEncrypted: body.scmRefreshTokenEncrypted ?? null,
          scmTokenExpiresAt: body.scmTokenExpiresAt ?? null,
          role: "owner",
          joinedAt: now,
        });
      });

      log.info("Triggering sandbox spawn for new session");
      deps.scheduleWarmSandbox();

      return Response.json({ sessionId, status: "created" });
    },

    getState(): Response {
      const session = deps.getSession();
      if (!session) {
        return new Response("Session not found", { status: 404 });
      }

      const sandbox = deps.getSandbox();

      return Response.json({
        id: deps.getPublicSessionId(session),
        title: session.title,
        repoOwner: session.repo_owner,
        repoName: session.repo_name,
        baseBranch: session.base_branch,
        branchName: session.branch_name,
        baseSha: session.base_sha,
        currentSha: session.current_sha,
        opencodeSessionId: session.opencode_session_id,
        status: session.status,
        model: session.model,
        reasoningEffort: session.reasoning_effort ?? undefined,
        createdAt: session.created_at,
        updatedAt: session.updated_at,
        sandbox: sandbox
          ? {
              id: sandbox.id,
              modalSandboxId: sandbox.modal_sandbox_id,
              status: sandbox.status,
              gitSyncStatus: sandbox.git_sync_status,
              lastHeartbeat: sandbox.last_heartbeat,
            }
          : null,
      });
    },

    async updateTitle(request: Request): Promise<Response> {
      const session = deps.getSession();
      if (!session) {
        return Response.json({ error: "Session not found" }, { status: 404 });
      }

      let raw: unknown;
      try {
        raw = await request.json();
      } catch {
        return Response.json({ error: "Invalid request body" }, { status: 400 });
      }

      const parseResult = titleUpdateBodySchema.safeParse(raw);
      if (!parseResult.success) {
        return Response.json({ error: "Invalid request body" }, { status: 400 });
      }

      const body: TitleUpdateBody = parseResult.data;

      if (!body.userId) {
        return Response.json({ error: "userId is required" }, { status: 400 });
      }

      const normalizedTitle = normalizeSessionTitle(body.title);
      if (!normalizedTitle.ok) {
        return Response.json({ error: normalizedTitle.error }, { status: 400 });
      }

      const participant = deps.getParticipantByUserId(body.userId);
      if (!participant) {
        return Response.json(
          { error: "Not authorized to update the session title" },
          { status: 403 }
        );
      }

      const result = deps.applySessionTitleUpdate(normalizedTitle.title, { onlyIfUnset: false });
      if (!result.ok) {
        return Response.json({ error: result.error }, { status: sessionTitleUpdateStatus(result) });
      }

      return Response.json({ title: result.title });
    },

    async archive(request: Request): Promise<Response> {
      const session = deps.getSession();
      if (!session) {
        return Response.json({ error: "Session not found" }, { status: 404 });
      }

      let body: UserIdBody;
      try {
        const result = userIdBodySchema.safeParse(await request.json());
        if (!result.success) {
          return Response.json({ error: "Invalid request body" }, { status: 400 });
        }
        body = result.data;
      } catch {
        return Response.json({ error: "Invalid request body" }, { status: 400 });
      }

      if (!body.userId) {
        return Response.json({ error: "userId is required" }, { status: 400 });
      }

      const participant = deps.getParticipantByUserId(body.userId);
      if (!participant) {
        return Response.json({ error: "Not authorized to archive this session" }, { status: 403 });
      }

      if (session.status === "cancelled") {
        return Response.json({ error: "Cancelled sessions cannot be archived" }, { status: 409 });
      }

      if (deps.messageRepository.getPendingOrProcessingCount() > 0) {
        return Response.json(
          { error: "Cannot archive a session with queued work" },
          { status: 409 }
        );
      }

      await deps.statusService.transition("archived");

      return Response.json({ status: "archived" });
    },

    /**
     * Retire a warm session that never received a prompt.
     *
     * The web client warms a session on the first keystroke, so navigating away
     * without submitting leaves a `created` row whose sandbox idles out — and no
     * other transition reaches it, because `active` needs an enqueued prompt and
     * the terminal statuses need a finished execution.
     *
     * The sweep selects candidates from the D1 index, which it may have read
     * before a prompt arrived. Re-checking here is what makes that safe: the
     * Durable Object is the authority on the session's own state and runs
     * single-threaded, so a session that started work in the meantime is left
     * alone rather than archived out from under its author.
     */
    async expireDraft(): Promise<Response> {
      const session = deps.getSession();
      if (!session) {
        return Response.json({ error: "Session not found" }, { status: 404 });
      }

      if (session.status !== "created") {
        // Reaching here means the index still reads `created` while this session
        // has moved on — which is exactly what happens when an earlier
        // transition's D1 projection failed (they are logged and swallowed).
        // Repairing the mirror is what stops the row being selected instead of
        // being retried every sweep forever.
        await deps.statusService.repairIndexStatus();
        return Response.json({ outcome: "not_draft", status: session.status });
      }

      if (
        deps.messageRepository.getPendingOrProcessingCount() > 0 ||
        deps.messageRepository.getMessageCount() > 0
      ) {
        // A session holding messages while still `created` is a broken aggregate:
        // enqueueing a prompt inserts the message and transitions to `active` in
        // the same Durable Object turn, so current code cannot produce this. It
        // survives only on rows predating that guarantee, and answering without
        // changing anything is what let them pin the head of the sweep's
        // oldest-first batch forever. Settle the status to what the messages say
        // instead. A queued prompt is left for the dispatch timeout rather than
        // archived: archiving discards a real request, and `archived` is not
        // promptable, so the author could not resume it either.
        const settled = await deps.statusService.settleFromMessageState();
        return Response.json({ outcome: "has_work", status: settled });
      }

      await deps.statusService.transition("archived");

      return Response.json({ outcome: "archived", status: "archived" });
    },

    async unarchive(request: Request): Promise<Response> {
      const session = deps.getSession();
      if (!session) {
        return Response.json({ error: "Session not found" }, { status: 404 });
      }

      let body: UserIdBody;
      try {
        const result = userIdBodySchema.safeParse(await request.json());
        if (!result.success) {
          return Response.json({ error: "Invalid request body" }, { status: 400 });
        }
        body = result.data;
      } catch {
        return Response.json({ error: "Invalid request body" }, { status: 400 });
      }

      if (!body.userId) {
        return Response.json({ error: "userId is required" }, { status: 400 });
      }

      const participant = deps.getParticipantByUserId(body.userId);
      if (!participant) {
        return Response.json(
          { error: "Not authorized to unarchive this session" },
          { status: 403 }
        );
      }

      if (session.status !== "archived") {
        return Response.json({ error: "Session is not archived" }, { status: 409 });
      }

      await deps.statusService.transition("active");

      return Response.json({ status: "active" });
    },

    async cancel(): Promise<Response> {
      const session = deps.getSession();
      if (!session) {
        return Response.json({ error: "Session not found" }, { status: 404 });
      }

      if (TERMINAL_STATUSES.has(session.status)) {
        return Response.json({ error: `Session already ${session.status}` }, { status: 409 });
      }

      await deps.cancelSession();

      const sandbox = deps.getSandbox();
      if (sandbox && sandbox.status !== "stopped" && sandbox.status !== "failed") {
        const sandboxWs = deps.getSandboxSocket();
        if (sandboxWs) {
          deps.sendToSandbox(sandboxWs, { type: "shutdown" });
        }
        deps.updateSandboxStatus("stopped");
      }

      return Response.json({ status: "cancelled" });
    },
  };
}
