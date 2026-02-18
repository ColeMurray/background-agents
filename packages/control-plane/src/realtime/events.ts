/**
 * Real-time event utilities.
 */

import type { SandboxEvent, ServerMessage } from "../types";

/**
 * Event categories for filtering.
 */
export type EventCategory =
  | "execution" // token, tool_call, tool_result, execution_complete
  | "git" // git_sync
  | "system" // heartbeat, error
  | "artifact"; // artifact

/**
 * Get category for an event type.
 */
export function getEventCategory(eventType: string): EventCategory {
  switch (eventType) {
    case "token":
    case "step_start":
    case "step_finish":
    case "tool_call":
    case "tool_result":
    case "execution_complete":
      return "execution";
    case "git_sync":
      return "git";
    case "artifact":
      return "artifact";
    default:
      return "system";
  }
}

/**
 * Create a server message from sandbox event.
 */
export function createSandboxEventMessage(event: SandboxEvent): ServerMessage {
  return {
    type: "sandbox_event",
    event,
  };
}

/**
 * Create error message.
 */
export function createErrorMessage(code: string, message: string): ServerMessage {
  return {
    type: "error",
    code,
    message,
  };
}

/**
 * Determine if event should be persisted to database.
 */
export function shouldPersistEvent(eventType: string): boolean {
  // Don't persist heartbeats - too frequent
  if (eventType === "heartbeat") {
    return false;
  }
  return true;
}

/**
 * Determine if event should be broadcast to clients.
 */
export function shouldBroadcastEvent(_eventType: string): boolean {
  // Always broadcast to clients
  return true;
}

/**
 * Aggregate token events for efficiency.
 *
 * Combines multiple token events into batches to reduce
 * WebSocket message overhead.
 */
export class TokenAggregator {
  private buffer: string[] = [];
  private messageId: string | null = null;
  private flushTimeout: ReturnType<typeof setTimeout> | null = null;
  private flushCallback: ((tokens: string, messageId: string) => void) | null = null;

  constructor(
    private flushIntervalMs: number = 50,
    private maxBufferSize: number = 100
  ) {}

  /**
   * Set callback for when tokens are flushed.
   */
  onFlush(callback: (tokens: string, messageId: string) => void): void {
    this.flushCallback = callback;
  }

  /**
   * Add token to buffer.
   */
  add(token: string, messageId: string): void {
    if (this.messageId !== messageId) {
      this.flush();
      this.messageId = messageId;
    }

    this.buffer.push(token);

    if (this.buffer.length >= this.maxBufferSize) {
      this.flush();
    } else if (!this.flushTimeout) {
      this.flushTimeout = setTimeout(() => this.flush(), this.flushIntervalMs);
    }
  }

  /**
   * Flush buffered tokens.
   */
  flush(): void {
    if (this.flushTimeout) {
      clearTimeout(this.flushTimeout);
      this.flushTimeout = null;
    }

    if (this.buffer.length > 0 && this.messageId && this.flushCallback) {
      const tokens = this.buffer.join("");
      this.flushCallback(tokens, this.messageId);
    }

    this.buffer = [];
  }

  /**
   * Clean up resources.
   */
  destroy(): void {
    this.flush();
    this.flushCallback = null;
  }
}
