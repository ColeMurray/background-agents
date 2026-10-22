import type { SessionSkillStore } from "../../../db/session-skills";
import type { PiRepositoryTools } from "../../../pi/repository-tools";
import {
  piRepositoryToolRequestSchema,
  piSessionContextRequestSchema,
  piSessionContextSchema,
} from "../../../pi/session-context-contract";
import {
  piRepositoryMaterializationBatchSchema,
  piRepositoryMaterializationManifestSchema,
  piRepositoryMaterializationRequestSchema,
} from "../../../pi/repository-materialization-contract";
import type { MessageRepository } from "../../message-repository";
import type { ProviderCredentialService } from "../../provider-credential-service";
import type { SessionCoreRepository } from "../../session-core-repository";
import type { PiControlRepository } from "../../pi-control-repository";
import { piControlRequestIdFromMessageId } from "../../pi-control-message-id";
import type { SessionAttachmentRepository } from "../../session-attachment-repository";
import type { ObjectStorage } from "../../../storage/object-storage";
import { sessionAttachmentIdSchema } from "@open-inspect/shared/types/session-attachments";
import { z } from "zod";
import { piRuntimeControlSchema } from "../../../pi/runtime-contract";
import { createHarnessOperationFence } from "./harness-operation-fence";
import { MemoryError } from "../../../memory/errors";
import type { RenderedSessionMemory } from "@open-inspect/shared/types/memories";

const PI_AGENT_CONTROL_ACTIONS = new Set([
  "list_conversations",
  "inspect_agents",
  "get_last_message",
  "send",
  "follow_up",
  "cancel_agent",
]);

const piAttachmentRequestSchema = z.object({ attachmentId: sessionAttachmentIdSchema }).strict();

import type { SessionDiffService } from "../../diffs/service";
import { publicSourceControlError } from "../../../source-control";

interface PiBridgeHandlerOptions {
  sessions: Pick<
    SessionCoreRepository,
    "getSession" | "getSessionRepositories" | "getPiFeatureCapabilitySnapshot"
  >;
  messages: Pick<MessageRepository, "getProcessingMessage" | "getMessageHumanActor">;
  /**
   * Whether the turn's author may still act.
   *
   * A harness with no sandbox has no containment, so the check that stops a
   * suspended user from finishing a turn has to be made again, at the moment
   * of the action. This is the harness-neutral form of the check the sandbox
   * principal gets at admission.
   */
  authorMayAct?: (request: {
    operationId: string;
    actorId: string;
  }) => Promise<{ kind: "allowed" } | { kind: "denied"; reason: string }>;
  /**
   * Record the Code Mode run on the session's timeline.
   *
   * The run is visible to the session's collaborators, with its actor.
   */
  recordCodeModeActivity?: (input: {
    operationId: string;
    actorId: string;
    outcome: "authorized" | "refused";
  }) => void;
  controls: Pick<PiControlRepository, "isActiveOperation">;
  agentControls: { handle(request: Request): Promise<Response> };
  credentials: Pick<ProviderCredentialService, "getProviderAccess">;
  skills: Pick<SessionSkillStore, "getSandboxInstallation">;
  /** The session's attachment records, including the claim a turn holds. */
  attachments: Pick<SessionAttachmentRepository, "getClaimedByMessage">;
  /** The session's media bucket, where the image bytes live. */
  media: ObjectStorage;
  repositories: Pick<
    PiRepositoryTools,
    "pin" | "restore" | "list" | "read" | "prepareMaterialization" | "materializeBatch"
  >;
  diffs: Pick<SessionDiffService, "claimBaselines">;
  /** Deployment extensions may add bounded, server-authored context fields. */
  contextContributions?(): Promise<Record<string, unknown>>;
  /**
   * The tenant's memory, rendered for this session.
   *
   * The control plane renders it, exactly as it renders it for the sandbox
   * harnesses, so Pi never assembles memory text itself.
   */
  memory?: {
    renderedContext(input: {
      sessionId: string;
      requestId: string;
    }): Promise<RenderedSessionMemory | null>;
  };
  getSessionId(): string;
}

