import type { SandboxIngressEvent } from "@open-inspect/shared/types/sandbox-events";
import { piRuntimeResultSchema } from "../../../pi/runtime-contract";
import type { MessageRepository } from "../../message-repository";

export class PiResultHandler {
  constructor(
    private readonly messages: Pick<MessageRepository, "getProcessingMessage" | "getMessageById">,
    private readonly processEvent: (event: SandboxIngressEvent) => Promise<void>,
    private readonly receipts: {
      has(operationId: string): boolean;
      record(operationId: string, projectedAt: number): void;
    },
    private readonly recoverTerminal: (result: {
      operationId: string;
      success: boolean;
      error?: string;
    }) => Promise<void>,
    private readonly isPiSession: () => boolean,
    private readonly getSessionId: () => string,
    private readonly now: () => number = Date.now,
    private readonly settleOperation: (operationId: string, settledAt: number) => void = () => {}
  ) {}

  async handle(request: Request): Promise<Response> {
    const parsed = piRuntimeResultSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return Response.json({ error: "Invalid Pi result" }, { status: 400 });
    if (!this.isPiSession()) {
      return Response.json({ error: "Session does not use Pi Durable" }, { status: 409 });
    }
    const result = parsed.data;
    if (this.receipts.has(result.operationId)) {
      return Response.json({ status: "already_projected" });
    }
    const processing = this.messages.getProcessingMessage();
    if (processing?.id !== result.operationId) {
      const message = this.messages.getMessageById(result.operationId);
      if (message?.status === "completed" || message?.status === "failed") {
        await this.recoverTerminal({
          operationId: result.operationId,
          success: message.status === "completed",
          ...(message.error_message ? { error: message.error_message } : {}),
        });
        const settledAt = this.now();
        this.receipts.record(result.operationId, settledAt);
        this.settleOperation(result.operationId, settledAt);
        return Response.json({ status: "recovered" });
      }
      return Response.json({ error: "Pi operation is not processing" }, { status: 409 });
    }

    const timestamp = this.now() / 1_000;
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
      messageCostUsd: result.costUsd,
      ...(success ? {} : { error: result.reason ?? "Pi execution did not complete" }),
    });
    const settledAt = this.now();
    this.receipts.record(result.operationId, settledAt);
    this.settleOperation(result.operationId, settledAt);
    return Response.json({ status: "projected" });
  }
}
