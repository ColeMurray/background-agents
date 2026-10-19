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
import { externalActionPrepareRequestSchema } from "@open-inspect/shared";
import type { ExternalActionGateway } from "../../external-action-gateway";
import { z } from "zod";
import type { ExternalActionDefinitionRegistry } from "../../external-action-definitions";

const externalActionIdSchema = z.strictObject({ actionId: z.string().min(1) });
const externalActionDecisionSchema = z.strictObject({
  actionId: z.string().min(1),
  decision: z.enum(["approve", "deny"]),
  reason: z.string().min(1).max(1_000).optional(),
});

interface ExternalActionBridge {
  enabled: boolean;
  gateway: Pick<
    ExternalActionGateway,
    | "prepare"
    | "status"
    | "execute"
    | "approve"
    | "deny"
    | "isBoundToOperation"
    | "nextReconciliationAt"
  >;
  definitions: ExternalActionDefinitionRegistry;
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
  sessions: Pick<SessionCoreRepository, "getSession" | "getSessionRepositories">;
  messages: Pick<MessageRepository, "getProcessingMessage">;
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
      return Response.json(
        { error: error instanceof Error ? error.message : "Repository tool failed" },
        { status: 400 }
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
      const action = approval
        ? await this.options.externalActions!.gateway.prepare(
            this.options.getSessionId(),
            operationId,
            { ...parsed.data, ...providerRequest.data },
            { ...approval, grantId: approval.grantId }
          )
        : await this.options.externalActions!.gateway.prepare(
            this.options.getSessionId(),
            operationId,
            { ...parsed.data, ...providerRequest.data }
          );
      return Response.json(this.options.externalActions!.gateway.status(action.id), {
        headers: { "Cache-Control": "no-store" },
      });
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : "External action preparation failed" },
        { status: 409 }
      );
    }
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
        this.options.externalActions.gateway.approve(parsed.data.actionId, {
          source: "human",
          actorId,
          grantId: null,
          requestId: request.headers.get("X-Request-ID") ?? crypto.randomUUID(),
        });
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
      return Response.json(
        { error: error instanceof Error ? error.message : "External action decision failed" },
        { status: 409 }
      );
    }
  }

  private activeOperation(request: Request): boolean {
    const operationId = request.headers.get("X-Pi-Operation-ID");
    return (
      this.options.sessions.getSession()?.harness === "pi" &&
      !!operationId &&
      this.options.messages.getProcessingMessage()?.id === operationId
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
