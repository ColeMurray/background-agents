import type { Logger } from "../../../logger";
import {
  createMediaArtifactRequestSchema,
  type CreateMediaArtifactRequest,
} from "@open-inspect/shared/types/session-api";
import type { SessionArtifact } from "@open-inspect/shared/types/artifacts";
import {
  bootPhaseNameSchema,
  sandboxOutputTailSchema,
  sandboxEventSchema,
  type SandboxEvent,
} from "@open-inspect/shared/types/sandbox-events";
import {
  isDeadSandboxStatus,
  isSandboxReconnectBlockedStatus,
} from "../../../sandbox/lifecycle/decisions";
import {
  OpenAITokenNotConfiguredError,
  OpenAITokenStorageError,
  OpenAITokenUnauthorizedError,
  OpenAITokenUpstreamError,
  type OpenAIToken,
} from "../../openai-token-refresh-service";
import type { XaiTokenRefreshResult } from "../../xai-token-refresh-service";
import type { ScmCredentialsResult } from "../../scm-credentials-service";
import type { SessionMessenger } from "../../messenger";
import type { MessageRepository } from "../../message-repository";
import type { ArtifactRepository } from "../../artifact-repository";
import type { EventRepository } from "../../event-repository";
import type { SessionCoreRepository } from "../../session-core-repository";
import type { SandboxRepository } from "../../sandbox-repository";
import type { SessionSandboxEventProcessor } from "../../sandbox-events/processor";
import type { SandboxRow, SessionRow } from "../../types";
import { assertArtifactType } from "../../artifacts";
import { parseTunnelUrls } from "../../tunnel-urls";
import { z } from "zod";

/**
 * A fatal runtime report. The phase fields are what the supervisor knew
 * when the boot died; they are optional because runtimes that predate boot
 * phases report only the error. The tail is bounded and redacted by the
 * runtime before it leaves the sandbox, and bounded again here.
 */
const sandboxErrorRequestSchema = z.object({
  error: z.string().trim().min(1).max(1000),
  phase: bootPhaseNameSchema.optional(),
  bootSeq: z.number().int().optional(),
  repoOwner: z.string().optional(),
  repoName: z.string().optional(),
  outputTail: sandboxOutputTailSchema.optional(),
});

/**
 * HTTP boundary for the sandbox-facing endpoints: event ingestion, media
 * artifacts, token verification, and the
 * credential/token refresh routes the in-sandbox tooling calls.
 */
