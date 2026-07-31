import type { SessionIndexStore } from "../db/session-index";
import type { Logger } from "../logger";

export class SessionAttentionProjection {
  constructor(
    private readonly sessionIndex: SessionIndexStore | null,
    private readonly getSessionId: () => string | null,
    private readonly log: Logger
  ) {}

  async recordTerminalOutcome(
    messageId: string,
    messageCreatedAt: number,
    acceptedAt: number
  ): Promise<void> {
    const sessionId = this.getSessionId();
    if (!this.sessionIndex || !sessionId) return;

    const input = { sessionId, messageId, messageCreatedAt, acceptedAt };
    try {
      await this.sessionIndex.recordLatestAttention(input);
      return;
    } catch (firstError) {
      this.log.warn("session_attention.projection_retry", {
        session_id: sessionId,
        message_id: messageId,
        error: firstError,
      });
    }

    try {
      await this.sessionIndex.recordLatestAttention(input);
    } catch (error) {
      this.log.error("session_attention.projection_failed", {
        session_id: sessionId,
        message_id: messageId,
        error,
      });
    }
  }
}
