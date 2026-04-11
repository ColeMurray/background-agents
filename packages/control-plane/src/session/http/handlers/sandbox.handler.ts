import type { Logger } from "../../../logger";
import type { ParticipantRole, SandboxEvent, ServerMessage } from "../../../types";
import type { OpenAITokenRefreshResult } from "../../openai-token-refresh-service";
import type { SessionRepository } from "../../repository";
import { buildSessionArtifact } from "../../artifacts";
import type { SandboxRow, SessionRow } from "../../types";
import { assertArtifactType } from "../../artifacts";

interface AddParticipantRequest {
  userId: string;
  scmLogin?: string;
  scmName?: string;
  scmEmail?: string;
  role?: string;
}

export interface SandboxHandlerDeps {
  repository: Pick<
    SessionRepository,
    "createParticipant" | "createArtifact" | "createEvent" | "getProcessingMessage"
  >;
  processSandboxEvent: (event: SandboxEvent) => Promise<void>;
  getSandbox: () => SandboxRow | null;
  isValidSandboxToken: (token: string | null, sandbox: SandboxRow | null) => Promise<boolean>;
  getSession: () => SessionRow | null;
  refreshOpenAIToken: (session: SessionRow) => Promise<OpenAITokenRefreshResult>;
  isOpenAISecretsConfigured: () => boolean;
  broadcast: (message: ServerMessage) => void;
  generateId: () => string;
  now: () => number;
  getLog: () => Logger;
}

interface CreateMediaArtifactRequest {
  artifactId: string;
  artifactType: string;
  objectKey: string;
  metadata?: Record<string, unknown>;
  messageId: string;
}

export interface SandboxHandler {
  sandboxEvent: (request: Request) => Promise<Response>;
  createMediaArtifact: (request: Request) => Promise<Response>;
  addParticipant: (request: Request) => Promise<Response>;
  verifySandboxToken: (request: Request) => Promise<Response>;
  openaiTokenRefresh: () => Promise<Response>;
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export function createSandboxHandler(deps: SandboxHandlerDeps): SandboxHandler {
  return {
    async sandboxEvent(request: Request): Promise<Response> {
      const event = (await request.json()) as SandboxEvent;
      await deps.processSandboxEvent(event);
      return Response.json({ status: "ok" });
    },

    async createMediaArtifact(request: Request): Promise<Response> {
      const body = (await request.json()) as CreateMediaArtifactRequest;
      const sandbox = deps.getSandbox();
      if (!sandbox) {
        return jsonResponse({ error: "No sandbox" }, 404);
      }

      if (!body.artifactId || !body.objectKey || !body.messageId) {
        return jsonResponse({ error: "artifactId, objectKey, and messageId are required" }, 400);
      }

      const processingMessage = deps.repository.getProcessingMessage();
      if (!processingMessage || processingMessage.id !== body.messageId) {
        return jsonResponse({ error: "messageId must match the active prompt" }, 409);
      }

      const artifactType = assertArtifactType(body.artifactType);
      const now = deps.now();
      const timestamp = now / 1000;
      const artifact = buildSessionArtifact({
        id: body.artifactId,
        type: artifactType,
        url: body.objectKey,
        metadata: body.metadata ?? null,
        createdAt: now,
      });

      deps.repository.createArtifact({
        id: artifact.id,
        type: artifact.type,
        url: artifact.url,
        metadata: artifact.metadata ? JSON.stringify(artifact.metadata) : null,
        createdAt: now,
      });

      const event: Extract<SandboxEvent, { type: "artifact" }> = {
        type: "artifact",
        artifactType: artifact.type,
        artifactId: artifact.id,
        url: body.objectKey,
        metadata: artifact.metadata ?? undefined,
        messageId: body.messageId,
        sandboxId: sandbox.modal_sandbox_id ?? sandbox.id,
        timestamp,
      };

      deps.repository.createEvent({
        id: deps.generateId(),
        type: event.type,
        data: JSON.stringify(event),
        messageId: body.messageId,
        createdAt: now,
      });

      deps.broadcast({ type: "artifact_created", artifact });
      deps.broadcast({ type: "sandbox_event", event });

      return Response.json({ status: "ok", artifactId: artifact.id });
    },

    async addParticipant(request: Request): Promise<Response> {
      const body = (await request.json()) as AddParticipantRequest;

      const id = deps.generateId();
      const now = deps.now();

      deps.repository.createParticipant({
        id,
        userId: body.userId,
        scmLogin: body.scmLogin ?? null,
        scmName: body.scmName ?? null,
        scmEmail: body.scmEmail ?? null,
        role: (body.role ?? "member") as ParticipantRole,
        joinedAt: now,
      });

      return Response.json({ id, status: "added" });
    },

    async verifySandboxToken(request: Request): Promise<Response> {
      const body = (await request.json()) as { token: string };

      if (!body.token) {
        return jsonResponse({ valid: false, error: "Missing token" }, 400);
      }

      const sandbox = deps.getSandbox();
      if (!sandbox) {
        deps.getLog().warn("Sandbox token verification failed: no sandbox");
        return jsonResponse({ valid: false, error: "No sandbox" }, 404);
      }

      if (sandbox.status === "stopped" || sandbox.status === "stale") {
        deps.getLog().warn("Sandbox token verification failed: sandbox is stopped/stale", {
          status: sandbox.status,
        });
        return jsonResponse({ valid: false, error: "Sandbox stopped" }, 410);
      }

      const isTokenValid = await deps.isValidSandboxToken(body.token, sandbox);
      if (!isTokenValid) {
        deps.getLog().warn("Sandbox token verification failed: token mismatch");
        return jsonResponse({ valid: false, error: "Invalid token" }, 401);
      }

      deps.getLog().info("Sandbox token verified successfully");
      return jsonResponse({ valid: true }, 200);
    },

    async openaiTokenRefresh(): Promise<Response> {
      const session = deps.getSession();
      if (!session) {
        return jsonResponse({ error: "No session" }, 404);
      }

      if (!deps.isOpenAISecretsConfigured()) {
        return jsonResponse({ error: "Secrets not configured" }, 500);
      }

      const result = await deps.refreshOpenAIToken(session);
      if (!result.ok) {
        return jsonResponse({ error: result.error }, result.status);
      }

      return jsonResponse(
        {
          access_token: result.accessToken,
          expires_in: result.expiresIn,
          account_id: result.accountId,
        },
        200
      );
    },
  };
}
