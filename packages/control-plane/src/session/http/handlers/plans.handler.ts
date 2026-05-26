import type { PlanApprovalStatus, ServerMessage } from "@open-inspect/shared";
import type { Logger } from "../../../logger";
import {
  PlanApprovalError,
  type PlanResponse,
  type PlanService,
  type SavePlanRequest,
} from "../../services/plan.service";
import { getValidModelOrDefault, isValidModel } from "../../../utils/models";

export interface PlansHandlerDeps {
  planService: PlanService;
  getLog: () => Logger;
  /** Broadcast a ServerMessage to all subscribed clients. */
  broadcast: (msg: ServerMessage) => void;
  /** Read the current plan-approval status from the session row. */
  getPlanApprovalStatus: () => PlanApprovalStatus | null;
  /**
   * Validate a reasoning effort value against a given model. Returns the
   * normalized effort, or null when the effort isn't valid for the model.
   */
  validateReasoningEffort: (model: string, effort: string | undefined) => string | null;
  /**
   * Fire-and-forget cross-channel plan verdict notification. The handler
   * calls this after a successful approve/reject; the implementation
   * routes the call to the originating bot when the verdict came from a
   * different channel (e.g. web-approving a Slack-triggered plan).
   * No-op if the bot's own modal/webhook handler already updated the UI.
   */
  notifyPlanVerdict?: (params: {
    plan: PlanResponse;
    verdict: "approved" | "rejected";
    approverAuthorId: string | null;
    implementationModel?: string | null;
    reason?: string | null;
  }) => void;
}

export interface PlansHandler {
  savePlan: (request: Request) => Promise<Response>;
  getCurrentPlan: () => Response;
  listPlans: (url: URL) => Response;
  approvePlan: (request: Request) => Promise<Response>;
  rejectPlan: (request: Request) => Promise<Response>;
}

interface ApprovalRequestBody {
  approverAuthorId?: string | null;
  reason?: string | null;
  implementationModel?: string | null;
  implementationReasoningEffort?: string | null;
}

export function createPlansHandler(deps: PlansHandlerDeps): PlansHandler {
  return {
    async savePlan(request: Request): Promise<Response> {
      let body: SavePlanRequest;
      try {
        body = (await request.json()) as SavePlanRequest;
      } catch (e) {
        deps
          .getLog()
          .warn("plans.save.invalid_body", { error: e instanceof Error ? e : String(e) });
        return Response.json({ error: "Invalid JSON body" }, { status: 400 });
      }

      if (!body || typeof body.content !== "string") {
        return Response.json({ error: "content is required" }, { status: 400 });
      }

      try {
        const result = deps.planService.savePlan(body);
        if (result.approvalGated) {
          deps.broadcast({
            type: "plan_status",
            status: "awaiting_approval",
            plan: result.plan,
          });
        }
        return Response.json(
          { plan: result.plan, approvalGated: result.approvalGated },
          {
            status: 201,
          }
        );
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        deps.getLog().warn("plans.save.failed", { error: message });
        return Response.json({ error: message }, { status: 400 });
      }
    },

    getCurrentPlan(): Response {
      const plan = deps.planService.getCurrentPlan();
      const status = deps.getPlanApprovalStatus();
      return Response.json({ plan, status });
    },

    listPlans(url: URL): Response {
      const rawLimit = url.searchParams.get("limit");
      const parsed = rawLimit ? parseInt(rawLimit, 10) : 20;
      const limit = Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 100) : 20;
      const plans = deps.planService.listPlans(limit);
      return Response.json({ plans });
    },

    async approvePlan(request: Request): Promise<Response> {
      try {
        const body = await readApprovalBody(request, deps.getLog());

        let implementationModel: string | null = null;
        if (body.implementationModel) {
          if (!isValidModel(body.implementationModel)) {
            return Response.json(
              { error: "Invalid implementationModel", code: "invalid_model" },
              { status: 400 }
            );
          }
          implementationModel = getValidModelOrDefault(body.implementationModel);
        }

        // Reasoning effort handling:
        //  - undefined (omitted)     → no change; service won't update the field.
        //  - null (explicit clear)   → forwarded as null; service clears it.
        //  - string + model override → validated against the model.
        //  - string without override → reject with 400. Previously we coerced
        //    a non-null string into null (the validation target was ""), which
        //    the service treated as an explicit "clear effort" and wiped the
        //    session's persisted reasoning_effort.
        let implementationReasoningEffort: string | null | undefined = undefined;
        if (body.implementationReasoningEffort === null) {
          implementationReasoningEffort = null;
        } else if (body.implementationReasoningEffort !== undefined) {
          if (!implementationModel) {
            return Response.json(
              {
                error: "implementationReasoningEffort requires implementationModel",
                code: "invalid_reasoning_effort",
              },
              { status: 400 }
            );
          }
          // validateReasoningEffort returns null for unsupported effort values,
          // but null is also our explicit "clear the persisted effort" sentinel.
          // Reject the invalid-value case with 400 rather than silently treating
          // it as a clear request — otherwise a typo in the effort string would
          // wipe the session's reasoning_effort instead of being rejected.
          const normalized = deps.validateReasoningEffort(
            implementationModel,
            body.implementationReasoningEffort
          );
          if (normalized === null) {
            return Response.json(
              {
                error: `Invalid implementationReasoningEffort "${body.implementationReasoningEffort}" for model ${implementationModel}`,
                code: "invalid_reasoning_effort",
              },
              { status: 400 }
            );
          }
          implementationReasoningEffort = normalized;
        }

        const result = await deps.planService.approvePlanAndFlush({
          approverAuthorId: body.approverAuthorId,
          implementationModel,
          implementationReasoningEffort,
        });
        deps.broadcast({
          type: "plan_status",
          status: result.status,
          plan: result.plan,
          model: result.postApproval?.model,
          reasoningEffort: result.postApproval?.reasoningEffort,
          planCostSnapshot: result.postApproval?.planCostSnapshot,
        });
        deps.notifyPlanVerdict?.({
          plan: result.plan,
          verdict: "approved",
          approverAuthorId: body.approverAuthorId ?? null,
          implementationModel,
        });
        return Response.json({ status: result.status, plan: result.plan });
      } catch (e) {
        return errorResponseForApproval(e, deps.getLog(), "plans.approve.failed");
      }
    },

    async rejectPlan(request: Request): Promise<Response> {
      try {
        const body = await readApprovalBody(request, deps.getLog());
        const result = deps.planService.rejectPlan({
          approverAuthorId: body.approverAuthorId,
          reason: body.reason,
        });
        deps.broadcast({ type: "plan_status", status: result.status, plan: result.plan });
        deps.notifyPlanVerdict?.({
          plan: result.plan,
          verdict: "rejected",
          approverAuthorId: body.approverAuthorId ?? null,
          reason: body.reason ?? null,
        });
        return Response.json({ status: result.status, plan: result.plan });
      } catch (e) {
        return errorResponseForApproval(e, deps.getLog(), "plans.reject.failed");
      }
    },
  };
}

