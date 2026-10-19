import { z } from "zod";
import {
  piRuntimeControlCompletionSchema,
  piRuntimeControlSchema,
  type PiRuntimeDispatch,
} from "../../../pi/runtime-contract";
import type { Logger } from "../../../logger";
import { isSessionPromptable } from "@open-inspect/shared/types/session-activity";
import { sha256Hex } from "@open-inspect/shared/service-auth";
import type { SessionCoreRepository } from "../../session-core-repository";
import type { PiControlRepository } from "../../pi-control-repository";

const CONTROL_TIMEOUT_MS = 15_000;
const envelopeSchema = z.strictObject({
  actorId: z.string().min(1).max(128),
  source: z.string().min(1).max(32),
  control: piRuntimeControlSchema,
});
const READ_ACTIONS = new Set([
  "list_conversations",
  "get_conversation",
  "get_last_message",
  "inspect_agents",
  "task_graph",
  "inspect",
]);

export class PiControlHandler {
  constructor(
    private readonly sessions: Pick<
      SessionCoreRepository,
      "getSession" | "addSessionCost" | "setSessionBudget" | "transaction"
    >,
    private readonly receipts: PiControlRepository,
    private readonly runtime: Pick<PiRuntimeDispatch, "control"> | undefined,
    private readonly log: Logger
  ) {}
  async handle(request: Request): Promise<Response> {
    const parsed = envelopeSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success)
      return Response.json({ error: "Invalid Pi control request" }, { status: 400 });
    const { actorId, source, control } = parsed.data;
    const session = this.sessions.getSession();
    if (!session || session.harness !== "pi")
      return Response.json({ error: "Session does not use Pi Durable" }, { status: 409 });
    if (session.session_name !== control.sessionId)
      return Response.json({ error: "Pi control session identity mismatch" }, { status: 409 });
    const read = READ_ACTIONS.has(control.action);
    if (!read && !isSessionPromptable(session.status))
      return Response.json({ error: "Session does not accept Pi controls" }, { status: 409 });
    if (!read && session.budget_exhausted === 1)
      return Response.json({ error: "Session budget is exhausted" }, { status: 409 });
    if (!this.runtime)
      return Response.json({ error: "Pi Durable is unavailable" }, { status: 503 });
    let admission;
    try {
      admission = this.receipts.admit(
        {
          requestId: control.requestId,
          requestHash: await controlRequestHash(control),
          action: control.action,
          actorId,
          source,
          ...("conversationId" in control && control.conversationId
            ? { conversationId: control.conversationId }
            : {}),
          ...("operationId" in control && control.operationId
            ? { operationId: control.operationId }
            : {}),
          ...("submissionId" in control && control.submissionId
            ? { submissionId: control.submissionId }
            : {}),
          ...("taskId" in control && control.taskId ? { taskId: control.taskId } : {}),
        },
        Date.now()
      );
    } catch {
      return Response.json({ error: "Pi control request id conflict" }, { status: 409 });
    }
    const receipt = admission.receipt;
    if (!admission.created) {
      if (receipt.state !== "processing")
        return Response.json(
          { requestId: receipt.requestId, state: receipt.state, result: receipt.result },
          { status: receipt.state === "accepted" ? 202 : 200 }
        );
      return Response.json(
        { requestId: control.requestId, state: "indeterminate" },
        { status: 202 }
      );
    }
    this.log.info("pi.control", {
      event: "pi.control",
      request_id: control.requestId,
      action: control.action,
      actor_id: actorId,
      source,
    });
    try {
      const result = await withTimeout(this.runtime.control(control), CONTROL_TIMEOUT_MS);
      this.receipts.settle(control.requestId, result.state, result.result, undefined, Date.now());
      this.receipts.prune();
      return Response.json(result, { status: result.state === "accepted" ? 202 : 200 });
    } catch (error) {
      const deterministic = read || isDeterministicControlError(error);
      const state = deterministic ? "failed" : "indeterminate";
      const code =
        error instanceof Error && error.message.includes("timed out")
          ? "timeout"
          : deterministic
            ? "rejected"
            : "runtime_unavailable";
      const settled = this.receipts.settle(control.requestId, state, undefined, code, Date.now());
      return Response.json(
        {
          error:
            state === "indeterminate"
              ? "Pi control outcome is indeterminate"
              : "Pi control was rejected",
          requestId: control.requestId,
          state: settled?.state,
        },
        { status: state === "indeterminate" ? 503 : 400 }
      );
    }
  }

  async complete(request: Request): Promise<Response> {
    const parsed = piRuntimeControlCompletionSchema.safeParse(
      await request.json().catch(() => null)
    );
    if (!parsed.success)
      return Response.json({ error: "Invalid Pi control completion" }, { status: 400 });
    const session = this.sessions.getSession();
    if (!session || session.harness !== "pi")
      return Response.json({ error: "Session does not use Pi Durable" }, { status: 409 });
    const now = Date.now();
    const completion = this.sessions.transaction(() => {
      const result = this.receipts.complete(
        parsed.data.requestId,
        parsed.data.status,
        parsed.data.errorCode,
        now
      );
      if (result.changed && parsed.data.costUsd > 0) {
        const totalCost = this.sessions.addSessionCost(parsed.data.costUsd, now);
        if (session.max_cost_usd !== null && totalCost >= session.max_cost_usd) {
          this.sessions.setSessionBudget(session.max_cost_usd, true, now);
        }
      }
      return result;
    });
    if (!completion.receipt)
      return Response.json({ error: "Pi control receipt not found" }, { status: 404 });
    this.receipts.prune();
    return Response.json({ status: completion.changed ? "recorded" : "already_recorded" });
  }
}
async function controlRequestHash(control: unknown): Promise<string> {
  return sha256Hex(JSON.stringify(control));
}
function isDeterministicControlError(error: unknown) {
  return (
    error instanceof Error &&
    /(limit reached|not found|not active|requires a child|cannot change model|bound to an active submission|unsupported|target is required)/i.test(
      error.message
    )
  );
}
async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Pi control timed out")), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
