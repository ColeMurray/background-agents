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
import type { PiCredentialService } from "../../pi-credential-service";
import type { SessionCoreRepository } from "../../session-core-repository";
import type { PiControlRepository } from "../../pi-control-repository";
import { externalActionPrepareRequestSchema } from "@open-inspect/shared";
import { externalActionToolName } from "@open-inspect/shared/types/external-actions";
import type { FeatureCapabilityMode } from "@open-inspect/shared/pi-feature-capabilities";
import type { ExternalActionGateway } from "../../external-action-gateway";
import { DEFAULT_EXTERNAL_ACTION_APPROVAL_TTL_MS } from "../../external-action-gateway";
import { z } from "zod";
import { piRuntimeControlSchema } from "../../../pi/runtime-contract";
import type { ExternalActionDefinitionRegistry } from "../../external-action-definitions";

const externalActionIdSchema = z.strictObject({ actionId: z.string().min(1) });

/**
 * A bounded public error for an external action route.
 *
 * The internal reason stays internal: an approver learns what happened and
 * whether to retry, never an internal provider string, a repository name, or
 * a credential-shaped fragment.
 */
function externalActionFailure(error: unknown): Response {
  const reason = error instanceof Error ? error.message : String(error);
  if (reason.includes("not found")) {
    return externalActionError(404, "external_action_not_found", "External action not found");
  }
  if (reason.includes("expired")) {
    return externalActionError(
      409,
      "external_action_expired",
      "The approval request for this external action has expired"
    );
  }
  if (reason.includes("cannot be approved") || reason.includes("cannot be denied")) {
    return externalActionError(
      409,
      "external_action_not_decidable",
      "This external action can no longer be decided in that way"
    );
  }
  if (reason.includes("cannot be cancelled")) {
    return externalActionError(
      409,
      "external_action_not_cancellable",
      "This external action can no longer be cancelled"
    );
  }
  if (reason.includes("grant")) {
    return externalActionError(
      409,
      "external_action_invalid_approval",
      "The approval for this external action is not authorized"
    );
  }
  if (reason.includes("idempotency key")) {
    return externalActionError(
      409,
      "external_action_conflict",
      "This external action conflicts with an earlier request"
    );
  }
  return externalActionError(
    409,
    "external_action_failed",
    "The external action could not be completed"
  );
}

function externalActionError(status: number, code: string, message: string): Response {
  return Response.json(
    { error: message, code },
    { status, headers: { "Cache-Control": "no-store" } }
  );
}
const externalActionDecisionSchema = z.strictObject({
  actionId: z.string().min(1),
  decision: z.enum(["approve", "deny", "cancel"]),
  reason: z.string().min(1).max(1_000).optional(),
});
const PI_AGENT_CONTROL_ACTIONS = new Set([
  "list_conversations",
  "inspect_agents",
  "get_last_message",
  "send",
  "follow_up",
  "steer",
  "cancel_agent",
]);

interface ExternalActionBridge {
  enabled: boolean;
  gateway: Pick<
    ExternalActionGateway,
    | "prepare"
    | "status"
    | "execute"
    | "approve"
    | "deny"
    | "cancel"
    | "expireDue"
    | "isBoundToOperation"
    | "listPending"
    | "nextReconciliationAt"
  >;
  definitions: ExternalActionDefinitionRegistry;
  /**
   * Whether the deployment holds a credential for one provider.
   *
   * A publication that could never complete must never reach an approval
   * card, so the credential is checked before the action is prepared.
   */
  credentialAvailable?(provider: string): Promise<boolean>;
  /**
   * Live deployment mode for new external effects.
   *
   * The mode is read on every request, so an emergency can deny new effects
   * without uninstalling the gateway. Status, audit recovery,
   * reconciliation, denial, and cancellation stay available so an emergency
   * never strands already-admitted work.
   */
  liveMode?(): FeatureCapabilityMode;
  resolveAutomationApproval?(
    provider: string,
    action: string
  ): Promise<{ source: "automation_grant"; actorId: string; grantId: string } | undefined>;
  flushAudit?(): Promise<void>;
  nextDeadline?(): number | null;
  scheduleReconciliation?(deadline: number): Promise<void>;
}
import type { SessionDiffService } from "../../diffs/service";
import { publicSourceControlError } from "../../../source-control";

