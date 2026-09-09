import type { SandboxEvent } from "@open-inspect/shared/types/sandbox-events";
import { generateId } from "../../auth/crypto";
import type { EventRepository } from "../event-repository";

/**
 * Per-event facts the router resolves once and every family handler shares:
 * one clock reading for the whole event, and the message attribution chain
 * (the event's own messageId, falling back to the currently processing
 * message). Handlers must not re-derive these — a second `Date.now()` or
 * repository read mid-event could disagree with what a sibling effect saw.
 */
export interface SandboxEventContext {
  now: number;
  /** `event.messageId ?? processingMessage?.id ?? null`, resolved once. */
  messageId: string | null;
  /** The processing message as of event arrival (single DO turn — stable). */
  processingMessage: { id: string } | null;
}

/**
 * Append the event to the session timeline under the resolved attribution.
 * The one persistence shape every fall-through event shares; families that
 * need a specialized record (tokens, tool calls, compaction) call their
 * repository methods directly instead.
 */
export function persistSandboxEvent(
  eventRepository: EventRepository,
  event: SandboxEvent,
  context: SandboxEventContext
): void {
  eventRepository.createEvent({
    id: generateId(),
    type: event.type,
    data: JSON.stringify(event),
    messageId: context.messageId,
    createdAt: context.now,
  });
}
