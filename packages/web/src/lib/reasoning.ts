import type { ReasoningEvent } from "@open-inspect/shared/types/sandbox-events";
import type { SandboxEvent } from "@/types/session";

/**
 * How long a step may go without a new thought before the thinking row says
 * so. Healthy steps report one every 20–30 s; a provider stall stops them.
 */
export const REASONING_QUIET_AFTER_MS = 3 * 60 * 1000;

/** The identity every cumulative reasoning event of one model step shares. */
export function reasoningKey(event: Pick<ReasoningEvent, "messageId" | "stepId">): string {
  return JSON.stringify([event.messageId, event.stepId]);
}

function splitSummary(text: string): { title: string; detail: string } {
  const lines = text.split("\n");
  const titleIndex = lines.findIndex((line) => line.trim());
  if (titleIndex === -1) return { title: "", detail: "" };
  return {
    title: lines[titleIndex]
      .trim()
      .replace(/^(\*\*|__)(.+)\1$/, "$2")
      .trim(),
    detail: lines
      .slice(titleIndex + 1)
      .join("\n")
      .trim(),
  };
}

/** One display line from a provider summary: its first line, without markdown emphasis. */
export function reasoningTitle(text: string): string {
  return splitSummary(text).title;
}

/** The rest of a provider summary after its title line; empty when it is only a title. */
export function reasoningDetail(text: string): string {
  return splitSummary(text).detail;
}

/**
 * The newest reasoning event once `event` has arrived, while the runtime
 * still reports it active. The runtime clears `active` when the step writes
 * output or finishes, which clients otherwise cannot see while the output is
 * being written. Fold this over events in the order they arrived, before the
 * event log is reordered for display. A stopped turn can report a step after
 * its `execution_complete`, so the step is live only while its own prompt is
 * the one processing.
 */
export function nextLiveReasoning(
  live: ReasoningEvent | null,
  event: SandboxEvent
): ReasoningEvent | null {
  if (event.type === "reasoning") return event.active ? event : null;
  return live;
}
