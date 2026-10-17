import {
  LifecycleCapability,
  type LifecycleJobContext,
  type LifecycleJobOutcome,
} from "agents/lifecycle";
import type { PiRuntimeResult } from "./runtime-contract";
import { projectionRetryOutcome, RetryablePiProjectionError } from "./projection-retry-policy";

const POLL_INTERVAL_MS = 2_000;

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
      retry: { maxAttempts: 5, baseDelayMs: 250, maxDelayMs: 5_000 },
    });
  }

  async onJob(context: LifecycleJobContext): Promise<LifecycleJobOutcome> {
    if (context.job.fn !== "project")
      throw new Error(`Unknown Pi projection job ${context.job.fn}`);
    const payload = projectionPayload(context.job.payload);
    let pending: boolean;
    try {
      pending = await this.options.isPending(payload.operationId);
    } catch (error) {
      throw new RetryablePiProjectionError("Pi operation status unavailable", { cause: error });
    }
    if (pending) return { rescheduleAt: Date.now() + POLL_INTERVAL_MS };
    let result: PiRuntimeResult;
    try {
      result = await this.options.result(payload.operationId);
    } catch (error) {
      throw new RetryablePiProjectionError("Pi operation result unavailable", { cause: error });
    }
    await this.options.deliver(payload.sessionId, result);
    return undefined;
  }

  onJobError(_context: LifecycleJobContext, error: unknown): LifecycleJobOutcome {
    return projectionRetryOutcome(error);
  }
}
