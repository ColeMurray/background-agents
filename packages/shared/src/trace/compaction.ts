import type { SessionEvent } from "../types/sessions";

export const MAX_COMPACT_OUTPUT_CHARS = 4_096;

export interface CompactionState {
  seenOutputs: Map<string, string>;
}

export function createCompactionState(): CompactionState {
  return { seenOutputs: new Map() };
}

/**
 * Compact in export read order (newest first). Duplicate outputs in older
 * events refer forward to the latest event (possibly with truncated output).
 */
export function compactEvent(event: SessionEvent, state: CompactionState): SessionEvent {
  if (event.type !== "tool_call" || "compacted" in event.data) return event;

  const { tool, output } = event.data;
  if (typeof output !== "string") return event;

  if (tool === "Read" || tool === "read") {
    const { output: _output, ...data } = event.data;
    return {
      ...event,
      data: { ...data, compacted: { output: "file_read", originalChars: output.length } },
    };
  }

  const ref = state.seenOutputs.get(output);
  if (ref !== undefined) {
    const { output: _output, ...data } = event.data;
    return { ...event, data: { ...data, compacted: { output: "ref", ref } } };
  }
  state.seenOutputs.set(output, event.id);

  if (output.length <= MAX_COMPACT_OUTPUT_CHARS) return event;
  const head = output.slice(0, MAX_COMPACT_OUTPUT_CHARS);
  const lastCodeUnit = head.charCodeAt(head.length - 1);
  const safeHead = lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff ? head.slice(0, -1) : head;
  return {
    ...event,
    data: {
      ...event.data,
      output: safeHead,
      compacted: { output: "truncated", originalChars: output.length },
    },
  };
}
