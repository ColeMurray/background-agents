import type { SandboxRow } from "./types";

/**
 * Why a processing prompt no runtime will finish is failed; each is a key of
 * the interruption messages its author is shown.
 */
export type OrphanedPromptReason = "sandbox_replaced" | "runtime_restarted";

/**
 * The bridge's `ready` report: the prompt it still owes a result for (the one
 * it runs, else the newest whose terminal event is unacknowledged), or null
 * for none. A runtime that predates the report sends none at all.
 */
export interface RuntimeReport {
  owedMessageId: string | null;
}

/** The runtime boundaries a dispatch is ordered against, by this control plane's clock. */
export interface RuntimeBoundaries {
  /** `sandbox.instance_reserved_at`: advanced by a spawn or a snapshot restore, kept by an in-place resume. */
  instanceReservedAt: number | null;
  /** `sandbox.active_socket_attached_at`: null while no socket holds dispatch authority. */
  socketAttachedAt: number | null;
}

export function runtimeBoundaries(
  sandbox: Pick<SandboxRow, "instance_reserved_at" | "active_socket_attached_at"> | null
): RuntimeBoundaries {
  return {
    instanceReservedAt: sandbox?.instance_reserved_at ?? null,
    socketAttachedAt: sandbox?.active_socket_attached_at ?? null,
  };
}

/**
 * Whether a processing prompt went to a runtime that will never finish it.
 *
 * Dispatch, reservation and socket accept all read this control plane's
 * clock, and a dispatch targets only an instance and socket that already
 * exist, so a `started_at` before a boundary proves the prompt went to a
 * runtime since replaced. A prompt with no recorded dispatch time, or a
 * boundary that was never recorded, proves nothing.
 *
 * - `sandbox_replaced`: dispatched before the current sandbox instance was
 *   reserved. The generation's `created_at` is not the boundary: an in-place
 *   resume advances it while the same bridge still runs the prompt.
 * - `runtime_restarted`: the bridge's report does not name the prompt, and it
 *   was dispatched before the current socket was accepted, so the process that
 *   received it is gone. A prompt dispatched on the current socket is never
 *   judged by the report: on a reconnect the bridge reports before it reads
 *   any command on the new socket, and on a first connect a prompt it received
 *   while booting is in its report. A restarted bridge reports no owner only
 *   after it has stopped whatever its vendor session still ran for its
 *   predecessor, so the next prompt does not share an execution with this one.
 *   Without a report only the instance rule applies.
 */
export function orphanedPromptReason(
  prompt: { id: string; started_at: number | null },
  boundaries: RuntimeBoundaries,
  report?: RuntimeReport
): OrphanedPromptReason | null {
  if (dispatchedBefore(prompt, boundaries.instanceReservedAt)) return "sandbox_replaced";
  if (
    report &&
    report.owedMessageId !== prompt.id &&
    dispatchedBefore(prompt, boundaries.socketAttachedAt)
  ) {
    return "runtime_restarted";
  }
  return null;
}

function dispatchedBefore(prompt: { started_at: number | null }, boundaryMs: number | null) {
  return prompt.started_at !== null && boundaryMs !== null && prompt.started_at < boundaryMs;
}
