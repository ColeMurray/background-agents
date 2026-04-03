import type { Logger } from "../../../logger";
import type { ParticipantRow, SandboxRow, SessionRow } from "../../types";
import type { SandboxStatus, ServerMessage, SessionStatus, SpawnSource } from "../../../types";
import type { SessionRepository } from "../../repository";
import { getValidModelOrDefault, isValidModel } from "../../../utils/models";

const TERMINAL_STATUSES = new Set<SessionStatus>(["completed", "archived", "cancelled", "failed"]);

interface InitRequest {
  sessionName: string;
  repoOwner: string;
  repoName: string;
  repoId?: number;
  defaultBranch?: string;
  branch?: string;
  title?: string;
  model?: string;
  reasoningEffort?: string;
  userId: string;
  scmLogin?: string;
  scmName?: string;
  scmEmail?: string;
  scmToken?: string | null;
  scmTokenEncrypted?: string | null;
  scmRefreshTokenEncrypted?: string | null;
  scmTokenExpiresAt?: number | null;
  scmUserId?: string | null;
  parentSessionId?: string | null;
  spawnSource?: SpawnSource;
  spawnDepth?: number;
  codeServerEnabled?: boolean;
  sandboxSettings?: Record<string, unknown>;
}

export interface SessionLifecycleHandlerDeps {
  repository: Pick<
    SessionRepository,
    "upsertSession" | "createSandbox" | "createParticipant" | "updateSessionTitle"
  >;
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
  stopExecution: (options?: { suppressStatusReconcile?: boolean }) => Promise<void>;
  getSandboxSocket: () => WebSocket | null;
  sendToSandbox: (ws: WebSocket, message: string | object) => boolean;
  updateSandboxStatus: (status: SandboxStatus) => void;
  broadcast: (message: ServerMessage) => void;
}

export interface SessionLifecycleHandler {
  init: (request: Request) => Promise<Response>;
  getState: () => Response;
  updateTitle: (request: Request) => Promise<Response>;
  archive: (request: Request) => Promise<Response>;
  unarchive: (request: Request) => Promise<Response>;
  cancel: () => Promise<Response>;
}

function parseUserIdBody(body: unknown): { userId?: string } {
  return body as { userId?: string };
}

export function createSessionLifecycleHandler(
  deps: SessionLifecycleHandlerDeps
): SessionLifecycleHandler {
  return {
    async init(request: Request): Promise<Response> {
      const body = (await request.json()) as InitRequest;

      const sessionId = deps.getDurableObjectId();
      const sessionName = body.sessionName;
      const now = deps.now();

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
      const baseBranch = body.branch || body.defaultBranch || "main";

      deps.repository.upsertSession({
        id: sessionId,
        sessionName,
        title: body.title ?? null,
        repoOwner: body.repoOwner,
        repoName: body.repoName,
        repoId: body.repoId ?? null,
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

      let body: { userId?: string; title?: string };
      try {
        body = (await request.json()) as { userId?: string; title?: string };
      } catch {
        return Response.json({ error: "Invalid request body" }, { status: 400 });
      }

      if (!body.userId) {
        return Response.json({ error: "userId is required" }, { status: 400 });
      }

      if (typeof body.title !== "string" || body.title.trim().length === 0) {
        return Response.json({ error: "title must be a non-empty string" }, { status: 400 });
      }

      if (body.title.length > 200) {
        return Response.json({ error: "title must be 200 characters or fewer" }, { status: 400 });
      }

      const participant = deps.getParticipantByUserId(body.userId);
      if (!participant) {
        return Response.json(
          { error: "Not authorized to update the session title" },
          { status: 403 }
        );
      }

      deps.repository.updateSessionTitle(session.id, body.title, deps.now());

      deps.broadcast({
        type: "session_title",
        title: body.title,
      });

      return Response.json({ title: body.title });
    },

    async archive(request: Request): Promise<Response> {
      const session = deps.getSession();
      if (!session) {
        return Response.json({ error: "Session not found" }, { status: 404 });
      }

      let body: { userId?: string };
      try {
        body = parseUserIdBody(await request.json());
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
        body = parseUserIdBody(await request.json());
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