interface PiBridgeHandlerOptions {
  sessions: Pick<
    SessionCoreRepository,
    "getSession" | "getSessionRepositories" | "getPiFeatureCapabilitySnapshot"
  >;
  messages: Pick<MessageRepository, "getProcessingMessage" | "getMessageHumanActor">;
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
  credentials: Pick<PiCredentialService, "getOpenAIAccess">;
  skills: Pick<SessionSkillStore, "getSandboxInstallation">;
  repositories: Pick<
    PiRepositoryTools,
    "pin" | "restore" | "list" | "read" | "prepareMaterialization" | "materializeBatch"
  >;
  diffs: Pick<SessionDiffService, "claimBaselines">;
  externalActions?: ExternalActionBridge;
  getSessionId(): string;
}

/** Internal, binding-only bridge from PiSessionDO to SessionDO-owned capabilities. */
export class PiBridgeHandler {
  constructor(private readonly options: PiBridgeHandlerOptions) {}

  async credential(request: Request): Promise<Response> {
    if (!this.activeOperation(request)) {
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
      const access = await this.options.credentials.getOpenAIAccess(
        this.options.getSessionId(),
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
    if (!operationId || !this.activeOperation(request)) {
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
    // The bootstrap answer is what a session needs before its first turn, so
    // it is not gated. The pin mode resolves a credentialed reference and
    // claims the session's diff baselines, so it belongs to a turn.
    if (parsed.data.mode === "pin" && !this.activeOperation(request)) {
      return Response.json({ error: "Pi execution is not active" }, { status: 409 });
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
          externalActions: await this.availableExternalActions(),
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
    // The materialization streams the session's repository through the
    // deployment's source-control credential. It belongs to a turn, so the
    // turn is what authorizes it.
    if (!this.activeOperation(request)) {
      return Response.json({ error: "Pi execution is not active" }, { status: 409 });
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
    if (!this.activeOperation(request)) {
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

  async externalActionPrepare(request: Request): Promise<Response> {
    const operationId = this.externalActionOperation(request);
    if (operationId instanceof Response) return operationId;
    const parsed = externalActionPrepareRequestSchema.safeParse(
      await request.json().catch(() => null)
    );
    if (!parsed.success) {
      return Response.json({ error: "Invalid external action request" }, { status: 400 });
    }
    try {
      const definition = this.options.externalActions!.definitions.get(
        parsed.data.provider,
        parsed.data.action
      );
      if (!definition) {
        return Response.json({ error: "External action provider is unavailable" }, { status: 503 });
      }
      // A new external effect is only admitted while the live deployment
      // mode allows mutations. The gateway itself stays reachable so an
      // emergency cannot strand already-admitted work or audit recovery.
      const liveMode = this.options.externalActions!.liveMode?.();
      if (liveMode !== undefined && liveMode !== "enabled") {
        return Response.json(
          {
            error: "External actions are disabled for new effects by deployment policy",
            code: "external_actions_disabled",
          },
          { status: 403 }
        );
      }
      // A publication that could never complete must never reach an
      // approval card, so the deployment credential is checked first.
      const credentialAvailable = await this.options.externalActions!.credentialAvailable?.(
        parsed.data.provider
      );
      if (credentialAvailable === false) {
        return Response.json(
          {
            error: "This deployment holds no credential for the requested provider",
            code: "external_action_provider_unavailable",
          },
          { status: 409 }
        );
      }
      const providerRequest = definition.requestSchema.safeParse({
        target: parsed.data.target,
        arguments: parsed.data.arguments,
      });
      if (!providerRequest.success) {
        return Response.json({ error: "Invalid provider action request" }, { status: 400 });
      }
      const approval = await this.options.externalActions!.resolveAutomationApproval?.(
        parsed.data.provider,
        parsed.data.action
      );
      const expiresAt = Date.now() + DEFAULT_EXTERNAL_ACTION_APPROVAL_TTL_MS;
      const action = approval
        ? await this.options.externalActions!.gateway.prepare(
            this.options.getSessionId(),
            operationId,
            { ...parsed.data, ...providerRequest.data },
            { ...approval, grantId: approval.grantId },
            { expiresAt }
          )
        : await this.options.externalActions!.gateway.prepare(
            this.options.getSessionId(),
            operationId,
            { ...parsed.data, ...providerRequest.data },
            undefined,
            { expiresAt }
          );
      return Response.json(this.options.externalActions!.gateway.status(action.id), {
        headers: { "Cache-Control": "no-store" },
      });
    } catch (error) {
      return externalActionFailure(error);
    }
  }

  /**
   * The publications this session may propose.
   *
   * A provider is listed only when the deployment named it and the deployment
   * holds a credential for it, so the model never sees a publication that
   * could not complete.
   */
  private async availableExternalActions(): Promise<
    Array<{ provider: string; action: string; toolName: string }>
  > {
    const definitions = this.options.externalActions?.definitions;
    const credentialAvailable = this.options.externalActions?.credentialAvailable;
    if (!definitions || !credentialAvailable) return [];
    const available: Array<{ provider: string; action: string; toolName: string }> = [];
    for (const provider of definitions.providers()) {
      if (!(await credentialAvailable(provider))) continue;
      available.push({
        provider,
        action: definitions.actionFor(provider),
        toolName: externalActionToolName(provider, definitions.actionFor(provider)),
      });
    }
    return available;
  }

  externalActionStatus(request: Request): Response {
    const operationId = this.externalActionOperation(request);
    if (operationId instanceof Response) return operationId;
    const actionId = new URL(request.url).searchParams.get("actionId");
    if (!actionId) return Response.json({ error: "actionId is required" }, { status: 400 });
    try {
      const status = this.options.externalActions!.gateway.status(actionId);
      if (!this.options.externalActions!.gateway.isBoundToOperation(actionId, operationId)) {
        return Response.json(
          { error: "External action is not part of this operation" },
          { status: 404 }
        );
      }
      return Response.json(status, { headers: { "Cache-Control": "no-store" } });
    } catch {
      return Response.json({ error: "External action not found" }, { status: 404 });
    }
  }

  async externalActionExecute(request: Request): Promise<Response> {
    const operationId = this.externalActionOperation(request);
    if (operationId instanceof Response) return operationId;
    const parsed = externalActionIdSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success)
      return Response.json({ error: "Invalid external action execution" }, { status: 400 });
    let status;
    try {
      status = this.options.externalActions!.gateway.status(parsed.data.actionId);
    } catch {
      return Response.json({ error: "External action not found" }, { status: 404 });
    }
    if (!this.options.externalActions!.gateway.isBoundToOperation(status.action.id, operationId)) {
      return Response.json(
        { error: "External action is not part of this operation" },
        { status: 404 }
      );
    }
    const definition = this.options.externalActions!.definitions.get(
      status.action.provider,
      status.action.action
    );
    const executor = definition
      ? this.options.externalActions!.definitions.validatingExecutor(definition)
      : undefined;
    if (!executor) {
      return Response.json({ error: "External action provider is unavailable" }, { status: 503 });
    }
    if (status.action.approval?.source === "automation_grant") {
      const liveApproval = await this.options.externalActions!.resolveAutomationApproval?.(
        status.action.provider,
        status.action.action
      );
      if (
        !liveApproval ||
        liveApproval.grantId !== status.action.approval.grantId ||
        liveApproval.actorId !== status.action.approval.actorId
      ) {
        return Response.json(
          { error: "Automation external-action grant is no longer authorized" },
          { status: 409 }
        );
      }
    }
    await this.options.externalActions!.gateway.execute(status.action.id, executor);
    const after = this.options.externalActions!.gateway.status(status.action.id);
    const reconciliationAt =
      this.options.externalActions!.nextDeadline?.() ??
      this.options.externalActions!.gateway.nextReconciliationAt();
    if (reconciliationAt !== null) {
      await this.options.externalActions!.scheduleReconciliation?.(reconciliationAt);
    }
    return Response.json(after, {
      headers: { "Cache-Control": "no-store" },
    });
  }

  humanExternalActionStatus(request: Request): Response {
    if (!this.options.externalActions?.enabled) {
      return Response.json({ error: "External actions are disabled" }, { status: 404 });
    }
    const actionId = new URL(request.url).searchParams.get("actionId");
    if (!actionId) return Response.json({ error: "actionId is required" }, { status: 400 });
    try {
      const status = this.options.externalActions.gateway.status(actionId);
      if (status.action.sessionId !== this.options.getSessionId()) {
        return Response.json({ error: "External action not found" }, { status: 404 });
      }
      return Response.json(status, { headers: { "Cache-Control": "no-store" } });
    } catch {
      return Response.json({ error: "External action not found" }, { status: 404 });
    }
  }

  /**
   * List the external effects an approver can act on.
   *
   * The list is a SessionDO-owned projection of the durable ledger, so an
   * approver never needs an out-of-band action id and never sees an effect
   * from another session.
   */
  externalActionPending(request: Request): Response {
    if (!this.options.externalActions?.enabled) {
      return Response.json({ error: "External actions are disabled" }, { status: 404 });
    }
    const search = new URL(request.url).searchParams;
    const limit = Number(search.get("limit") ?? "25");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      return Response.json({ error: "Invalid limit" }, { status: 400 });
    }
    const list = this.options.externalActions.gateway.listPending(this.options.getSessionId(), {
      limit,
      cursor: search.get("cursor"),
    });
    return Response.json(list, { headers: { "Cache-Control": "no-store" } });
  }

  async externalActionDecision(request: Request): Promise<Response> {
    if (!this.options.externalActions?.enabled) {
      return Response.json({ error: "External actions are disabled" }, { status: 404 });
    }
    const actorId = request.headers.get("X-External-Action-Actor-ID");
    if (!actorId)
      return Response.json({ error: "External action actor is required" }, { status: 401 });
    const parsed = externalActionDecisionSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success)
      return Response.json({ error: "Invalid external action decision" }, { status: 400 });
    try {
      const current = this.options.externalActions.gateway.status(parsed.data.actionId);
      if (current.action.sessionId !== this.options.getSessionId()) {
        return Response.json({ error: "External action not found" }, { status: 404 });
      }
      if (parsed.data.decision === "approve") {
        // Approving is a new authorization to write outside the session, so
        // it follows the same live gate as preparation. Denying and
        // cancelling stay available so an emergency can always stop work.
        const liveMode = this.options.externalActions.liveMode?.();
        if (liveMode !== undefined && liveMode !== "enabled") {
          return Response.json(
            {
              error: "External action approvals are disabled by deployment policy",
              code: "external_actions_disabled",
            },
            { status: 403 }
          );
        }
        this.options.externalActions.gateway.approve(parsed.data.actionId, {
          source: "human",
          actorId,
          grantId: null,
          requestId: request.headers.get("X-Request-ID") ?? crypto.randomUUID(),
        });
      } else if (parsed.data.decision === "cancel") {
        this.options.externalActions.gateway.cancel(
          parsed.data.actionId,
          actorId,
          parsed.data.reason ?? "Cancelled by approver",
          request.headers.get("X-Request-ID") ?? crypto.randomUUID()
        );
      } else {
        this.options.externalActions.gateway.deny(
          parsed.data.actionId,
          actorId,
          parsed.data.reason ?? "Denied by approver",
          request.headers.get("X-Request-ID") ?? crypto.randomUUID()
        );
      }
      const after = this.options.externalActions.gateway.status(parsed.data.actionId);
      await this.options.externalActions.flushAudit?.();
      const nextDeadline = this.options.externalActions.nextDeadline?.() ?? null;
      if (nextDeadline !== null) {
        await this.options.externalActions.scheduleReconciliation?.(nextDeadline);
      }
      return Response.json(after, {
        headers: { "Cache-Control": "no-store" },
      });
    } catch (error) {
      return externalActionFailure(error);
    }
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
    if (!operationId || !this.activeOperation(request)) {
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

  private activeOperation(request: Request): boolean {
    const operationId = request.headers.get("X-Pi-Operation-ID");
    return (
      this.options.sessions.getSession()?.harness === "pi" &&
      !!operationId &&
      (this.options.messages.getProcessingMessage()?.id === operationId ||
        this.options.controls.isActiveOperation(operationId))
    );
  }

  private externalActionOperation(request: Request): string | Response {
    if (!this.options.externalActions?.enabled) {
      return Response.json({ error: "External actions are disabled" }, { status: 404 });
    }
    const operationId = request.headers.get("X-Pi-Operation-ID");
    if (!operationId || !this.activeOperation(request)) {
      return Response.json({ error: "Pi execution is not active" }, { status: 409 });
    }
    return operationId;
  }
}