/** Internal, binding-only bridge from PiSessionDO to SessionDO-owned capabilities. */
export class PiBridgeHandler {
  private readonly fence: (request: Request) => boolean;

  constructor(private readonly options: PiBridgeHandlerOptions) {
    this.fence = createHarnessOperationFence({
      isHarnessSession: () => options.sessions.getSession()?.harness === "pi",
      messages: options.messages,
      controls: options.controls,
      operationId: (request) => request.headers.get("X-Pi-Operation-ID"),
      controlRequestId: piControlRequestIdFromMessageId,
    });
  }

  async credential(request: Request): Promise<Response> {
    if (!(await this.authorizedOperation(request))) {
      return Response.json({ error: "Pi execution is not active" }, { status: 409 });
    }
    const rejected = request.headers.get("X-Pi-Rejected-Credential-Version");
    const rejectedCredentialVersion = rejected ? Number(rejected) : undefined;
    if (
      rejectedCredentialVersion !== undefined &&
      (!Number.isSafeInteger(rejectedCredentialVersion) || rejectedCredentialVersion <= 0)
    ) {
      return Response.json({ error: "Invalid rejected credential version" }, { status: 400 });
    }
    try {
      const access = await this.options.credentials.getProviderAccess(
        this.options.getSessionId(),
        "openai",
        rejectedCredentialVersion
      );
      return Response.json(
        {
          access_token: access.accessToken,
          expires_in: Math.max(1, Math.floor((access.expiresAt - Date.now()) / 1_000)),
          credential_version: access.credentialVersion,
        },
        { headers: { "Cache-Control": "no-store" } }
      );
    } catch {
      return Response.json({ error: "OpenAI provider account unavailable" }, { status: 409 });
    }
  }

