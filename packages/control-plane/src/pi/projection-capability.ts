import {
  LifecycleCapability,
  type LifecycleJobContext,
  type LifecycleJobOutcome,
} from "agents/lifecycle";
import {
  piRuntimeUsageSchema,
  type PiRuntimeResult,
  type PiRuntimeUsage,
} from "./runtime-contract";
import {
  projectionAdmissionDeadline,
  projectionDeliveryDeadline,
  projectionRetryOutcome,
  RetryablePiProjectionError,
  shouldAwaitProjectionAdmission,
} from "./projection-retry-policy";

const POLL_INTERVAL_MS = 2_000;

interface ProjectionPayload {
  sessionId: string;
  operationId: string;
  admissionDeadline: number;
  deliveryDeadline: number;
  usageBaseline: PiRuntimeUsage;
}

interface PiProjectionCapabilityOptions {
  isPending(operationId: string): Promise<boolean>;
  result(operationId: string, usageBaseline: PiRuntimeUsage): Promise<PiRuntimeResult>;
  deliver(sessionId: string, result: PiRuntimeResult): Promise<void>;
}

function projectionPayload(value: unknown): ProjectionPayload {
  if (
    typeof value !== "object" ||
    value === null ||
    !("sessionId" in value) ||
    typeof value.sessionId !== "string" ||
    !("operationId" in value) ||
    typeof value.operationId !== "string" ||
    !("admissionDeadline" in value) ||
    typeof value.admissionDeadline !== "number" ||
    !("deliveryDeadline" in value) ||
    typeof value.deliveryDeadline !== "number"
  ) {
    throw new Error("Invalid Pi projection job payload");
  }
  const usageBaseline = piRuntimeUsageSchema.safeParse(
    "usageBaseline" in value ? value.usageBaseline : undefined
  );
  if (!usageBaseline.success) throw new Error("Invalid Pi projection usage baseline");
  return {
    sessionId: value.sessionId,
    operationId: value.operationId,
    admissionDeadline: value.admissionDeadline,
    deliveryDeadline: value.deliveryDeadline,
    usageBaseline: usageBaseline.data,
  };
}

/** Durable result delivery from PiSessionDO to the owning SessionDO. */
export class PiProjectionCapability extends LifecycleCapability {
  constructor(private readonly options: PiProjectionCapabilityOptions) {
    super("pi-projection");
  }

  async schedule(
    payload: Omit<ProjectionPayload, "admissionDeadline" | "deliveryDeadline">
  ): Promise<void> {
    await this.lifecycle.ready();
    await this.lifecycle.jobs.push({
      id: payload.operationId,
      fn: "project",
      time: Date.now() + POLL_INTERVAL_MS,
      payload: {
        ...payload,
        admissionDeadline: projectionAdmissionDeadline(),
        deliveryDeadline: projectionDeliveryDeadline(),
      },
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
      result = await this.options.result(payload.operationId, payload.usageBaseline);
    } catch (error) {
      throw new RetryablePiProjectionError("Pi operation result unavailable", { cause: error });
    }
    if (shouldAwaitProjectionAdmission(result, payload.admissionDeadline)) {
      return { rescheduleAt: Date.now() + POLL_INTERVAL_MS };
    }
    await this.options.deliver(payload.sessionId, result);
    return undefined;
  }

  onJobError(_context: LifecycleJobContext, error: unknown): LifecycleJobOutcome {
    let payload: ProjectionPayload;
    try {
      payload = projectionPayload(_context.job.payload);
    } catch {
      return undefined;
    }
    return projectionRetryOutcome(error, payload.deliveryDeadline);
  }
}
