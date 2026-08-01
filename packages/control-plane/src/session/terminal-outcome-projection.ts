import type { SessionIndexStore } from "../db/session-index";
import type { Logger } from "../logger";

export interface TerminalOutcomeProjectionInput {
  messageId: string;
  messageCreatedAt: number;
  terminalOutcomeCompletedAt: number;
}

export class SessionTerminalOutcomeProjection {
  constructor(
    private readonly sessionIndex: SessionIndexStore | null,
    private readonly getSessionId: () => string | null,
    private readonly log: Logger
  ) {}

  async recordTerminalOutcome(input: TerminalOutcomeProjectionInput): Promise<void> {
    const sessionId = this.getSessionId();
    if (!this.sessionIndex || !sessionId) return;

    const storeInput = { sessionId, ...input };
    try {
      await this.sessionIndex.recordLatestTerminalOutcome(storeInput);
      return;
    } catch (firstError) {
      this.log.warn("session_terminal_outcome.projection_retry", {
        session_id: sessionId,
        message_id: input.messageId,
        error: firstError,
      });
    }

    try {
      await this.sessionIndex.recordLatestTerminalOutcome(storeInput);
    } catch (error) {
      this.log.error("session_terminal_outcome.projection_failed", {
        session_id: sessionId,
        message_id: input.messageId,
        error,
      });
    }
  }
}