/**
 * Thrown by readApprovalBody when the request body exists but is not valid
 * JSON. Mapped to HTTP 400 by errorResponseForApproval; previously the body
 * was silently coerced to {} which masked client bugs and could leak partial
 * approve/reject parameters into downstream calls.
 */
class InvalidApprovalBodyError extends Error {
  constructor(cause: unknown) {
    super(`Invalid approval body: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "InvalidApprovalBodyError";
  }
}

async function readApprovalBody(request: Request, log: Logger): Promise<ApprovalRequestBody> {
  if (request.headers.get("content-length") === "0") return {};
  const text = await request.text();
  if (!text.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    log.warn("plans.approval.invalid_body", { error: e instanceof Error ? e : String(e) });
    throw new InvalidApprovalBodyError(e);
  }
  // JSON.parse("null") returns null, JSON.parse("[1]") returns an array,
  // and JSON.parse("42") returns a number — all syntactically valid JSON
  // but not the object payload we expect. Treat them as malformed bodies
  // so callers don't dereference properties on non-objects (which would
  // either crash with TypeError on null, or silently no-op on primitives
  // and let arrays through as objects).
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    log.warn("plans.approval.invalid_body", {
      error: `Expected JSON object, got ${parsed === null ? "null" : Array.isArray(parsed) ? "array" : typeof parsed}`,
    });
    throw new InvalidApprovalBodyError(new Error("Expected JSON object"));
  }
  return parsed as ApprovalRequestBody;
}

function errorResponseForApproval(e: unknown, log: Logger, logEvent: string): Response {
  if (e instanceof InvalidApprovalBodyError) {
    log.info(logEvent, { code: "invalid_body", message: e.message });
    return Response.json({ error: e.message, code: "invalid_body" }, { status: 400 });
  }
  if (e instanceof PlanApprovalError) {
    const status = e.code === "invalid_status" ? 409 : 400;
    log.info(logEvent, { code: e.code, message: e.message });
    return Response.json({ error: e.message, code: e.code }, { status });
  }
  const message = e instanceof Error ? e.message : String(e);
  log.warn(logEvent, { error: message });
  return Response.json({ error: message }, { status: 500 });
}
