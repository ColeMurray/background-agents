import { sandboxIngressEventSchema } from "@open-inspect/shared/types/sandbox-events";
import type { MessageRepository } from "../../message-repository";

export class PiEventHandler {
  constructor(
    private readonly messages: Pick<MessageRepository, "getProcessingMessage">,
    private readonly processEvent: (
      event: ReturnType<typeof sandboxIngressEventSchema.parse>
    ) => Promise<void>,
    private readonly isPiSession: () => boolean
  ) {}

  async handle(request: Request): Promise<Response> {
    const parsed = sandboxIngressEventSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return Response.json({ error: "Invalid Pi event" }, { status: 400 });
    if (!this.isPiSession()) {
      return Response.json({ error: "Session does not use Pi Durable" }, { status: 409 });
    }
    const operationId = request.headers.get("X-Pi-Operation-ID");
    if (!operationId || this.messages.getProcessingMessage()?.id !== operationId) {
      return Response.json({ error: "Pi operation is not processing" }, { status: 409 });
    }
    if (!("messageId" in parsed.data) || parsed.data.messageId !== operationId) {
      return Response.json({ error: "Pi event operation mismatch" }, { status: 409 });
    }
    await this.processEvent(parsed.data);
    return Response.json({ status: "projected" });
  }
}
