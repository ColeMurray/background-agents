import { sandboxIngressEventSchema } from "@open-inspect/shared/types/sandbox-events";
import type { PiOperationRepository } from "../../pi-operation-repository";

export class PiEventHandler {
  constructor(
    private readonly operations: Pick<PiOperationRepository, "get" | "advanceProjection">,
    private readonly processEvent: (
      event: ReturnType<typeof sandboxIngressEventSchema.parse>
    ) => Promise<void>,
    private readonly isPiSession: () => boolean,
    private readonly now: () => number = Date.now
  ) {}

  async handle(request: Request): Promise<Response> {
    const parsed = sandboxIngressEventSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return Response.json({ error: "Invalid Pi event" }, { status: 400 });
    if (!this.isPiSession()) {
      return Response.json({ error: "Session does not use Pi Durable" }, { status: 409 });
    }
    const operationId = request.headers.get("X-Pi-Operation-ID");
    const displayId = request.headers.get("X-Pi-Projection-ID");
    const sequence = parseSequence(request.headers.get("X-Pi-Projection-Sequence"));
    if (!operationId || !displayId || sequence === null) {
      return Response.json({ error: "Invalid Pi projection envelope" }, { status: 400 });
    }
    if (!("messageId" in parsed.data) || parsed.data.messageId !== operationId) {
      return Response.json({ error: "Pi event operation mismatch" }, { status: 409 });
    }
    const operation = this.operations.get(operationId);
    if (!operation) return Response.json({ error: "Unknown Pi operation" }, { status: 409 });
    if (sequence <= operation.lastProjectionSequence) {
      return Response.json({ status: "already_projected" });
    }
    if (sequence !== operation.lastProjectionSequence + 1) {
      return Response.json({ error: "Pi projection sequence gap" }, { status: 409 });
    }

    await this.processEvent({ ...parsed.data, ackId: `pi-projection:${displayId}` });
    if (
      !this.operations.advanceProjection(
        operationId,
        operation.lastProjectionSequence,
        sequence,
        this.now()
      )
    ) {
      const current = this.operations.get(operationId);
      if (!current || current.lastProjectionSequence < sequence) {
        return Response.json({ error: "Pi projection acknowledgement conflict" }, { status: 409 });
      }
    }
    return Response.json({ status: "projected" });
  }
}

function parseSequence(value: string | null): number | null {
  if (!value || !/^[1-9]\d*$/.test(value)) return null;
  const sequence = Number(value);
  return Number.isSafeInteger(sequence) ? sequence : null;
}
