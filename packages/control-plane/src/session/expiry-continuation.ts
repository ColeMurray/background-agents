import { callbackContextSchema } from "@open-inspect/shared/types/session-api";
import type { MessageRow } from "./types";
import { MAX_UNFINISHED_PROMPTS } from "@open-inspect/shared/types/prompts";
import { isSessionPromptable } from "@open-inspect/shared/types/session-activity";
import { parsePersistedSandboxSettings } from "../sandbox/settings";
import {
  DEFAULT_HEARTBEAT_CONFIG,
  DEFAULT_INACTIVITY_CONFIG,
} from "../sandbox/lifecycle/decisions";
import type { EventRepository } from "./event-repository";
import type { MessageRepository } from "./message-repository";
import type { SessionCoreRepository } from "./session-core-repository";
import type { ShutdownRecord } from "./sandbox-shutdown-repository";

/** A session may cross its configured sandbox lifetime unattended once. */
export const MAX_AUTOMATIC_EXPIRY_HANDOFFS = 1;

export const EXPIRY_CONTINUATION_PROMPT =
  "The previous turn was interrupted by the sandbox lifetime limit. Continue the unfinished task " +
  "using this restored conversation and workspace. Check the results of any interrupted command " +
  "before proceeding; do not repeat completed work or restart the original request.";

/** Policy and message persistence; the shutdown owner supplies the save/retirement proof. */
export class ExpiryContinuation {
  constructor(
    private readonly session: SessionCoreRepository,
    private readonly messages: MessageRepository,
    private readonly events: Pick<EventRepository, "hasRecentExecutionProgress">,
    private readonly getExecutionTimeoutMs: () => number
  ) {}

  private enabled(): boolean {
    const session = this.session.getSession();
    try {
      return (
        !!session &&
        isSessionPromptable(session.status) &&
        session.budget_exhausted !== 1 &&
        (session.max_cost_usd === null || session.total_cost < session.max_cost_usd) &&
        parsePersistedSandboxSettings(session.sandbox_settings).autoContinueOnExpiry === true
      );
    } catch {
      return false;
    }
  }

  private canContinueMessage(message: MessageRow): boolean {
    if (!message.callback_context) return true;
    try {
      const callback = callbackContextSchema.safeParse(JSON.parse(message.callback_context));
      // Its failure callback terminates the scheduler run. A synthetic prompt
      // cannot inherit that run's overlap/admission accounting.
      return callback.success && callback.data.source !== "automation";
    } catch {
      return false;
    }
  }

  plan(
    state: ShutdownRecord,
    messageId: string,
    now: number,
    lastHeartbeat: number | null
  ): ShutdownRecord["continuation"] {
    const message = this.messages.getMessageById(messageId);
    if (
      !this.enabled() ||
      (state.automaticHandoffs ?? 0) >= MAX_AUTOMATIC_EXPIRY_HANDOFFS ||
      !state.runtimeReady ||
      !state.generationReady ||
      lastHeartbeat === null ||
      now - lastHeartbeat > DEFAULT_HEARTBEAT_CONFIG.timeoutMs ||
      !message ||
      message.status !== "processing" ||
      !this.canContinueMessage(message) ||
      message.started_at === null ||
      now - message.started_at >= this.getExecutionTimeoutMs() ||
      !this.events.hasRecentExecutionProgress(
        messageId,
        now - DEFAULT_INACTIVITY_CONFIG.timeoutMs,
        now
      )
    )
      return undefined;
    return { sourceMessageId: messageId, messageId: crypto.randomUUID() };
  }

  /** Called inside the shutdown transaction, after a confirmed save and source retirement. */
  enqueue(state: ShutdownRecord, now: number): ShutdownRecord {
    const continuation = state.continuation;
    if (
      !continuation?.conversationId ||
      !this.enabled() ||
      (state.automaticHandoffs ?? 0) >= MAX_AUTOMATIC_EXPIRY_HANDOFFS ||
      this.messages.getPendingOrProcessingCount() >= MAX_UNFINISHED_PROMPTS
    ) {
      return { ...state, continuation: undefined };
    }
    const source = this.messages.getMessageById(continuation.sourceMessageId);
    if (!source || source.status !== "failed" || !this.canContinueMessage(source))
      return { ...state, continuation: undefined };
    this.messages.createMessage({
      id: continuation.messageId,
      authorId: source.author_id,
      content: EXPIRY_CONTINUATION_PROMPT,
      source: source.source,
      model: source.model,
      reasoningEffort: source.reasoning_effort,
      originContext: source.origin_context,
      status: "pending",
      prioritize: true,
      createdAt: now,
    });
    return {
      ...state,
      continuation: { ...continuation, enqueued: true },
      continuationPaused: false,
      automaticHandoffs: (state.automaticHandoffs ?? 0) + 1,
    };
  }
}
