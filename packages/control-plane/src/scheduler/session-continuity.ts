/** Public contracts for source-specific session continuation. */
import type { AutomationRow, AutomationRunRow } from "../db/automation-store";
import type { CorrelationContext } from "../logger";
import type { RequestContext } from "../routes/shared";
import type { SchedulerPromptRequest } from "./session-prompt";

export interface SteeringActor {
  userId: string;
  authorId: string;
  context: RequestContext;
}

export interface ContinuationPolicy {
  source: "slack" | "webhook";
  logFields?: Record<string, unknown>;
  acceptDelivery?(run: AutomationRunRow): Promise<void>;
  releaseDelivery?(): Promise<void>;
  resolveActor(): Promise<SteeringActor | null>;
  buildPrompt(
    run: AutomationRunRow,
    actor: SteeringActor,
    automation: AutomationRow
  ): Promise<{ body: SchedulerPromptRequest; ctx: CorrelationContext }>;
}

export type ContinuationOutcome =
  | { kind: "steered"; invocationId: string }
  | { kind: "skipped"; invocationId: string | null }
  /** The session did not take the follow-up; `status` is null when it could not be reached. */
  | { kind: "refused"; invocationId: string; status: number | null; code: string | null }
  | { kind: "fall_through" };
