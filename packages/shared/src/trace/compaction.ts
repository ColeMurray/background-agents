import type { SessionEvent } from "../types/sessions";

export const MAX_COMPACT_OUTPUT_CHARS = 4_096;
export const MAX_COMPACT_INDEX_CHARS = 1024 * 1024;
export const MAX_COMPACT_INDEX_ENTRIES = 256;

const encoder = new TextEncoder();

export interface CompactionState {
  seenOutputs: Map<string, string>;
  indexedChars: number;
}

export function createCompactionState(): CompactionState {
  return { seenOutputs: new Map(), indexedChars: 0 };
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
    const compacted = { output: "ref", ref };
    if (
      encoder.encode(JSON.stringify({ compacted })).byteLength <
      encoder.encode(JSON.stringify({ output })).byteLength
    ) {
      const { output: _output, ...data } = event.data;
      return { ...event, data: { ...data, compacted } };
    }
    return event;
  }
  if (
    state.seenOutputs.size < MAX_COMPACT_INDEX_ENTRIES &&
    state.indexedChars + output.length <= MAX_COMPACT_INDEX_CHARS
  ) {
    state.seenOutputs.set(output, event.id);
    state.indexedChars += output.length;
  }

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
