import { githubAutofixEnvelopeSchema, type GitHubAutofixEnvelope } from "@open-inspect/shared";
import { githubAutofixFeedbackKey } from "../db/pr-autofix-feedback-store";
import { SourceControlProviderError } from "../source-control/errors";
import type { AutofixProcessResult } from "./service";

interface AutofixProcessor {
  process(body: GitHubAutofixEnvelope): Promise<AutofixProcessResult>;
}

interface FailureStore {
  recordError(feedbackKey: string, error: string): Promise<void>;
  markFailed(feedbackKey: string, reason: string, error: string, decidedAt: number): Promise<void>;
}

interface QueueMessage {
  body: unknown;
  attempts: number;
  ack(): void;
  retry(): void;
}

interface AutofixQueueConsumerDeps {
  service: AutofixProcessor;
  feedbackStore: FailureStore;
  now: () => number;
  maxDeliveryAttempts: number;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class AutofixQueueConsumer {
  constructor(private readonly deps: AutofixQueueConsumerDeps) {}

  async consume(message: QueueMessage): Promise<void> {
    const parsed = githubAutofixEnvelopeSchema.safeParse(message.body);
    if (!parsed.success) {
      message.retry();
      return;
    }

    try {
      await this.deps.service.process(parsed.data);
      message.ack();
    } catch (error) {
      const feedbackKey = githubAutofixFeedbackKey(parsed.data);
      const detail = errorMessage(error);
      if (error instanceof SourceControlProviderError && error.errorType === "permanent") {
        await this.deps.feedbackStore.markFailed(
          feedbackKey,
          "permanent_provider_error",
          detail,
          this.deps.now()
        );
        message.ack();
        return;
      }
      await this.deps.feedbackStore.recordError(feedbackKey, detail);
      if (message.attempts >= this.deps.maxDeliveryAttempts) {
        await this.deps.feedbackStore.markFailed(
          feedbackKey,
          "delivery_attempts_exhausted",
          detail,
          this.deps.now()
        );
      }
      message.retry();
    }
  }
}
