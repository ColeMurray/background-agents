import type { PlanApprovalStatus, ServerMessage } from "@open-inspect/shared";
import type { Logger } from "../../../logger";
import {
  PlanApprovalError,
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
          implementationReasoningEffort = deps.validateReasoningEffort(
            implementationModel,
            body.implementationReasoningEffort
          );
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
  try {
    return JSON.parse(text) as ApprovalRequestBody;
  } catch (e) {
    log.warn("plans.approval.invalid_body", { error: e instanceof Error ? e : String(e) });
    throw new InvalidApprovalBodyError(e);
  }
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
