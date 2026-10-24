import { sandboxIngressEventSchema } from "@open-inspect/shared/types/sandbox-events";

interface OperationProjectionStore {
  get(operationId: string): {
    state: string;
    lastProjectionSequence: number;
  } | null;
  advanceProjection(
    operationId: string,
    expectedSequence: number,
    nextSequence: number,
    now: number
  ): boolean;
}

export interface HarnessProjectionEnvelope {
  operationId: string;
  displayId: string;
  sequence: number;
}

export class HarnessEventHandler {
  constructor(
    private readonly operations: OperationProjectionStore,
    private readonly processEvent: (
      event: ReturnType<typeof sandboxIngressEventSchema.parse>
    ) => Promise<void>,
    private readonly isHarnessSession: () => boolean,
    private readonly readEnvelope: (request: Request) => HarnessProjectionEnvelope | null,
    private readonly projectionAckId: (displayId: string) => string,
    private readonly now: () => number = Date.now,
    private readonly observeVisible?: (event: {
      operationId: string;
      sequence: number;
      type: string;
      timestampMs: number;
    }) => void
  ) {}

  async handle(request: Request): Promise<Response> {
    const parsed = sandboxIngressEventSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return Response.json({ error: "Invalid harness event" }, { status: 400 });
    if (!this.isHarnessSession()) {
      return Response.json({ error: "Session does not use this harness" }, { status: 409 });
    }
    const envelope = this.readEnvelope(request);
    if (!envelope) return Response.json({ error: "Invalid projection envelope" }, { status: 400 });
    const { operationId, displayId, sequence } = envelope;
    if (!("messageId" in parsed.data) || parsed.data.messageId !== operationId) {
      return Response.json({ error: "Harness event operation mismatch" }, { status: 409 });
    }
    const operation = this.operations.get(operationId);
    if (!operation) return Response.json({ error: "Unknown harness operation" }, { status: 409 });
    // An operation whose dispatch outcome is unknown takes no projections:
    // the turn may never have been admitted, so its events belong to
    // nothing. The window before the session admits the operation is
    // accepted, because the first events can arrive first.
    if (operation.state === "ambiguous") {
      return Response.json({ error: "Harness operation dispatch is ambiguous" }, { status: 409 });
    }
    if (sequence <= operation.lastProjectionSequence) {
      return Response.json({ status: "already_projected" });
    }
    if (sequence !== operation.lastProjectionSequence + 1) {
      return Response.json({ error: "Harness projection sequence gap" }, { status: 409 });
    }

    await this.processEvent({ ...parsed.data, ackId: this.projectionAckId(displayId) });
    this.observeVisible?.({
      operationId,
      sequence,
      type: parsed.data.type,
      timestampMs: this.now(),
    });
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
        return Response.json(
          { error: "Harness projection acknowledgement conflict" },
          { status: 409 }
        );
      }
    }
    return Response.json({ status: "projected" });
  }
}
