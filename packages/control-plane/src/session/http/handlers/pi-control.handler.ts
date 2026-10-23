import { z } from "zod";
import {
  piRuntimeControlCompletionSchema,
  piRuntimeControlSchema,
  type PiHumanControl,
  type PiRuntimeControl,
  type PiRuntimeDispatch,
} from "../../../pi/runtime-contract";
import type { Logger } from "../../../logger";
import { isSessionPromptable } from "@open-inspect/shared/types/session-activity";
import { sha256Hex } from "@open-inspect/shared/service-auth";
import type { SessionCoreRepository } from "../../session-core-repository";
import type { PiControlRepository } from "../../pi-control-repository";
import type { PiOperationRepository } from "../../pi-operation-repository";
import { EXECUTION_DEADLINE_GRACE_MS } from "../../../scheduler/scheduler";
import { piControlRequestIdFromMessageId } from "../../pi-control-message-id";

const CONTROL_TIMEOUT_MS = 15_000;
const envelopeSchema = z.strictObject({
  actorId: z.string().min(1).max(128),
  canonicalUserId: z.string().min(1).max(128).nullable().optional(),
  source: z.enum(["web", "slack", "pi"]),
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
const HUMAN_CONTROL_ACTIONS = new Set([
  "send",
  "follow_up",
  "cancel_exact",
  "retry_parked",
  "fork",
  "reset",
  "handoff",
  "compact",
]);
const MODEL_CONTROL_ACTIONS = new Set(["submit", "send", "follow_up", "compact"]);

export class PiControlHandler {
  constructor(
    private readonly sessions: Pick<SessionCoreRepository, "getSession">,
    private readonly receipts: PiControlRepository,
    private readonly runtime: Pick<PiRuntimeDispatch, "control"> | undefined,
    private readonly log: Logger,
    private readonly recordHumanControl: (input: {
      actorId: string;
      canonicalUserId?: string | null;
      source: "web" | "slack";
      requestId: string;
      requestFingerprint: string;
      control: PiHumanControl;
    }) => { conflict: boolean; deduplicated: boolean; messageId?: string },
    private readonly enqueueModelControl: (input: {
      actorId: string;
      canonicalUserId?: string | null;
      source: "web" | "slack";
      requestId: string;
      control: Extract<PiHumanControl, { action: "compact" }>;
    }) => Promise<{ messageId: string; deduplicated: boolean }>,
    /**
     * Record the terminal event of a control turn.
     *
     * The runtime's completion closes both canonical queued compactions and
     * non-model lifecycle controls idempotently through the normal event path.
     */
    private readonly recordTerminal: (input: {
      operationId: string;
      success: boolean;
      error?: string;
      costUsd: number;
      now: number;
    }) => Promise<void>,
    /**
     * The session's record of the turns the runtime is running.
     *
     * A turn that arrives through a control is recorded here before the
     * runtime is called, so the session knows the operation the runtime's
     * events will name.
     */
    private readonly operations?: Pick<PiOperationRepository, "begin" | "transition" | "get">,
    private readonly getExecutionTimeoutMs: () => number = () => CONTROL_TIMEOUT_MS,
    private readonly dispatchQueuedControl: () => Promise<void> = async () => {}
  ) {}
  async handle(request: Request): Promise<Response> {
    const parsed = envelopeSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success)
      return Response.json({ error: "Invalid Pi control request" }, { status: 400 });
    const { actorId, canonicalUserId, source, control } = parsed.data;
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
    const requestHash = await controlRequestHash(control);
    let admission;
    try {
      admission = this.receipts.admit(
        {
          requestId: control.requestId,
          requestHash,
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
    if ((source === "web" || source === "slack") && control.action === "compact") {
      if (!admission.created) {
        const current = this.receipts.get(control.requestId) ?? receipt;
        return Response.json(
          { requestId: current.requestId, state: current.state, result: current.result },
          { status: current.state === "accepted" || current.state === "processing" ? 202 : 200 }
        );
      }
      try {
        const queued = await this.enqueueModelControl({
          actorId,
          canonicalUserId,
          source,
          requestId: control.requestId,
          control,
        });
        if (queued.deduplicated) {
          this.receipts.settle(
            control.requestId,
            "failed",
            undefined,
            "expired_idempotency_receipt",
            Date.now()
          );
          return Response.json(
            { error: "Pi control receipt expired; use a new request id" },
            { status: 409 }
          );
        }
        this.receipts.attachOperation(control.requestId, queued.messageId);
        this.receipts.settle(
          control.requestId,
          "accepted",
          { messageId: queued.messageId },
          undefined,
          Date.now()
        );
        await this.dispatchQueuedControl();
        return Response.json(
          {
            requestId: control.requestId,
            state: "accepted",
            result: { messageId: queued.messageId },
          },
          { status: 202 }
        );
      } catch (error) {
        this.receipts.settle(
          control.requestId,
          "failed",
          undefined,
          isDeterministicControlError(error) ? "rejected" : "queue_unavailable",
          Date.now()
        );
        const status = isDeterministicControlError(error) ? 409 : 503;
        return Response.json({ error: "Pi compaction could not be queued" }, { status });
      }
    }
    let projection: { conflict: boolean; deduplicated: boolean; messageId?: string } | undefined;
    if ((source === "web" || source === "slack") && isHumanControl(control)) {
      try {
        projection = this.recordHumanControl({
          actorId,
          canonicalUserId,
          source,
          requestId: control.requestId,
          requestFingerprint: requestHash,
          control,
        });
        if (projection?.conflict) {
          if (admission.created) {
            this.receipts.settle(
              control.requestId,
              "failed",
              undefined,
              "message_projection_conflict",
              Date.now()
            );
          }
          return Response.json({ error: "Pi control request id conflict" }, { status: 409 });
        }
      } catch (error) {
        if (admission.created) {
          this.receipts.settle(
            control.requestId,
            "failed",
            undefined,
            "message_projection_failed",
            Date.now()
          );
        }
        this.log.error("pi.control_projection_failed", {
          event: "pi.control_projection_failed",
          request_id: control.requestId,
          error: error instanceof Error ? error.message : String(error),
        });
        return Response.json({ error: "Pi control projection failed" }, { status: 500 });
      }
    }
    if (admission.created && projection?.deduplicated) {
      this.receipts.settle(
        control.requestId,
        "failed",
        undefined,
        "expired_idempotency_receipt",
        Date.now()
      );
      return Response.json(
        { error: "Pi control receipt expired; use a new request id" },
        { status: 409 }
      );
    }
    if (!admission.created) {
      // Completion may race the duplicate between admission and message
      // projection. Re-read the durable receipt instead of returning the
      // stale snapshot captured by admit().
      const current = this.receipts.get(control.requestId) ?? receipt;
      if (current.state !== "processing")
        return Response.json(
          { requestId: current.requestId, state: current.state, result: current.result },
          { status: current.state === "accepted" ? 202 : 200 }
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
    // The turn the runtime is about to run belongs to the message the
    // session just recorded, so the session records the operation first and
    // names it to the runtime. Without that, the runtime's turn belongs to
    // an id the session has no message for, and every capability call that
    // names the operation is refused.
    const operationId = projection?.messageId;
    if (operationId && this.operations) {
      const now = Date.now();
      this.operations.begin(operationId, now);
      this.receipts.attachOperation(control.requestId, operationId);
      this.operations.transition(operationId, ["dispatching"], "dispatching", now);
    }
    try {
      const runtimeControl = {
        ...control,
        ...(operationId ? { operationId } : {}),
        ...(MODEL_CONTROL_ACTIONS.has(control.action)
          ? {
              executionDeadlineMs:
                Date.now() + this.getExecutionTimeoutMs() + EXECUTION_DEADLINE_GRACE_MS,
            }
          : {}),
      } as PiRuntimeControl;
      const result = await withTimeout(this.runtime.control(runtimeControl), CONTROL_TIMEOUT_MS);
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
      // A deterministic rejection never runs a turn, so the message it was
      // recorded as would otherwise never receive a terminal event. An
      // indeterminate outcome may still run; its completion carries the
      // terminal event.
      if (deterministic && operationId) {
        await this.recordTerminal({
          operationId,
          success: false,
          error: code,
          costUsd: 0,
          now: Date.now(),
        });
      }
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
    let linkedReceipt =
      this.receipts.get(parsed.data.requestId) ??
      this.receipts.getByOperationId(parsed.data.requestId) ??
      this.receipts.get(piControlRequestIdFromMessageId(parsed.data.requestId) ?? "");
    if (linkedReceipt && !linkedReceipt.operationId) {
      this.receipts.attachOperation(linkedReceipt.requestId, parsed.data.requestId);
      linkedReceipt = this.receipts.get(linkedReceipt.requestId);
    }
    const completion = this.receipts.complete(
      linkedReceipt?.requestId ?? parsed.data.requestId,
      parsed.data.status,
      parsed.data.errorCode,
      now
    );
    if (!completion.receipt)
      return Response.json({ error: "Pi control receipt not found" }, { status: 404 });
    // The receipt is settled; the turn's message still needs its terminal
    // event. It is written on every completion, not only the first, because
    // the event upsert is idempotent and a retry may be all that survives a
    // crash between the receipt and the timeline.
    if (completion.receipt.operationId) {
      await this.recordTerminal({
        operationId: completion.receipt.operationId,
        success: parsed.data.status === "completed",
        ...(parsed.data.errorCode ? { error: parsed.data.errorCode } : {}),
        costUsd: parsed.data.costUsd,
        now,
      });
    }
    this.receipts.prune();
    return Response.json({ status: completion.changed ? "recorded" : "already_recorded" });
  }
}
function isHumanControl(control: PiRuntimeControl): control is PiHumanControl {
  return HUMAN_CONTROL_ACTIONS.has(control.action);
}
async function controlRequestHash(control: unknown): Promise<string> {
  return sha256Hex(JSON.stringify(control));
}
function isDeterministicControlError(error: unknown) {
  return (
    error instanceof Error &&
    /(limit reached|not found|not active|requires a child|cannot change model|bound to an active submission|unsupported|target is required|\bbusy\b)/i.test(
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
