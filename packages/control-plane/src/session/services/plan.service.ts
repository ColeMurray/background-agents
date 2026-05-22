import type { PlanApprovalStatus } from "../../types";
import type { PlanRow, PlanSource } from "../types";
import type { SessionRepository } from "../repository";

export interface SavePlanRequest {
  content: string;
  source?: PlanSource;
  authorId?: string | null;
  messageId?: string | null;
}

export interface ApprovalRequest {
  approverAuthorId?: string | null;
  reason?: string | null;
  /**
   * When approving, the model the queued/next implementation turn should use.
   * The service writes this into the session row before flushing the queue, so
   * the dispatched prompt picks it up via the normal model-resolution path.
   * Ignored on reject. Caller is responsible for validating against the model
   * whitelist (the service writes the value verbatim).
   */
  implementationModel?: string | null;
  /**
   * When approving, the reasoning effort to apply alongside implementationModel.
   * Caller is responsible for validating against the chosen model.
   */
  implementationReasoningEffort?: string | null;
}

export interface PlanResponse {
  id: string;
  version: number;
  content: string;
  createdByAuthorId: string | null;
  createdByMessageId: string | null;
  source: PlanSource;
  createdAt: number;
}

export interface SavePlanResult {
  plan: PlanResponse;
  /** True when this call flipped the session into awaiting_approval (plan-mode + new plan saved). */
  approvalGated: boolean;
  /**
   * True when the request was deduplicated against an existing version
   * (same content + same created_by_message_id as the latest plan).
   */
  deduped: boolean;
}

export interface ApprovalResult {
  status: PlanApprovalStatus;
  plan: PlanResponse;
  /**
   * Snapshot of the session fields that the approval transaction wrote.
   * Populated on approve (so the broadcast can sync sidebar state without a
   * refetch). Undefined on reject.
   */
  postApproval?: {
    model: string;
    reasoningEffort: string | null;
    planCostSnapshot: number | null;
  };
}

/**
 * Hard cap on persisted plan content. Plans are echoed back as preambles on
 * subsequent prompts, so an unbounded plan would balloon every downstream call.
 */
export const MAX_PLAN_CONTENT_BYTES = 16 * 1024;

interface PlanServiceDeps {
  repository: SessionRepository;
  generateId: () => string;
  now: () => number;
  /**
   * Invoked after a plan is approved (status flipped to "approved").
   * The session DO uses this to flush any queued user message: a follow-up
   * sent while the plan was awaiting approval should be dispatched as the
   * first implementation turn.
   */
  onPlanApproved?: () => void | Promise<void>;
}

function toResponse(row: PlanRow): PlanResponse {
  return {
    id: row.id,
    version: row.version,
    content: row.content,
    createdByAuthorId: row.created_by_author_id,
    createdByMessageId: row.created_by_message_id,
    source: row.source,
    createdAt: row.created_at,
  };
}

export class PlanService {
  constructor(private readonly deps: PlanServiceDeps) {}

  savePlan(request: SavePlanRequest): SavePlanResult {
    const content = request.content.trim();
    if (!content) {
      throw new Error("Plan content cannot be empty");
    }

    const byteLength = new TextEncoder().encode(content).length;
    if (byteLength > MAX_PLAN_CONTENT_BYTES) {
      throw new Error(
        `Plan content exceeds ${MAX_PLAN_CONTENT_BYTES} bytes (got ${byteLength}); please trim before saving.`
      );
    }

    // Idempotent dedup: if the last plan has the same content AND was created
    // for the same message id, return it rather than bumping the version. This
    // covers callback retries that re-deliver the same save_plan event.
    const previous = this.deps.repository.getCurrentPlan();
    const requestMessageId = request.messageId ?? null;
    if (
      previous &&
      previous.content === content &&
      previous.created_by_message_id === requestMessageId
    ) {
      return { plan: toResponse(previous), approvalGated: false, deduped: true };
    }

    const now = this.deps.now();
    const row = this.deps.repository.savePlan({
      id: this.deps.generateId(),
      content,
      createdByAuthorId: request.authorId ?? null,
      createdByMessageId: requestMessageId,
      source: request.source ?? "api",
      createdAt: now,
    });

    let approvalGated = false;
    const session = this.deps.repository.getSession();
    if (session?.plan_mode === 1) {
      this.deps.repository.updatePlanApprovalStatus("awaiting_approval", now);
      approvalGated = true;
    }

    this.deps.repository.createEvent({
      id: this.deps.generateId(),
      type: "plan_saved",
      data: JSON.stringify({
        planId: row.id,
        version: row.version,
        source: row.source,
        approvalGated,
      }),
      messageId: requestMessageId,
      createdAt: now,
    });

    return { plan: toResponse(row), approvalGated, deduped: false };
  }

