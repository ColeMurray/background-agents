import type { GitHubAutofixEnvelope } from "@open-inspect/shared";
import { githubAutofixFeedbackKey } from "../db/pr-autofix-feedback-store";
import type { JobDelivery, JobOutcome } from "../jobs";
import { SourceControlProviderError } from "../source-control/errors";
import type { AutofixProcessResult } from "./service";

interface AutofixProcessor {
  process(envelope: GitHubAutofixEnvelope): Promise<AutofixProcessResult>;
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

/**
 * Decides one `github.autofix` delivery: a processed envelope is
 * acknowledged; a permanent provider error is made terminal in the ledger
 * and acknowledged; anything else is recorded and retried, and the last
 * delivery is made terminal first so the ledger explains the dead letter.
 */
export class AutofixJobHandler {
  constructor(
    private readonly service: AutofixProcessor,
    private readonly feedbackStore: FailureStore,
    private readonly now: () => number
  ) {}

  async handle(envelope: GitHubAutofixEnvelope, delivery: JobDelivery): Promise<JobOutcome> {
    try {
      await this.service.process(envelope);
      return "ack";
    } catch (error) {
      const feedbackKey = githubAutofixFeedbackKey(envelope);
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
        if (!failed) return "ack";
      }
      return { retry: true };
    }
  }
}