export class SandboxHandler {
  /** Create the sandbox HTTP handler with its repositories and service dependencies. */
  constructor(
    private readonly messageRepository: MessageRepository,
    private readonly eventRepository: EventRepository,
    private readonly artifactRepository: ArtifactRepository,
    private readonly sessionCoreRepository: SessionCoreRepository,
    private readonly sandboxRepository: SandboxRepository,
    private readonly sandboxEventProcessor: SessionSandboxEventProcessor,
    private readonly messenger: SessionMessenger,
    private readonly refreshOpenAIToken: (session: SessionRow, log: Logger) => Promise<OpenAIToken>,
    private readonly refreshXaiToken: (
      session: SessionRow,
      log: Logger
    ) => Promise<XaiTokenRefreshResult>,
    private readonly getScmCredentials: (log: Logger) => Promise<ScmCredentialsResult>,
    private readonly isValidSandboxToken: (
      token: string | null,
      sandbox: SandboxRow | null
    ) => Promise<boolean>,
    private readonly failSandbox: (reason: string) => Promise<void>,
    private readonly generateId: () => string,
    private readonly now: () => number = Date.now
  ) {}

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
    await this.sandboxEventProcessor.processSandboxEvent(event);
    return Response.json({ status: "ok" });
  }

  async sandboxError(request: Request, log: Logger): Promise<Response> {
    const authHeader = request.headers.get("Authorization");
    const token = authHeader?.startsWith("Bearer ") ? authHeader.slice("Bearer ".length) : null;
    const sandboxId = request.headers.get("X-Sandbox-ID");
    const sandbox = this.sandboxRepository.getSandbox();
    if (!sandbox || !token) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (sandbox.modal_sandbox_id && sandboxId !== sandbox.modal_sandbox_id) {
      return Response.json({ error: "Wrong sandbox" }, { status: 403 });
    }
    // Read before the awaits below: a `failed` generation may reconnect while
    // this request is suspended and be published as `ready` with these same
    // credentials. The report still describes the sandbox as it was when it
    // was sent, so a dead row at either point means it is stale.
    const wasDead = isDeadSandboxStatus(sandbox.status);

    if (!(await this.isValidSandboxToken(token, sandbox))) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    let raw: unknown;
    try {
      raw = await request.json();
    } catch {
      return Response.json({ error: "Invalid request body" }, { status: 400 });
    }
    const result = sandboxErrorRequestSchema.safeParse(raw);
    if (!result.success) {
      return Response.json({ error: "Invalid sandbox error" }, { status: 400 });
    }

    const currentSandbox = this.sandboxRepository.getSandbox();
    if (
      currentSandbox?.modal_sandbox_id !== sandbox.modal_sandbox_id ||
      currentSandbox?.auth_token_hash !== sandbox.auth_token_hash ||
      currentSandbox?.auth_token !== sandbox.auth_token
    ) {
      return Response.json({ error: "Sandbox credentials changed" }, { status: 403 });
    }
    // A dead row has nobody to terminate and nothing to retry. `failed` is
    // deliberately in that set: the connect watchdog fails a slow boot but
    // cannot always stop it (Modal has no explicit stop), so the orphan runs
    // on until a sandbox-authenticated call refuses it and it reports that
    // refusal as fatal. Acting on that report would re-drive the pending
    // prompt onto a fresh sandbox that meets the same fate.
    if (wasDead || isDeadSandboxStatus(currentSandbox.status)) {
      log.warn("Ignoring fatal report from a sandbox that is no longer live", {
        event: "sandbox.error_ignored",
        sandbox_status: currentSandbox.status,
        sandbox_status_at_report: sandbox.status,
        error: result.data.error,
      });
      return Response.json({ status: "ignored" });
    }

    // The HTTP report is the reliable carrier of the failed phase: the
    // bridge's own phase line over the socket is best-effort and may be lost
    // when the socket closes first. Landing it here puts the phase and the
    // script's output tail on the timeline for the failure the user sees;
    // the sequence number de-duplicates it against the socket copy.
    const { phase, bootSeq, repoOwner, repoName, outputTail } = result.data;
    if (phase !== undefined) {
      await this.sandboxEventProcessor.processSandboxEvent({
        type: "boot_progress",
        phase,
        status: "failed",
        bootSeq: bootSeq ?? Number.MAX_SAFE_INTEGER,
        ...(repoOwner !== undefined ? { repoOwner } : {}),
        ...(repoName !== undefined ? { repoName } : {}),
        ...(outputTail !== undefined ? { outputTail } : {}),
        detail: result.data.error,
        sandboxId: currentSandbox.modal_sandbox_id ?? currentSandbox.id,
        timestamp: this.now() / 1000,
      });
    }
    await this.failSandbox(result.data.error);
    return Response.json({ status: "ok" });
  }

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
    const sandbox = this.sandboxRepository.getSandbox();
    if (!sandbox) {
      return Response.json({ error: "No sandbox" }, { status: 404 });
    }

    if (!body.artifactId || !body.objectKey) {
      return Response.json({ error: "artifactId and objectKey are required" }, { status: 400 });
    }

    const processingMessage = this.messageRepository.getProcessingMessage();
    if (!processingMessage) {
      return Response.json({ error: "No active prompt" }, { status: 409 });
    }

    const artifactType = assertArtifactType(body.artifactType);
    const now = this.now();
    const timestampSeconds = now / 1000;
    const artifact: SessionArtifact = {
      id: body.artifactId,
      type: artifactType,
      url: body.objectKey,
      metadata: body.metadata ?? null,
      createdAt: now,
      updatedAt: now,
    };

    this.artifactRepository.createArtifact({
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

    this.eventRepository.createEvent({
      id: this.generateId(),
      type: event.type,
      data: JSON.stringify(event),
      messageId: processingMessage.id,
      createdAt: now,
    });

    this.messenger.broadcast({ type: "artifact_created", artifact });
    this.messenger.broadcast({ type: "sandbox_event", event });

    return Response.json({ status: "ok", artifactId: artifact.id });
  }

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

    const sandbox = this.sandboxRepository.getSandbox();
    if (!sandbox) {
      log.warn("Sandbox token verification failed: no sandbox");
      return Response.json({ valid: false, error: "No sandbox" }, { status: 404 });
    }

    // Boot-time states (spawning/connecting) must authenticate — the git
    // credential broker is already called during the initial clone, before
    // the WebSocket connect flips the status to ready. `failed` must too:
    // the same gate the bridge uses, because a boot the connect watchdog
    // gave up on is still allowed to connect and self-heal, and it cannot
    // get there if the sandbox-authenticated calls it makes on the way
    // (credentials, skills, tunnel URLs) are refused. A superseded
    // generation is still rejected below by the token comparison.
    if (isSandboxReconnectBlockedStatus(sandbox.status)) {
      log.warn("Sandbox token verification failed: sandbox is stopped", {
        status: sandbox.status,
      });
      return Response.json({ valid: false, error: "Sandbox not active" }, { status: 410 });
    }

    const isTokenValid = await this.isValidSandboxToken(token, sandbox);
    if (!isTokenValid) {
      log.warn("Sandbox token verification failed: token mismatch");
      return Response.json({ valid: false, error: "Invalid token" }, { status: 401 });
    }

    log.info("Sandbox token verified successfully");
    return Response.json(
      { valid: true, sandboxId: sandbox.modal_sandbox_id ?? sandbox.id },
      { status: 200 }
    );
  }

  async openaiTokenRefresh(log: Logger): Promise<Response> {
    const session = this.sessionCoreRepository.getSession();
    if (!session) {
      return Response.json({ error: "No session" }, { status: 404 });
    }

    let token: OpenAIToken;
    try {
      token = await this.refreshOpenAIToken(session, log);
    } catch (error) {
      if (error instanceof OpenAITokenNotConfiguredError) {
        return Response.json({ error: error.message }, { status: 404 });
      }
      if (error instanceof OpenAITokenUnauthorizedError) {
        return Response.json({ error: error.message }, { status: 401 });
      }
      if (error instanceof OpenAITokenStorageError) {
        return Response.json({ error: error.message }, { status: 500 });
      }
      if (error instanceof OpenAITokenUpstreamError) {
        return Response.json({ error: error.message }, { status: 502 });
      }
      throw error;
    }

    return Response.json(
      {
        access_token: token.accessToken,
        expires_in: token.expiresIn,
        account_id: token.accountId,
      },
      { status: 200, headers: { "Cache-Control": "no-store" } }
    );
  }

  async xaiTokenRefresh(log: Logger): Promise<Response> {
    const session = this.sessionCoreRepository.getSession();
    if (!session) {
      return Response.json({ error: "No session" }, { status: 404 });
    }
    const result = await this.refreshXaiToken(session, log);
    if (!result.ok) {
      return Response.json({ error: result.error }, { status: result.status });
    }
    return Response.json(
      { access_token: result.accessToken, expires_in: result.expiresIn },
      { status: 200, headers: { "Cache-Control": "no-store" } }
    );
  }

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
    const sandbox = this.sandboxRepository.getSandbox();
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
  }

  async scmCredentials(log: Logger): Promise<Response> {
    const session = this.sessionCoreRepository.getSession();
    if (!session) {
      return Response.json({ error: "No session" }, { status: 404 });
    }
    if (!session.repo_owner || !session.repo_name) {
      return Response.json(
        { error: "SCM credentials require a repository context" },
        { status: 400 }
      );
    }

    const result = await this.getScmCredentials(log);
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
  }
}
