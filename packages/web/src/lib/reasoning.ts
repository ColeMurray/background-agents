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

/** One display line from a provider summary: its first line, without markdown emphasis. */
export function reasoningTitle(text: string): string {
  const firstLine = text.split("\n").find((line) => line.trim()) ?? "";
  return firstLine
    .trim()
    .replace(/^(\*\*|__)(.+)\1$/, "$2")
    .trim();
}

/** Events after which the model has left the reasoning it last reported. */
const REASONING_ENDING_EVENT_TYPES: ReadonlySet<SandboxEvent["type"]> = new Set([
  "token",
  "tool_call",
  "step_finish",
  "user_message",
  "execution_complete",
  "error",
]);

/**
 * The reasoning the model is in the middle of: the newest reasoning event when
 * nothing that ends it has arrived since. While a step reasons the runtime
 * sends nothing else, so this is what the thinking row narrates.
 */
export function selectLiveReasoning(
  events: SandboxEvent[],
  isProcessing: boolean
): ReasoningEvent | null {
  if (!isProcessing) return null;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.type === "reasoning") return event;
    if (REASONING_ENDING_EVENT_TYPES.has(event.type)) return null;
  }
  return null;
}
