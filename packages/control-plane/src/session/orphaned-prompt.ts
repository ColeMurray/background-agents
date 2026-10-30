/**
 * The bridge's `ready` report: the prompt it still owes a result for (the one
 * it runs, else the newest whose terminal event is unacknowledged), or null
 * for none. A runtime that predates the report, or whose harness has not
 * contained what a predecessor still runs, sends none at all.
 */
export interface RuntimeReport {
  owedMessageId: string | null;
}

/**
 * Why a processing prompt no restarted bridge will finish is failed.
 * Sandbox replacement is settled when the instance is reserved, not here.
 */
export type OrphanedPromptReason = "runtime_restarted";

/**
 * Whether a processing prompt went to a bridge process that will never finish it.
 *
 * Dispatch and socket accept both read this control plane's clock, and a
 * dispatch targets only a socket that already exists, so a `started_at`
 * before the current socket was accepted proves the prompt went to a process
 * since replaced. A prompt with no recorded dispatch time, or a socket whose
 * accept time was never recorded, proves nothing.
 *
 * The bridge's report must also not name the prompt. A prompt dispatched on
 * the current socket is never judged by the report: on a reconnect the bridge
 * reports before it reads any command, and on a first connect a prompt it
 * received while booting is in its report. Only a harness that contained its
 * predecessor's execution sends the report. Without one, the prompt stays.
 */
export function orphanedPromptReason(
  prompt: { id: string; started_at: number | null },
  socketAttachedAt: number | null,
  report?: RuntimeReport
): OrphanedPromptReason | null {
  if (!report || report.owedMessageId === prompt.id) return null;
  if (prompt.started_at === null || socketAttachedAt === null) return null;
  if (prompt.started_at < socketAttachedAt) return "runtime_restarted";
  return null;
}
