import type { SessionIndexStore } from "../db/session-index";
import type { Logger } from "../logger";

export interface TerminalMessageProjectionInput {
  messageId: string;
  messageCreatedAt: number;
  terminalMessageCompletedAt: number;
}

export class SessionTerminalMessageProjection {
  constructor(
    private readonly sessionIndex: SessionIndexStore | null,
    private readonly getSessionId: () => string | null,
    private readonly log: Logger
  ) {}

  async recordTerminalMessage(input: TerminalMessageProjectionInput): Promise<void> {
    const sessionId = this.getSessionId();
    if (!this.sessionIndex || !sessionId) return;

    const storeInput = { sessionId, ...input };
    try {
      await this.sessionIndex.recordLatestTerminalMessage(storeInput);
      return;
    } catch (firstError) {
      this.log.warn("session_terminal_message.projection_retry", {
        session_id: sessionId,
        message_id: input.messageId,
        error: firstError,
      });
    }

    try {
      await this.sessionIndex.recordLatestTerminalMessage(storeInput);
    } catch (error) {
      this.log.error("session_terminal_message.projection_failed", {
        session_id: sessionId,
        message_id: input.messageId,
        error,
      });
    }
  }
}
