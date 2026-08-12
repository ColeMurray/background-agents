import type { SandboxEvent } from "@/types/session";

/**
 * The displayable event log built from raw sandbox events.
 *
 * Token events carry the full accumulated text for one assistant segment (not
 * incremental deltas), so the log keeps one final token per segment. Context
 * compaction ends the current segment before another starts for the same
 * message.
 */

export type AssistantTokenEvent = Extract<SandboxEvent, { type: "token" }>;

/**
 * The latest streamed assistant text for an in-flight segment. Only the most
 * recent token within that segment needs to be retained because it supersedes
 * the last.
 */
export type PendingAssistantText = Pick<
  AssistantTokenEvent,
  "content" | "messageId" | "sandboxId" | "timestamp"
>;

export function toUiSandboxEvent(event: SandboxEvent): SandboxEvent {
  return {
    ...event,
    timestamp: typeof event.timestamp === "number" ? event.timestamp : Date.now() / 1000,
  };
}

function isRenderableTokenEvent(event: SandboxEvent): event is AssistantTokenEvent {
  return event.type === "token" && Boolean(event.content) && Boolean(event.messageId);
}

/**
 * Replay should show one final token per compaction-delimited segment,
 * independent of tied storage ordering between token and completion.
 */
export function collapseReplayTokenEvents(events: SandboxEvent[]): SandboxEvent[] {
  const tokenBySegment = new Map<string, AssistantTokenEvent>();
  const segmentByMessageId = new Map<string, number>();
  const segmentKey = (messageId: string) =>
    JSON.stringify([messageId, segmentByMessageId.get(messageId) ?? 0]);

  for (const event of events) {
    if (isRenderableTokenEvent(event)) {
      tokenBySegment.set(segmentKey(event.messageId), event);
    } else if (event.type === "context_compacted") {
      segmentByMessageId.set(event.messageId, (segmentByMessageId.get(event.messageId) ?? 0) + 1);
    }
  }

  if (tokenBySegment.size === 0) {
    return events;
  }

  const result: SandboxEvent[] = [];
  const emittedSegments = new Set<string>();
  segmentByMessageId.clear();

  const emitSegmentToken = (messageId: string) => {
    const key = segmentKey(messageId);
    const token = tokenBySegment.get(key);
    if (token && !emittedSegments.has(key)) {
      result.push(token);
      emittedSegments.add(key);
    }
  };

  for (const evt of events) {
    if (isRenderableTokenEvent(evt)) {
      continue;
    }

    if (evt.type === "context_compacted") {
      emitSegmentToken(evt.messageId);
      result.push(evt);
      segmentByMessageId.set(evt.messageId, (segmentByMessageId.get(evt.messageId) ?? 0) + 1);
      continue;
    }

    if (evt.type === "execution_complete") {
      emitSegmentToken(evt.messageId);
    }

    result.push(evt);
  }

  for (const [key, token] of tokenBySegment) {
    if (!emittedSegments.has(key)) {
      result.push(token);
    }
  }

  return result;
}

export interface LiveEventIngestion {
  /** The pending assistant text after processing this event. */
  pending: PendingAssistantText | null;
  /** Events ready to append to the visible event log. */
  append: SandboxEvent[];
}

/**
 * Step function for live sandbox events. Streamed token text is buffered
 * (not displayed) until its execution completes, at which point the final
 * text is emitted once with the token's original timestamp. All other
 * events pass through unchanged.
 */
export function ingestLiveSandboxEvent(
  pending: PendingAssistantText | null,
  event: SandboxEvent
): LiveEventIngestion {
  if (event.type === "token" && event.content && event.messageId) {
    return {
      pending: {
        content: event.content,
        messageId: event.messageId,
        sandboxId: event.sandboxId,
        timestamp: event.timestamp,
      },
      append: [],
    };
  }

  if (event.type === "execution_complete") {
    return {
      pending: null,
      append: pending ? [pendingToTokenEvent(pending), event] : [event],
    };
  }

  if (event.type === "context_compacted" && pending?.messageId === event.messageId) {
    return {
      pending: null,
      append: [pendingToTokenEvent(pending), event],
    };
  }

  return { pending, append: [event] };
}

export function pendingToTokenEvent(pending: PendingAssistantText): AssistantTokenEvent {
  return { type: "token", ...pending };
}