  async approvePlanAndFlush(request: ApprovalRequest = {}): Promise<ApprovalResult> {
    const result = this.approvePlan(request);
    if (this.deps.onPlanApproved) {
      await this.deps.onPlanApproved();
    }
    return result;
  }

  approvePlan(request: ApprovalRequest = {}): ApprovalResult {
    const session = this.deps.repository.getSession();
    if (!session || session.plan_mode !== 1) {
      throw new PlanApprovalError("Session is not in plan mode", "not_plan_mode");
    }
    if (session.plan_approval_status !== "awaiting_approval") {
      throw new PlanApprovalError(
        `Plan cannot be approved from status "${session.plan_approval_status ?? "null"}"`,
        "invalid_status"
      );
    }
    const plan = this.deps.repository.getCurrentPlan();
    if (!plan) {
      throw new PlanApprovalError("No plan to approve", "no_plan");
    }
    const now = this.deps.now();

    // Switch the session to the caller-chosen implementation model BEFORE
    // flipping the approval gate. The flush in approvePlanAndFlush() will
    // then dispatch with the new model via the normal resolution path.
    if (request.implementationModel) {
      this.deps.repository.updateSessionModel(request.implementationModel, now);
    }
    if (request.implementationReasoningEffort !== undefined) {
      this.deps.repository.updateSessionReasoningEffort(request.implementationReasoningEffort, now);
    }

    this.deps.repository.updatePlanApprovalStatus("approved", now);
    this.deps.repository.snapshotPlanCost(now);
    this.deps.repository.createEvent({
      id: this.deps.generateId(),
      type: "plan_approved",
      data: JSON.stringify({
        planId: plan.id,
        version: plan.version,
        approverAuthorId: request.approverAuthorId ?? null,
        implementationModel: request.implementationModel ?? null,
        implementationReasoningEffort: request.implementationReasoningEffort ?? null,
      }),
      messageId: null,
      createdAt: now,
    });

    // Re-read the row so the broadcast carries the values the DB committed —
    // even when the caller didn't override the impl model/effort, the snapshot
    // still needs to reach the client.
    const updated = this.deps.repository.getSession();
    return {
      status: "approved",
      plan: toResponse(plan),
      postApproval: {
        model: updated?.model ?? session.model,
        reasoningEffort: updated?.reasoning_effort ?? null,
        planCostSnapshot: updated?.plan_cost_snapshot ?? null,
      },
    };
  }

  rejectPlan(request: ApprovalRequest = {}): ApprovalResult {
    const session = this.deps.repository.getSession();
    if (!session || session.plan_mode !== 1) {
      throw new PlanApprovalError("Session is not in plan mode", "not_plan_mode");
    }
    if (session.plan_approval_status !== "awaiting_approval") {
      throw new PlanApprovalError(
        `Plan cannot be rejected from status "${session.plan_approval_status ?? "null"}"`,
        "invalid_status"
      );
    }
    const plan = this.deps.repository.getCurrentPlan();
    if (!plan) {
      throw new PlanApprovalError("No plan to reject", "no_plan");
    }
    const now = this.deps.now();
    this.deps.repository.updatePlanApprovalStatus("rejected", now);
    this.deps.repository.createEvent({
      id: this.deps.generateId(),
      type: "plan_rejected",
      data: JSON.stringify({
        planId: plan.id,
        version: plan.version,
        rejecterAuthorId: request.approverAuthorId ?? null,
        reason: request.reason ?? null,
      }),
      messageId: null,
      createdAt: now,
    });
    return { status: "rejected", plan: toResponse(plan) };
  }

  getCurrentPlan(): PlanResponse | null {
    const row = this.deps.repository.getCurrentPlan();
    return row ? toResponse(row) : null;
  }

  listPlans(limit = 20): PlanResponse[] {
    return this.deps.repository.listPlans(limit).map(toResponse);
  }
}

export type PlanApprovalErrorCode = "not_plan_mode" | "invalid_status" | "no_plan";

export class PlanApprovalError extends Error {
  constructor(
    message: string,
    readonly code: PlanApprovalErrorCode
  ) {
    super(message);
    this.name = "PlanApprovalError";
  }
}
