import type { Logger } from "../../../logger";
import {
  createMediaArtifactRequestSchema,
  sandboxEventSchema,
  type CreateMediaArtifactRequest,
  type SessionArtifact,
} from "@open-inspect/shared";
import type { ParticipantRole, SandboxEvent } from "../../../types";
import { isDeadSandboxStatus } from "../../../sandbox/lifecycle/decisions";
import type { OpenAITokenRefreshResult } from "../../openai-token-refresh-service";
import type { ScmCredentialsResult } from "../../scm-credentials-service";
import type { SessionMessenger } from "../../messenger";
import type { SessionRepository } from "../../repository";
import type { SandboxRow, SessionRow } from "../../types";
import { assertArtifactType } from "../../artifacts";
import { parseTunnelUrls } from "../../tunnel-urls";
import { z } from "zod";

const addParticipantRequestSchema = z.object({
  userId: z.string(),
  scmLogin: z.string().optional(),
  scmName: z.string().optional(),
  scmEmail: z.string().optional(),
  role: z.enum(["owner", "member"] satisfies [ParticipantRole, ParticipantRole]).optional(),
});

type AddParticipantRequest = z.infer<typeof addParticipantRequestSchema>;

export interface SandboxHandlerDeps {
  repository: Pick<
    SessionRepository,
    | "createParticipant"
    | "createArtifact"
    | "createEvent"
    | "getProcessingMessage"
    | "updateSandboxBootProgress"
  >;
  processSandboxEvent: (event: SandboxEvent) => Promise<void>;
  getSandbox: () => SandboxRow | null;
  isValidSandboxToken: (token: string | null, sandbox: SandboxRow | null) => Promise<boolean>;
  getSession: () => SessionRow | null;
  refreshOpenAIToken: (session: SessionRow, log: Logger) => Promise<OpenAITokenRefreshResult>;
  isOpenAISecretsConfigured: () => boolean;
  getScmCredentials: (log: Logger) => Promise<ScmCredentialsResult>;
  messenger: SessionMessenger;
  generateId: () => string;
  now: () => number;
}

export interface SandboxHandler {
  sandboxEvent: (request: Request) => Promise<Response>;
  createMediaArtifact: (request: Request) => Promise<Response>;
  addParticipant: (request: Request) => Promise<Response>;
  verifySandboxToken: (request: Request, log: Logger) => Promise<Response>;
  /** Record a boot-progress ping so the connecting watchdog tolerates long boots. */
  bootProgress: () => Promise<Response>;
  openaiTokenRefresh: (log: Logger) => Promise<Response>;
  scmCredentials: (log: Logger) => Promise<Response>;
  /** Return the sandbox's resolved tunnel URLs as a `{ [port]: url }` map. */
  tunnelUrls: (log: Logger) => Promise<Response>;
}

