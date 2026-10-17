import {
  LifecycleCapability,
  type LifecycleJobContext,
  type LifecycleJobOutcome,
} from "agents/lifecycle";
import type { PiRuntimeResult } from "./runtime-contract";

const POLL_INTERVAL_MS = 2_000;
const RETRY_INTERVAL_MS = 5_000;

interface ProjectionPayload {
  sessionId: string;
  operationId: string;
}

interface PiProjectionCapabilityOptions {
  isPending(operationId: string): Promise<boolean>;
  result(operationId: string): Promise<PiRuntimeResult>;
  deliver(sessionId: string, result: PiRuntimeResult): Promise<void>;
}

function projectionPayload(value: unknown): ProjectionPayload {
  if (
    typeof value !== "object" ||
    value === null ||
    !("sessionId" in value) ||
    typeof value.sessionId !== "string" ||
    !("operationId" in value) ||
    typeof value.operationId !== "string"
  ) {
    throw new Error("Invalid Pi projection job payload");
  }
  return { sessionId: value.sessionId, operationId: value.operationId };
}

/** Durable result delivery from PiSessionDO to the owning SessionDO. */
export class PiProjectionCapability extends LifecycleCapability {
  constructor(private readonly options: PiProjectionCapabilityOptions) {
    super("pi-projection");
  }

  async schedule(payload: ProjectionPayload): Promise<void> {
    await this.lifecycle.ready();
    await this.lifecycle.jobs.push({
      id: payload.operationId,
      fn: "project",
      time: Date.now() + POLL_INTERVAL_MS,
      payload,
      singleflight: true,
      retry: { maxAttempts: 5, baseDelayMs: 250, maxDelayMs: RETRY_INTERVAL_MS },
    });
  }

  async onJob(context: LifecycleJobContext): Promise<LifecycleJobOutcome> {
    if (context.job.fn !== "project")
      throw new Error(`Unknown Pi projection job ${context.job.fn}`);
    const payload = projectionPayload(context.job.payload);
    if (await this.options.isPending(payload.operationId)) {
      return { rescheduleAt: Date.now() + POLL_INTERVAL_MS };
    }
    const result = await this.options.result(payload.operationId);
    await this.options.deliver(payload.sessionId, result);
    return undefined;
  }

  onJobError(): LifecycleJobOutcome {
    return { rescheduleAt: Date.now() + RETRY_INTERVAL_MS };
  }
}
