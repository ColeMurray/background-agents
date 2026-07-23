import type { SandboxEvent } from "@/types/session";

/**
 * The displayable event log built from raw sandbox events.
 *
 * Token events carry the full accumulated text (not incremental deltas), so
 * the log must show exactly one final token per message: collapsed after the
 * fact during replay (`collapseReplayTokenEvents`), and buffered until the
 * execution completes on the live path (`ingestLiveSandboxEvent`).
 */

export type AssistantTokenEvent = Extract<SandboxEvent, { type: "token" }>;

/**
 * The latest streamed assistant text for an in-flight message. Only the most
 * recent token needs to be retained because each one supersedes the last.
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
 * Replay should show one final token per message, independent of tied storage
 * ordering between token and completion.
 */
export function collapseReplayTokenEvents(events: SandboxEvent[]): SandboxEvent[] {
  const tokenByMessageId = new Map<string, AssistantTokenEvent>();

  for (const event of events) {
    if (isRenderableTokenEvent(event)) {
      tokenByMessageId.set(event.messageId, event);
    }
  }

  if (tokenByMessageId.size === 0) {
    return events;
  }

  const result: SandboxEvent[] = [];
  const emittedTokenMessageIds = new Set<string>();

  for (const evt of events) {
    if (isRenderableTokenEvent(evt)) {
      continue;
    }

    if (evt.type === "execution_complete") {
      const token = tokenByMessageId.get(evt.messageId);
      if (token && !emittedTokenMessageIds.has(evt.messageId)) {
        result.push(token);
        emittedTokenMessageIds.add(evt.messageId);
      }
    }

    result.push(evt);
  }

  for (const [messageId, token] of tokenByMessageId) {
    if (!emittedTokenMessageIds.has(messageId)) {
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

  return { pending, append: [event] };
}

export function pendingToTokenEvent(pending: PendingAssistantText): AssistantTokenEvent {
  return { type: "token", ...pending };
}