export function createSandboxHandler(deps: SandboxHandlerDeps): SandboxHandler {
  return {
    async sandboxEvent(request: Request): Promise<Response> {
      let raw: unknown;
      try {
        raw = await request.json();
      } catch {
        return Response.json({ error: "Invalid request body" }, { status: 400 });
      }

      const result = sandboxEventSchema.safeParse(raw);
      if (!result.success) {
        return Response.json({ error: "Invalid sandbox event" }, { status: 400 });
      }

      const event: SandboxEvent = result.data;
      await deps.processSandboxEvent(event);
      return Response.json({ status: "ok" });
    },

    async createMediaArtifact(request: Request): Promise<Response> {
      let raw: unknown;
      try {
        raw = await request.json();
      } catch {
        return Response.json({ error: "Invalid request body" }, { status: 400 });
      }

      const result = createMediaArtifactRequestSchema.safeParse(raw);
      if (!result.success) {
        return Response.json({ error: "Invalid media artifact body" }, { status: 400 });
      }

      const body: CreateMediaArtifactRequest = result.data;
      const sandbox = deps.getSandbox();
      if (!sandbox) {
        return Response.json({ error: "No sandbox" }, { status: 404 });
      }

      if (!body.artifactId || !body.objectKey) {
        return Response.json({ error: "artifactId and objectKey are required" }, { status: 400 });
      }

      const processingMessage = deps.repository.getProcessingMessage();
      if (!processingMessage) {
        return Response.json({ error: "No active prompt" }, { status: 409 });
      }

      const artifactType = assertArtifactType(body.artifactType);
      const now = deps.now();
      const timestampSeconds = now / 1000;
      const artifact: SessionArtifact = {
        id: body.artifactId,
        type: artifactType,
        url: body.objectKey,
        metadata: body.metadata ?? null,
        createdAt: now,
        updatedAt: now,
      };

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
        messageId: processingMessage.id,
        sandboxId: sandbox.modal_sandbox_id ?? sandbox.id,
        timestamp: timestampSeconds,
      };

      deps.repository.createEvent({
        id: deps.generateId(),
        type: event.type,
        data: JSON.stringify(event),
        messageId: processingMessage.id,
        createdAt: now,
      });

      deps.messenger.broadcast({ type: "artifact_created", artifact });
      deps.messenger.broadcast({ type: "sandbox_event", event });

      return Response.json({ status: "ok", artifactId: artifact.id });
    },

    async addParticipant(request: Request): Promise<Response> {
      let raw: unknown;
      try {
        raw = await request.json();
      } catch {
        return Response.json({ error: "Invalid request body" }, { status: 400 });
      }

      const result = addParticipantRequestSchema.safeParse(raw);
      if (!result.success) {
        return Response.json({ error: "Invalid participant body" }, { status: 400 });
      }

      const body: AddParticipantRequest = result.data;

      const id = deps.generateId();
      const now = deps.now();

      deps.repository.createParticipant({
        id,
        userId: body.userId,
        scmLogin: body.scmLogin ?? null,
        scmName: body.scmName ?? null,
        scmEmail: body.scmEmail ?? null,
        role: body.role ?? "member",
        joinedAt: now,
      });

      return Response.json({ id, status: "added" });
    },

    async verifySandboxToken(request: Request, log: Logger): Promise<Response> {
      let raw: unknown;
      try {
        raw = await request.json();
      } catch {
        return Response.json({ valid: false, error: "Missing token" }, { status: 400 });
      }

      const body = raw && typeof raw === "object" ? raw : null;
      const token = body && "token" in body ? body.token : undefined;

      if (typeof token !== "string" || !token) {
        return Response.json({ valid: false, error: "Missing token" }, { status: 400 });
      }

      const sandbox = deps.getSandbox();
      if (!sandbox) {
        log.warn("Sandbox token verification failed: no sandbox");
        return Response.json({ valid: false, error: "No sandbox" }, { status: 404 });
      }

      // Boot-time states (spawning/connecting) must authenticate — the git
      // credential broker is already called during the initial clone, before
      // the WebSocket connect flips the status to ready.
      if (isDeadSandboxStatus(sandbox.status)) {
        log.warn("Sandbox token verification failed: sandbox is dead", {
          status: sandbox.status,
        });
        return Response.json({ valid: false, error: "Sandbox not active" }, { status: 410 });
      }

      const isTokenValid = await deps.isValidSandboxToken(token, sandbox);
      if (!isTokenValid) {
        log.warn("Sandbox token verification failed: token mismatch");
        return Response.json({ valid: false, error: "Invalid token" }, { status: 401 });
      }

      log.info("Sandbox token verified successfully");
      return Response.json({ valid: true }, { status: 200 });
    },

    async bootProgress(): Promise<Response> {
      const sandbox = deps.getSandbox();
      if (!sandbox) {
        return Response.json({ error: "No sandbox" }, { status: 404 });
      }

      deps.repository.updateSandboxBootProgress(deps.now());
      return Response.json({ status: "ok" });
    },

    async openaiTokenRefresh(log: Logger): Promise<Response> {
      const session = deps.getSession();
      if (!session) {
        return Response.json({ error: "No session" }, { status: 404 });
      }

      if (!deps.isOpenAISecretsConfigured()) {
        return Response.json({ error: "Secrets not configured" }, { status: 500 });
      }

      const result = await deps.refreshOpenAIToken(session, log);
      if (!result.ok) {
        return Response.json({ error: result.error }, { status: result.status });
      }

      return Response.json(
        {
          access_token: result.accessToken,
          expires_in: result.expiresIn,
          account_id: result.accountId,
        },
        { status: 200 }
      );
    },

    /**
     * Return the sandbox's resolved tunnel URLs as a `{ [port]: url }` map.
     *
     * `sandbox.tunnel_urls` is a JSON-encoded `{ [port: string]: string }`
     * stored by `SandboxLifecycleManager#storeAndBroadcastTunnelUrls`. When the
     * control plane has resolved Modal tunnel URLs but the in-sandbox file write
     * (`sandbox.open` from outside) hasn't propagated to the sandbox's own
     * filesystem view — a real failure mode on the Modal provider — this
     * endpoint is the in-sandbox fallback for retrieving them via
     * `SANDBOX_AUTH_TOKEN`.
     *
     * Responses:
     * - `404` when no sandbox exists for the session.
     * - `500` when the stored value is malformed — invalid JSON, not a plain
     *   object, or holding a non-string value — so the in-sandbox setup hard-
     *   fails on corrupt data instead of writing a garbage `.tunnels.env`. Note
     *   a not-yet-resolved sandbox still returns `200` with an empty map, so the
     *   client must tolerate an empty result and retry until ports appear.
     * - `200` with `{ tunnelUrls }` otherwise (empty map when none are stored).
     */
    async tunnelUrls(log: Logger): Promise<Response> {
      const sandbox = deps.getSandbox();
      if (!sandbox) {
        return Response.json({ error: "No sandbox" }, { status: 404 });
      }

      let urls: Record<string, string> = {};
      if (sandbox.tunnel_urls) {
        const parsed = parseTunnelUrls(sandbox.tunnel_urls);
        if (!parsed) {
          log.warn("Invalid stored tunnel_urls");
          return Response.json({ error: "Invalid stored tunnel URLs" }, { status: 500 });
        }
        urls = parsed;
      }

      return Response.json(
        { tunnelUrls: urls },
        { status: 200, headers: { "Cache-Control": "no-store" } }
      );
    },

    async scmCredentials(log: Logger): Promise<Response> {
      const session = deps.getSession();
      if (!session) {
        return Response.json({ error: "No session" }, { status: 404 });
      }
      if (!session.repo_owner || !session.repo_name) {
        return Response.json(
          { error: "SCM credentials require a repository context" },
          { status: 400 }
        );
      }

      const result = await deps.getScmCredentials(log);
      if (!result.ok) {
        return Response.json({ error: result.error }, { status: result.status });
      }

      return Response.json(
        {
          username: result.username,
          password: result.password,
          expires_at_epoch_ms: result.expiresAtEpochMs,
        },
        {
          status: 200,
          headers: { "Cache-Control": "no-store" },
        }
      );
    },
  };
}
