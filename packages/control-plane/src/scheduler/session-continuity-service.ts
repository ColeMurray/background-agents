import type { AutomationRow } from "../db/automation-store";
import {
  continueSession,
  findHistoricalPromptReceipt,
  steeringActor,
  type ContinuationPolicy,
  type ContinuationOutcome,
  type SteeringActor,
  type SessionContinuityDeps,
} from "./session-continuity";

/** Bind session continuation and actor authorization to the scheduler's runtime. */
export class SessionContinuityService {
  constructor(private readonly deps: SessionContinuityDeps) {}

  continueSession(
    automation: AutomationRow,
    concurrencyKey: string | null,
    nowMs: number,
    policy: ContinuationPolicy
  ): Promise<ContinuationOutcome> {
    return continueSession(this.deps, automation, concurrencyKey, nowMs, policy);
  }

  findHistoricalPromptReceipt(
    automation: AutomationRow,
    concurrencyKey: string | null,
    requestId: string
  ): Promise<ContinuationOutcome> {
    return findHistoricalPromptReceipt(this.deps, automation, concurrencyKey, requestId);
  }

  resolveActor(
    user: { userId: string; authorId: string },
    traceId: string,
    requestId: string
  ): Promise<SteeringActor | null> {
    return steeringActor(this.deps.db, this.deps.backgroundJobs, user, traceId, requestId);
  }
}