  async agentControl(request: Request): Promise<Response> {
    const operationId = request.headers.get("X-Pi-Operation-ID");
    if (!operationId || !(await this.authorizedOperation(request))) {
      return Response.json({ error: "Pi execution is not active" }, { status: 409 });
    }
    const body = await request.json().catch(() => null);
    const candidate = typeof body === "object" && body !== null ? body : {};
    const parsed = piRuntimeControlSchema.safeParse({
      ...candidate,
      sessionId: this.options.getSessionId(),
    });
    if (!parsed.success)
      return Response.json({ error: "Invalid Pi agent control" }, { status: 400 });
    if (!PI_AGENT_CONTROL_ACTIONS.has(parsed.data.action)) {
      return Response.json({ error: "Pi agent control is not allowed" }, { status: 403 });
    }
    return this.options.agentControls.handle(
      new Request("http://session/internal/pi-control", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          actorId: `pi:${operationId}`.slice(0, 128),
          source: "pi",
          control: parsed.data,
        }),
      })
    );
  }

  async context(request: Request): Promise<Response> {
    if (this.options.sessions.getSession()?.harness !== "pi") {
      return Response.json({ error: "Session does not use Pi Durable" }, { status: 409 });
    }
    const parsed = piSessionContextRequestSchema.safeParse(await request.json().catch(() => ({})));
    if (!parsed.success) {
      return Response.json({ error: "Invalid Pi session context request" }, { status: 400 });
    }

    const sessionId = this.options.getSessionId();
    const session = this.options.sessions.getSession();
    const sessionRepositories = this.options.sessions.getSessionRepositories();
    const skills = await this.options.skills.getSandboxInstallation(sessionId);
    if (parsed.data.mode === "bootstrap") {
      return Response.json(
        piSessionContextSchema.parse({
          repositories: sessionRepositories.map((repository) => ({
            position: repository.position,
            repoOwner: repository.repoOwner,
            repoName: repository.repoName,
            baseBranch:
              repository.row?.base_branch ??
              (repository.isPrimary ? (session?.base_branch ?? null) : null),
          })),
          skills,
          agentMessagingEnabled:
            session?.spawn_source === "user" || session?.spawn_source === "slack-bot",
          ...(await this.options.contextContributions?.()),
          memory: await this.renderedMemory(sessionId, request),
        }),
        { headers: { "Cache-Control": "no-store" } }
      );
    }
    const claimedPins = sessionRepositories.map((repository) => ({
      position: repository.position,
      repoOwner: repository.repoOwner,
      repoName: repository.repoName,
      commitSha:
        repository.row?.base_sha ?? (repository.isPrimary ? (session?.base_sha ?? null) : null),
    }));
    const completeClaimedPins = claimedPins.every((pin) => pin.commitSha !== null)
      ? claimedPins.map((pin) => ({ ...pin, commitSha: pin.commitSha! }))
      : null;
    const repositories = parsed.data.repositoryPins
      ? this.options.repositories.restore(parsed.data.repositoryPins)
      : completeClaimedPins
        ? this.options.repositories.restore(completeClaimedPins)
        : await this.options.repositories.pin();
    this.options.diffs.claimBaselines(
      repositories.map(({ position, repoOwner, repoName, commitSha }) => ({
        position,
        repoOwner,
        repoName,
        baseSha: commitSha,
      }))
    );
    const context = piSessionContextSchema.parse({
      repositories,
      skills,
    });
    return Response.json(context, { headers: { "Cache-Control": "no-store" } });
  }

  async repositoryMaterialization(request: Request): Promise<Response> {
    if (this.options.sessions.getSession()?.harness !== "pi") {
      return Response.json({ error: "Session does not use Pi Durable" }, { status: 409 });
    }

    const parsed = piRepositoryMaterializationRequestSchema.safeParse(
      await request.json().catch(() => null)
    );
    if (!parsed.success) {
      return Response.json(
        { error: "Invalid Pi repository materialization request" },
        { status: 400 }
      );
    }
    const repository = this.options.sessions
      .getSessionRepositories()
      .find((candidate) => candidate.position === parsed.data.repository);
    const claimedBaseline =
      repository?.row?.base_sha ??
      (repository?.isPrimary ? (this.options.sessions.getSession()?.base_sha ?? null) : null);
    if (!claimedBaseline || claimedBaseline.toLowerCase() !== parsed.data.commitSha.toLowerCase()) {
      return Response.json(
        { error: "Repository materialization does not match the claimed session baseline" },
        { status: 409 }
      );
    }
    try {
      const target = {
        repository: parsed.data.repository,
        commitSha: parsed.data.commitSha,
      };
      const materialization =
        parsed.data.operation === "manifest"
          ? piRepositoryMaterializationManifestSchema.parse(
              await this.options.repositories.prepareMaterialization(target)
            )
          : piRepositoryMaterializationBatchSchema.parse(
              await this.options.repositories.materializeBatch({
                ...target,
                offset: parsed.data.offset,
              })
            );
      return Response.json(materialization, { headers: { "Cache-Control": "no-store" } });
    } catch (error) {
      const publicError = publicSourceControlError(error, "Repository materialization failed");
      if (publicError.retryable) {
        return Response.json(
          { error: publicError.message },
          { status: 503, headers: { "Retry-After": "1" } }
        );
      }
      return Response.json({ error: publicError.message }, { status: 400 });
    }
  }

  async repositoryTool(request: Request): Promise<Response> {
    if (!(await this.authorizedOperation(request))) {
      return Response.json({ error: "Pi execution is not active" }, { status: 409 });
    }
    const parsed = piRepositoryToolRequestSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return Response.json({ error: "Invalid Pi repository tool request" }, { status: 400 });
    }
    try {
      const result =
        parsed.data.tool === "repository_list"
          ? await this.options.repositories.list(parsed.data.arguments)
          : await this.options.repositories.read(parsed.data.arguments);
      return Response.json(result, { headers: { "Cache-Control": "no-store" } });
    } catch (error) {
      // The provider's own string may name an internal URL, a repository, or
      // a credential-fetch failure. The model is not its audience.
      const publicError = publicSourceControlError(error, "Repository tool failed");
      return Response.json(
        { error: publicError.message },
        { status: publicError.retryable ? 503 : 400 }
      );
    }
  }

  /**
   * The bytes of one image this turn claimed.
   *
   * The Pi Durable Object is the harness of a Pi turn, so it fetches an image
   * the way a sandbox harness does — through the session that owns it. The
   * session decides: the attachment must be one this turn claimed, and the
   * bytes come from the session's own media bucket. The answer carries the
   * image and nothing else.
   */
  async attachment(request: Request): Promise<Response> {
    const operationId = request.headers.get("X-Pi-Operation-ID");
    if (!operationId || !(await this.authorizedOperation(request))) {
      return Response.json({ error: "Pi execution is not active" }, { status: 409 });
    }
    const parsed = piAttachmentRequestSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return Response.json({ error: "Invalid attachment request" }, { status: 400 });
    }
    const row = this.options.attachments.getClaimedByMessage(operationId, parsed.data.attachmentId);
    if (!row) {
      return Response.json({ error: "Attachment not found" }, { status: 404 });
    }
    const object = await this.options.media.get(row.object_key);
    if (!object) {
      return Response.json({ error: "Attachment not found" }, { status: 404 });
    }
    const bytes = new Uint8Array(await new Response(object.body).arrayBuffer());
    return new Response(bytes, {
      headers: {
        "Content-Type": row.mime_type,
        "Content-Length": String(bytes.byteLength),
        "Cache-Control": "no-store",
      },
    });
  }

  /**
   * Authorize one Code Mode run.
   *
   * Code Mode is a capability like any other: the session that owns the turn
   * decides whether it may run, the turn's actor is known, and the run
   * appears on the shared timeline with its actor.
   */
  async codeModeAuthorize(request: Request): Promise<Response> {
    if (this.options.sessions.getSession()?.harness !== "pi") {
      return Response.json({ error: "Session does not use Pi Durable" }, { status: 409 });
    }
    const operationId = request.headers.get("X-Pi-Operation-ID");
    if (!operationId || !(await this.authorizedOperation(request))) {
      return Response.json({ error: "Pi execution is not active" }, { status: 409 });
    }
    const actorId = this.options.messages.getMessageHumanActor(operationId);
    if (!actorId) {
      return Response.json({ error: "The originating turn has no human actor" }, { status: 409 });
    }
    const capability = this.options.sessions.getPiFeatureCapabilitySnapshot()?.capabilities;
    if (capability && capability.codeMode !== "enabled") {
      return Response.json(
        { error: "Code Mode is not available for this session", code: "code_mode_disabled" },
        { status: 403 }
      );
    }
    this.options.recordCodeModeActivity?.({
      operationId,
      actorId,
      outcome: "authorized",
    });
    return Response.json({ allowed: true }, { headers: { "Cache-Control": "no-store" } });
  }

  /**
   * Whether this request belongs to a live turn whose author may still act.
   *
   * Two questions, both asked now: is a turn running, and may its author
   * still act on this session? The second is read from the database, so a
   * suspension or a removal takes effect immediately.
   */
  private async authorizedOperation(request: Request): Promise<boolean> {
    if (!this.activeOperation(request)) return false;
    const gate = this.options.authorMayAct;
    if (!gate) return true;
    const operationId = request.headers.get("X-Pi-Operation-ID");
    if (!operationId) return false;
    const actorId = this.options.messages.getMessageHumanActor(operationId);
    if (!actorId) return false;
    const decision = await gate({ operationId, actorId });
    return decision.kind === "allowed";
  }

  private activeOperation(request: Request): boolean {
    return this.fence(request);
  }

  /**
   * The session's pinned memory, rendered for Pi.
   *
   * A session that has no memory selection, or that may no longer reach the
   * partitions it pinned, gets none: the boot context is empty and the
   * memory tools refuse. An unexpected failure is not swallowed.
   */
  private async renderedMemory(
    sessionId: string,
    request: Request
  ): Promise<RenderedSessionMemory | null> {
    if (!this.options.memory) return null;
    try {
      return await this.options.memory.renderedContext({
        sessionId,
        requestId: request.headers.get("x-request-id") ?? crypto.randomUUID(),
      });
    } catch (cause) {
      if (cause instanceof MemoryError) return null;
      throw cause;
    }
  }
}
