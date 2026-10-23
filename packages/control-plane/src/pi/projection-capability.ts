import {
  LifecycleCapability,
  type LifecycleJobContext,
  type LifecycleJobOutcome,
} from "agents/lifecycle";
import type { PiRuntimeResult } from "../pi/runtime-contract";
import {
  projectionAdmissionDeadline,
  projectionDeliveryDeadline,
  projectionRetryOutcome,
  PermanentPiResultDeliveryError,
  RetryablePiProjectionError,
  shouldAwaitProjectionAdmission,
} from "./projection-retry-policy";
import { PermanentPiProjectionError } from "./projection-outbox";

const POLL_INTERVAL_MS = 2_000;

interface ProjectionPayload {
  sessionId: string;
  operationId: string;
  admissionDeadline: number;
  deliveryDeadline: number;
}

interface PiProjectionCapabilityOptions {
  isPending(operationId: string): Promise<boolean>;
  probe(operationId: string): Promise<{ status: "done" | "unanswered"; reason?: string }>;
  checkpoint(operationId: string): Promise<void>;
  finalize(operationId: string): Promise<void>;
  drain(operationId: string): Promise<void>;
  result(operationId: string): Promise<PiRuntimeResult>;
  deliver(sessionId: string, result: PiRuntimeResult): Promise<void>;
  rejection(operationId: string): Promise<string | null>;
  recordRejection(operationId: string, error: PermanentPiResultDeliveryError): Promise<void>;
  reject(operationId: string, error: PermanentPiResultDeliveryError): Promise<void>;
  fail(sessionId: string, operationId: string, error: PermanentPiProjectionError): Promise<void>;
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
  return {
    sessionId: value.sessionId,
    operationId: value.operationId,
    admissionDeadline: value.admissionDeadline,
    deliveryDeadline: value.deliveryDeadline,
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
    if (this.lifecycle.jobs.get(payload.operationId)) {
      await this.lifecycle.jobs.rearm();
      return;
    }
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
    const rejection = await this.options.rejection(payload.operationId);
    if (rejection !== null) {
      try {
        await this.options.reject(
          payload.operationId,
          new PermanentPiResultDeliveryError(rejection)
        );
      } catch (error) {
        throw new RetryablePiProjectionError("Pi result rejection cleanup unavailable", {
          cause: error,
        });
      }
      return undefined;
    }
    let pending: boolean;
    try {
      pending = await this.options.isPending(payload.operationId);
    } catch (error) {
      throw new RetryablePiProjectionError("Pi operation status unavailable", { cause: error });
    }
    if (pending) {
      try {
        await this.options.checkpoint(payload.operationId);
        await this.options.drain(payload.operationId);
      } catch (error) {
        if (error instanceof PermanentPiProjectionError) {
          await this.options.fail(payload.sessionId, payload.operationId, error);
          return undefined;
        }
        throw new RetryablePiProjectionError("Pi event projection unavailable", { cause: error });
      }
      return { rescheduleAt: Date.now() + POLL_INTERVAL_MS };
    }
    let probe: { status: "done" | "unanswered"; reason?: string };
    try {
      probe = await this.options.probe(payload.operationId);
    } catch (error) {
      throw new RetryablePiProjectionError("Pi operation result unavailable", { cause: error });
    }
    if (shouldAwaitProjectionAdmission(probe, payload.admissionDeadline)) {
      return { rescheduleAt: Date.now() + POLL_INTERVAL_MS };
    }
    try {
      await this.options.finalize(payload.operationId);
      await this.options.drain(payload.operationId);
    } catch (error) {
      if (error instanceof PermanentPiProjectionError) {
        await this.options.fail(payload.sessionId, payload.operationId, error);
        return undefined;
      }
      throw new RetryablePiProjectionError("Pi final event projection unavailable", {
        cause: error,
      });
    }
    let result: PiRuntimeResult;
    try {
      result = await this.options.result(payload.operationId);
    } catch (error) {
      throw new RetryablePiProjectionError("Pi operation result unavailable", { cause: error });
    }
    try {
      await this.options.deliver(payload.sessionId, result);
    } catch (error) {
      if (error instanceof PermanentPiResultDeliveryError) {
        await this.options.recordRejection(payload.operationId, error);
        try {
          await this.options.reject(payload.operationId, error);
        } catch (cleanupError) {
          throw new RetryablePiProjectionError("Pi result rejection cleanup unavailable", {
            cause: cleanupError,
          });
        }
        return undefined;
      }
      if (error instanceof RetryablePiProjectionError) throw error;
      throw new RetryablePiProjectionError("Pi result delivery unavailable", { cause: error });
    }
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
