import type { Logger } from "../../../logger";
import type { ParticipantRow, SandboxRow, SessionRow } from "../../types";
import { getValidModelOrDefault, isValidModel } from "@open-inspect/shared";
import type { SandboxStatus, SessionStatus } from "../../../types";
import type { SessionRepository } from "../../repository";
import {
  normalizeSessionTitle,
  type SessionTitleUpdateOptions,
  type SessionTitleUpdateResult,
} from "../../title";
import { z } from "zod";

const TERMINAL_STATUSES = new Set<SessionStatus>(["completed", "archived", "cancelled", "failed"]);

/**
 * Request body for the /internal/init endpoint.
 * The router constructs this from SessionInitInput — see session/initialize.ts.
 * Note: `userId` here is the participantUserId from SessionInitInput.
 */
const nullableString = z.string().nullable().optional();

const spawnSourceSchema = z.enum([
  "user",
  "agent",
  "automation",
  "github-bot",
  "linear-bot",
  "slack-bot",
]);

const initRequestSchema = z.object({
  sessionName: z.string(),
  repoOwner: z.string().nullable(),
  repoName: z.string().nullable(),
  repoId: z.number().nullable().optional(),
  defaultBranch: nullableString,
  branch: nullableString,
  title: nullableString,
  model: z.string().optional(),
  reasoningEffort: z.string().optional(),
  userId: z.string(),
  scmLogin: nullableString,
  scmName: nullableString,
  scmEmail: nullableString,
  scmToken: nullableString,
  scmTokenEncrypted: nullableString,
  scmRefreshTokenEncrypted: nullableString,
  scmTokenExpiresAt: z.number().nullable().optional(),
  scmUserId: nullableString,
  parentSessionId: nullableString,
  spawnSource: spawnSourceSchema.optional(),
  spawnDepth: z.number().optional(),
  codeServerEnabled: z.boolean().optional(),
  sandboxSettings: z.record(z.string(), z.unknown()).optional(),
});

type InitRequest = z.infer<typeof initRequestSchema>;

const updateTitleRequestSchema = z.object({
  userId: z.string().optional(),
  title: z.unknown().optional(),
});

const userIdRequestSchema = z.object({
  userId: z.string().optional(),
});

export interface SessionLifecycleHandlerDeps {
  repository: Pick<SessionRepository, "upsertSession" | "createSandbox" | "createParticipant">;
  getDurableObjectId: () => string;
  tokenEncryptionKey?: string;
  encryptToken: (token: string, encryptionKey: string) => Promise<string>;
  validateReasoningEffort: (model: string, effort: string | undefined) => string | null;
  generateId: (bytes?: number) => string;
  now: () => number;
  scheduleWarmSandbox: () => void;
  getLog: () => Logger;
  getSession: () => SessionRow | null;
  getSandbox: () => SandboxRow | null;
  getPublicSessionId: (session: SessionRow) => string;
  getParticipantByUserId: (userId: string) => ParticipantRow | null;
  transitionSessionStatus: (status: SessionStatus) => Promise<boolean>;
  applySessionTitleUpdate: (
    title: string,
    options?: SessionTitleUpdateOptions
  ) => SessionTitleUpdateResult;
  stopExecution: (options?: { suppressStatusReconcile?: boolean }) => Promise<void>;
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
  init: (request: Request) => Promise<Response>;
  getState: () => Response;
  updateTitle: (request: Request) => Promise<Response>;
  archive: (request: Request) => Promise<Response>;
  unarchive: (request: Request) => Promise<Response>;
  cancel: () => Promise<Response>;
}

function parseUserIdBody(body: unknown): { userId?: string } | null {
  const parsed = userIdRequestSchema.safeParse(body);
  return parsed.success ? parsed.data : null;
}

export function createSessionLifecycleHandler(
  deps: SessionLifecycleHandlerDeps
): SessionLifecycleHandler {
  return {
    async init(request: Request): Promise<Response> {
      let raw: unknown;
      try {
        raw = await request.json();
      } catch {
        return Response.json({ error: "Invalid request body" }, { status: 400 });
      }

      const parsed = initRequestSchema.safeParse(raw);
      if (!parsed.success) {
        return Response.json({ error: "Invalid request body" }, { status: 400 });
      }
      const body: InitRequest = parsed.data;

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
          deps.getLog().debug("Encrypted SCM token for storage");
        } catch (error) {
          deps.getLog().error("Failed to encrypt SCM token", {
            error: error instanceof Error ? error : String(error),
          });
        }
      }

      const model = getValidModelOrDefault(body.model);
      if (body.model && !isValidModel(body.model)) {
        deps.getLog().warn("Invalid model name, using default", {
          requested_model: body.model,
          default_model: model,
        });
      }

      const reasoningEffort = deps.validateReasoningEffort(model, body.reasoningEffort);
      const baseBranch = hasRepoOwner ? body.branch || body.defaultBranch || "main" : null;

      deps.repository.upsertSession({
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
        sandboxSettings: body.sandboxSettings ? JSON.stringify(body.sandboxSettings) : null,
        createdAt: now,
        updatedAt: now,
      });

      const sandboxId = deps.generateId();
      deps.repository.createSandbox({
        id: sandboxId,
        status: "pending",
        gitSyncStatus: "pending",
        createdAt: 0,
      });

      const participantId = deps.generateId();
      deps.repository.createParticipant({
        id: participantId,
        userId: body.userId,
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

      deps.getLog().info("Triggering sandbox spawn for new session");
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

      let body: z.infer<typeof updateTitleRequestSchema>;
      try {
        const parsed = updateTitleRequestSchema.safeParse(await request.json());
        if (!parsed.success) {
          return Response.json({ error: "Invalid request body" }, { status: 400 });
        }
        body = parsed.data;
      } catch {
        return Response.json({ error: "Invalid request body" }, { status: 400 });
      }

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

      let body: { userId?: string };
      try {
        body = parseUserIdBody(await request.json()) ?? {};
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

      await deps.transitionSessionStatus("archived");

      return Response.json({ status: "archived" });
    },

    async unarchive(request: Request): Promise<Response> {
      const session = deps.getSession();
      if (!session) {
        return Response.json({ error: "Session not found" }, { status: 404 });
      }

      let body: { userId?: string };
      try {
        body = parseUserIdBody(await request.json()) ?? {};
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

      await deps.transitionSessionStatus("active");

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

      await deps.stopExecution({ suppressStatusReconcile: true });
      await deps.transitionSessionStatus("cancelled");

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
