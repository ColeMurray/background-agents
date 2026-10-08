import type { SandboxEvent } from "@open-inspect/shared/types/sandbox-events";
import type { EventRepository } from "./event-repository";
import type { SessionMessenger } from "./messenger";

export type SessionWarningEvent = Extract<SandboxEvent, { type: "warning" }>;

/**
 * Persist a warning in the existing timeline format, so disconnected clients
 * see it too. Synchronous, so it can commit with the state it reports.
 * Returns the event to broadcast, or null when it was already recorded.
 */
export function persistSessionWarning(
  events: Pick<EventRepository, "createEventIfAbsent">,
  message: string,
  eventId: string,
  now: number
): SessionWarningEvent | null {
  const event: SessionWarningEvent = {
    type: "warning",
    scope: "provider",
    message,
    timestamp: now / 1000,
  };
  const created = events.createEventIfAbsent({
    id: eventId,
    type: "warning",
    data: JSON.stringify(event),
    messageId: null,
    createdAt: now,
  });
  return created ? event : null;
}

/** Persist in the existing timeline format so disconnected clients see the warning too. */
export function recordSessionWarning(
  events: EventRepository,
  messenger: Pick<SessionMessenger, "broadcast">,
  message: string,
  eventId: string
): void {
  const event = persistSessionWarning(events, message, eventId, Date.now());
  if (event) messenger.broadcast({ type: "sandbox_event", event });
}
