import { externalActionPrepareRequestSchema } from "@open-inspect/shared";
import type { FeatureCapabilityMode } from "@open-inspect/shared/capability-modes";
import { externalActionToolName } from "@open-inspect/shared/types/external-actions";
import { z } from "zod";
import type { ExternalActionDefinitionRegistry } from "../../external-action-definitions";
import {
  DEFAULT_EXTERNAL_ACTION_APPROVAL_TTL_MS,
  type ExternalActionGateway,
} from "../../external-action-gateway";

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

export interface ExternalActionBridge {
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

export class ExternalActionBridgeHandler {
  constructor(
    private readonly options: ExternalActionBridge,
    private readonly getSessionId: () => string,
    private readonly activeOperation: (request: Request) => boolean
  ) {}

  async contextContributions(): Promise<Record<string, unknown>> {
    return { externalActions: await this.availableExternalActions() };
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
      const definition = this.options.definitions.get(parsed.data.provider, parsed.data.action);
      if (!definition) {
        return Response.json({ error: "External action provider is unavailable" }, { status: 503 });
      }
      // A new external effect is only admitted while the live deployment
      // mode allows mutations. The gateway itself stays reachable so an
      // emergency cannot strand already-admitted work or audit recovery.
      const liveMode = this.options.liveMode?.();
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
      const credentialAvailable = await this.options.credentialAvailable?.(parsed.data.provider);
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
      const approval = await this.options.resolveAutomationApproval?.(
        parsed.data.provider,
        parsed.data.action
      );
      const expiresAt = Date.now() + DEFAULT_EXTERNAL_ACTION_APPROVAL_TTL_MS;
      const action = approval
        ? await this.options.gateway.prepare(
            this.getSessionId(),
            operationId,
            { ...parsed.data, ...providerRequest.data },
            { ...approval, grantId: approval.grantId },
            { expiresAt }
          )
        : await this.options.gateway.prepare(
            this.getSessionId(),
            operationId,
            { ...parsed.data, ...providerRequest.data },
            undefined,
            { expiresAt }
          );
      return Response.json(this.options.gateway.status(action.id), {
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
    const definitions = this.options?.definitions;
    const credentialAvailable = this.options?.credentialAvailable;
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
      const status = this.options.gateway.status(actionId);
      if (!this.options.gateway.isBoundToOperation(actionId, operationId)) {
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
      status = this.options.gateway.status(parsed.data.actionId);
    } catch {
      return Response.json({ error: "External action not found" }, { status: 404 });
    }
    if (!this.options.gateway.isBoundToOperation(status.action.id, operationId)) {
      return Response.json(
        { error: "External action is not part of this operation" },
        { status: 404 }
      );
    }
    const definition = this.options.definitions.get(status.action.provider, status.action.action);
    const executor = definition
      ? this.options.definitions.validatingExecutor(definition)
      : undefined;
    if (!executor) {
      return Response.json({ error: "External action provider is unavailable" }, { status: 503 });
    }
    if (status.action.approval?.source === "automation_grant") {
      const liveApproval = await this.options.resolveAutomationApproval?.(
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
    await this.options.gateway.execute(status.action.id, executor);
    const after = this.options.gateway.status(status.action.id);
    const reconciliationAt =
      this.options.nextDeadline?.() ?? this.options.gateway.nextReconciliationAt();
    if (reconciliationAt !== null) {
      await this.options.scheduleReconciliation?.(reconciliationAt);
    }
    return Response.json(after, {
      headers: { "Cache-Control": "no-store" },
    });
  }

  humanExternalActionStatus(request: Request): Response {
    if (!this.options?.enabled) {
      return Response.json({ error: "External actions are disabled" }, { status: 404 });
    }
    const actionId = new URL(request.url).searchParams.get("actionId");
    if (!actionId) return Response.json({ error: "actionId is required" }, { status: 400 });
    try {
      const status = this.options.gateway.status(actionId);
      if (status.action.sessionId !== this.getSessionId()) {
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
    if (!this.options?.enabled) {
      return Response.json({ error: "External actions are disabled" }, { status: 404 });
    }
    const search = new URL(request.url).searchParams;
    const limit = Number(search.get("limit") ?? "25");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      return Response.json({ error: "Invalid limit" }, { status: 400 });
    }
    const list = this.options.gateway.listPending(this.getSessionId(), {
      limit,
      cursor: search.get("cursor"),
    });
    return Response.json(list, { headers: { "Cache-Control": "no-store" } });
  }

  async externalActionDecision(request: Request): Promise<Response> {
    if (!this.options?.enabled) {
      return Response.json({ error: "External actions are disabled" }, { status: 404 });
    }
    const actorId = request.headers.get("X-External-Action-Actor-ID");
    if (!actorId)
      return Response.json({ error: "External action actor is required" }, { status: 401 });
    const parsed = externalActionDecisionSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success)
      return Response.json({ error: "Invalid external action decision" }, { status: 400 });
    try {
      const current = this.options.gateway.status(parsed.data.actionId);
      if (current.action.sessionId !== this.getSessionId()) {
        return Response.json({ error: "External action not found" }, { status: 404 });
      }
      if (parsed.data.decision === "approve") {
        // Approving is a new authorization to write outside the session, so
        // it follows the same live gate as preparation. Denying and
        // cancelling stay available so an emergency can always stop work.
        const liveMode = this.options.liveMode?.();
        if (liveMode !== undefined && liveMode !== "enabled") {
          return Response.json(
            {
              error: "External action approvals are disabled by deployment policy",
              code: "external_actions_disabled",
            },
            { status: 403 }
          );
        }
        this.options.gateway.approve(parsed.data.actionId, {
          source: "human",
          actorId,
          grantId: null,
          requestId: request.headers.get("X-Request-ID") ?? crypto.randomUUID(),
        });
      } else if (parsed.data.decision === "cancel") {
        this.options.gateway.cancel(
          parsed.data.actionId,
          actorId,
          parsed.data.reason ?? "Cancelled by approver",
          request.headers.get("X-Request-ID") ?? crypto.randomUUID()
        );
      } else {
        this.options.gateway.deny(
          parsed.data.actionId,
          actorId,
          parsed.data.reason ?? "Denied by approver",
          request.headers.get("X-Request-ID") ?? crypto.randomUUID()
        );
      }
      const after = this.options.gateway.status(parsed.data.actionId);
      await this.options.flushAudit?.();
      const nextDeadline = this.options.nextDeadline?.() ?? null;
      if (nextDeadline !== null) {
        await this.options.scheduleReconciliation?.(nextDeadline);
      }
      return Response.json(after, {
        headers: { "Cache-Control": "no-store" },
      });
    } catch (error) {
      return externalActionFailure(error);
    }
  }
  private externalActionOperation(request: Request): string | Response {
    if (!this.options?.enabled) {
      return Response.json({ error: "External actions are disabled" }, { status: 404 });
    }
    const operationId = request.headers.get("X-Pi-Operation-ID");
    if (!operationId || !this.activeOperation(request)) {
      return Response.json({ error: "Pi execution is not active" }, { status: 409 });
    }
    return operationId;
  }
}
