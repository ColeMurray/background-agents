import { githubAutofixEnvelopeSchema, type GitHubAutofixEnvelope } from "@open-inspect/shared";
import { githubAutofixFeedbackKey } from "../db/pr-autofix-feedback-store";
import type { JobConsumer, JobDelivery, JobOutcome } from "../jobs";
import { SourceControlProviderError } from "../source-control/errors";
import type { AutofixProcessResult } from "./service";

interface AutofixProcessor {
  process(body: GitHubAutofixEnvelope): Promise<AutofixProcessResult>;
}

interface FailureStore {
  recordError(feedbackKey: string, error: string): Promise<void>;
  markFailed(
    feedbackKey: string,
    reason: string,
    error: string,
    decidedAt: number
  ): Promise<boolean>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class AutofixQueueConsumer implements JobConsumer {
  constructor(
    private readonly service: AutofixProcessor,
    private readonly feedbackStore: FailureStore,
    private readonly now: () => number
  ) {}

  async run(body: unknown, delivery: JobDelivery): Promise<JobOutcome> {
    const parsed = githubAutofixEnvelopeSchema.safeParse(body);
    if (!parsed.success) return "retry";

    try {
      await this.service.process(parsed.data);
      return "ack";
    } catch (error) {
      const feedbackKey = githubAutofixFeedbackKey(parsed.data);
      const detail = errorMessage(error);
      if (error instanceof SourceControlProviderError && error.errorType === "permanent") {
        await this.feedbackStore.markFailed(
          feedbackKey,
          "permanent_provider_error",
          detail,
          this.now()
        );
        return "ack";
      }
      await this.feedbackStore.recordError(feedbackKey, detail);
      if (delivery.attempts >= delivery.maxAttempts) {
        const failed = await this.feedbackStore.markFailed(
          feedbackKey,
          "delivery_attempts_exhausted",
          detail,
          this.now()
        );
        // A key another delivery already failed is not this one's to end:
        // acknowledge and leave the recorded verdict alone.
        if (!failed) return "ack";
      }
      return "retry";
    }
  }
}
