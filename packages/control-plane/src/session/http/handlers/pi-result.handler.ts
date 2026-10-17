import type { SandboxIngressEvent } from "@open-inspect/shared/types/sandbox-events";
import { piRuntimeResultSchema } from "../../../pi/runtime-contract";
import type { MessageRepository } from "../../message-repository";

export class PiResultHandler {
  constructor(
    private readonly messages: Pick<MessageRepository, "getProcessingMessage" | "getMessageById">,
    private readonly processEvent: (event: SandboxIngressEvent) => Promise<void>,
    private readonly getSessionId: () => string,
    private readonly now: () => number = Date.now
  ) {}

  async handle(request: Request): Promise<Response> {
    const parsed = piRuntimeResultSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return Response.json({ error: "Invalid Pi result" }, { status: 400 });
    const result = parsed.data;
    const processing = this.messages.getProcessingMessage();
    if (processing?.id !== result.operationId) {
      const message = this.messages.getMessageById(result.operationId);
      if (message?.status === "completed" || message?.status === "failed") {
        return Response.json({ status: "already_projected" });
      }
      return Response.json({ error: "Pi operation is not processing" }, { status: 409 });
    }

    const timestamp = this.now();
    const sandboxId = `pi:${this.getSessionId()}`;
    if (result.text) {
      await this.processEvent({
        type: "token",
        sandboxId,
        timestamp,
        messageId: result.operationId,
        content: result.text,
        partId: result.operationId,
      });
    }
    if (result.usage) {
      await this.processEvent({
        type: "step_finish",
        sandboxId,
        timestamp,
        messageId: result.operationId,
        stepId: result.operationId,
        cost: null,
        tokens: {
          total: result.usage.total,
          input: result.usage.input,
          output: result.usage.output,
          ...(result.usage.reasoning === undefined ? {} : { reasoning: result.usage.reasoning }),
          cache: { read: result.usage.cacheRead, write: result.usage.cacheWrite },
        },
      });
    }
    const success = result.status === "done";
    if (!success && result.reason) {
      await this.processEvent({
        type: "error",
        sandboxId,
        timestamp,
        messageId: result.operationId,
        error: result.reason,
      });
    }
    await this.processEvent({
      type: "execution_complete",
      sandboxId,
      timestamp,
      messageId: result.operationId,
      success,
      ...(success ? {} : { error: result.reason ?? "Pi execution did not complete" }),
    });
    return Response.json({ status: "projected" });
  }
}
