/**
 * Outcome contract of a single automation firing, shared by the scheduler and
 * the per-source admission pipelines that drive it (e.g. GitHub admission).
 */

import type { AutomationRunRow } from "../db/automation-store";

/** Why a firing was refused without recording an invocation. */
export type AutomationTriggerBlockedReason = "concurrent_run_active" | "team_grants_changed";

export type StartInvocationResult =
  /** Invocation inserted; children launched (some may have pre-failed or been denied). */
  | { outcome: "started"; invocationId: string; runs: AutomationRunRow[]; launched: number }
  /**
   * Overlap — a childless skipped invocation was recorded (schedule/event);
   * null when a concurrent schedule firing already recorded this slot.
   */
  | { outcome: "skipped"; invocationId: string | null }
  /**
   * Overlap on a manual firing, or team grants changed during admission — nothing
   * recorded; manual callers answer 409.
   */
  | { outcome: "blocked"; reason: AutomationTriggerBlockedReason }
  /**
   * Idempotency/dedup collision — another firing owns this slot or event. Carries
   * the owning invocation for event dedup (trigger_key); null for schedule slots.
   */
  | { outcome: "deduplicated"; invocationId: string | null }
  /** The execution principal cannot launch the immutable target snapshot. */
  | { outcome: "unauthorized"; reason?: string };

/** The invocation that represents a firing, if one was recorded or already owned the event. */
export function firingInvocationId(result: StartInvocationResult): string | null {
  return "invocationId" in result ? result.invocationId : null;
}
