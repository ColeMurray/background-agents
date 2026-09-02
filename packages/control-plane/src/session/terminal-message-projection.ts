import type { SessionIndexStore } from "../db/session-index";
import type { Logger } from "../logger";
import type { AlarmScheduler } from "../platform-ports";
import type { TerminalMessageProjectionStore } from "./terminal-message-projection-store";

export interface TerminalMessageProjectionInput {
  messageId: string;
  messageCreatedAt: number;
  terminalMessageCompletedAt: number;
}

export interface SessionTerminalMessageProjectionDeps {
  sessionIndex: SessionIndexStore | null;
  getSessionId: () => string | null;
  store: TerminalMessageProjectionStore;
  alarmScheduler: AlarmScheduler;
  now: () => number;
  log: Logger;
}

const DEFERRED_RETRY_BASE_MS = 5_000;
const DEFERRED_RETRY_MAX_MS = 5 * 60_000;
const DEFERRED_RETRY_MAX_ATTEMPTS = 8;

function deferredRetryDelayMs(attempts: number): number {
  return Math.min(DEFERRED_RETRY_BASE_MS * 2 ** attempts, DEFERRED_RETRY_MAX_MS);
}

/**
 * Projects each completed turn's terminal message onto the D1 session row
 * that the inbox and read state are computed from. A projection that fails
 * inline is persisted and retried from the Durable Object alarm with
 * backoff, so a D1 outage delays unread state instead of losing it.
 */
export class SessionTerminalMessageProjection {
  constructor(private readonly deps: SessionTerminalMessageProjectionDeps) {}

  async recordTerminalMessage(input: TerminalMessageProjectionInput): Promise<void> {
    const sessionId = this.deps.getSessionId();
    if (!this.deps.sessionIndex || !sessionId) return;

    const storeInput = { sessionId, ...input };
    try {
      await this.deps.sessionIndex.recordLatestTerminalMessage(storeInput);
      this.deps.store.clearThrough(input);
      return;
    } catch (firstError) {
      this.deps.log.warn("session_terminal_message.projection_retry", {
        session_id: sessionId,
        message_id: input.messageId,
        error: firstError,
      });
    }

    try {
      await this.deps.sessionIndex.recordLatestTerminalMessage(storeInput);
      this.deps.store.clearThrough(input);
    } catch (error) {
      const nextAttemptAt = this.deps.now() + deferredRetryDelayMs(0);
      this.deps.store.setPending({ ...input, attempts: 0, nextAttemptAt });
      await this.deps.alarmScheduler.schedule(nextAttemptAt);
      this.deps.log.warn("session_terminal_message.projection_deferred", {
        session_id: sessionId,
        message_id: input.messageId,
        next_attempt_at: nextAttemptAt,
        error,
      });
    }
  }

  /** Alarm entry point: retry a deferred projection once it is due. */
  async flushPending(): Promise<void> {
    const pending = this.deps.store.pending();
    if (!pending) return;
    const now = this.deps.now();
    if (pending.nextAttemptAt > now) {
      // The alarm slot is shared; whoever fired it may have consumed this deadline.
      await this.deps.alarmScheduler.schedule(pending.nextAttemptAt);
      return;
    }
    const sessionId = this.deps.getSessionId();
    if (!this.deps.sessionIndex || !sessionId) return;

    const { messageId, messageCreatedAt, terminalMessageCompletedAt } = pending;
    try {
      await this.deps.sessionIndex.recordLatestTerminalMessage({
        sessionId,
        messageId,
        messageCreatedAt,
        terminalMessageCompletedAt,
      });
    } catch (error) {
      const attempts = pending.attempts + 1;
      if (attempts >= DEFERRED_RETRY_MAX_ATTEMPTS) {
        this.deps.store.clearThrough(pending);
        this.deps.log.error("session_terminal_message.projection_abandoned", {
          session_id: sessionId,
          message_id: messageId,
          attempts,
          error,
        });
        return;
      }
      const nextAttemptAt = now + deferredRetryDelayMs(attempts);
      this.deps.store.recordFailedAttempt({ attempts, nextAttemptAt });
      await this.deps.alarmScheduler.schedule(nextAttemptAt);
      this.deps.log.warn("session_terminal_message.projection_retry_scheduled", {
        session_id: sessionId,
        message_id: messageId,
        attempts,
        next_attempt_at: nextAttemptAt,
        error,
      });
      return;
    }
    this.deps.store.clearThrough(pending);
    this.deps.log.info("session_terminal_message.projection_recovered", {
      session_id: sessionId,
      message_id: messageId,
      attempts: pending.attempts,
    });
  }

  /** Re-arm the retry deadline after the runtime restarts. */
  async rearm(): Promise<void> {
    const pending = this.deps.store.pending();
    if (pending) await this.deps.alarmScheduler.schedule(pending.nextAttemptAt);
  }
}
