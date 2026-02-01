/**
 * EventProcessor implementation.
 */

import type { EventProcessor, EventProcessorCallbacks, BroadcastCallback } from "./types";
import type { EventRepository } from "../repository/types";

interface EventProcessorDependencies {
  eventRepo: EventRepository;
  broadcast: BroadcastCallback;
  callbacks: EventProcessorCallbacks;
}

/**
 * Create an EventProcessor instance.
 */
export function createEventProcessor(deps: EventProcessorDependencies): EventProcessor {
  const { eventRepo, broadcast, callbacks } = deps;

  return {
    async processEvent(event: {
      type: string;
      data?: unknown;
      message_id?: string;
    }): Promise<void> {
      try {
        // Generate event ID and timestamp
        const eventId = crypto.randomUUID();
        const now = Date.now();

        // Store event in database
        const storedEvent = eventRepo.create({
          id: eventId,
          type: event.type,
          data: event.data ? JSON.stringify(event.data) : null,
          messageId: event.message_id,
          createdAt: now,
        });

        // Broadcast event to clients
        try {
          broadcast({
            type: "event",
            event: {
              id: storedEvent.id,
              type: storedEvent.type,
              data: storedEvent.data ? JSON.parse(storedEvent.data) : null,
              messageId: storedEvent.message_id,
              createdAt: storedEvent.created_at,
            },
          });
        } catch (broadcastError) {
          console.error("Failed to broadcast event:", broadcastError);
        }

        // Handle special event types
        await handleSpecialEvent(event, callbacks);
      } catch (error) {
        console.error("Failed to process event:", error);
      }
    },
  };
}

/**
 * Handle special event types that require callbacks.
 */
async function handleSpecialEvent(
  event: { type: string; data?: unknown; message_id?: string },
  callbacks: EventProcessorCallbacks
): Promise<void> {
  try {
    switch (event.type) {
      case "execution_complete": {
        const data = event.data as { message_id?: string; success?: boolean } | undefined;
        if (data?.message_id) {
          await callbacks.onExecutionComplete(data.message_id, data.success ?? false);
          await callbacks.onProcessNextMessage();
        }
        break;
      }

      case "git_sync":
        await callbacks.triggerSnapshot("git_sync");
        break;

      case "heartbeat":
        await callbacks.triggerSnapshot("heartbeat");
        break;

      case "push_complete":
        await callbacks.triggerSnapshot("push_complete");
        break;

      case "push_error":
        await callbacks.triggerSnapshot("push_error");
        break;
    }
  } catch (error) {
    console.error(`Failed to handle special event ${event.type}:`, error);
  }
}
