import {
  LifecycleCapability,
  type LifecycleJobContext,
  type LifecycleJobOutcome,
} from "agents/lifecycle";
import type { RepositoryDiffPublicationOutcome } from "./repository-diff-outbox";

const JOB_ID = "repository-diff-publication";
const RETRY_INTERVAL_MS = 60_000;

/** One durable, coalesced retry job for the latest repository diff projection. */
export class RepositoryDiffPublicationCapability extends LifecycleCapability {
  constructor(
    private readonly attempt: () => Promise<RepositoryDiffPublicationOutcome>,
    private readonly now: () => number = Date.now
  ) {
    super("repository-diff-publication");
  }

  async schedule(): Promise<void> {
    await this.lifecycle.ready();
    if (this.lifecycle.jobs.get(JOB_ID)) {
      await this.lifecycle.jobs.rearm();
      return;
    }
    await this.lifecycle.jobs.push({
      id: JOB_ID,
      fn: "publish",
      time: this.now(),
      payload: {},
      singleflight: true,
      retry: { maxAttempts: 5, baseDelayMs: 250, maxDelayMs: 5_000 },
    });
  }

  async onJob(context: LifecycleJobContext): Promise<LifecycleJobOutcome> {
    if (context.job.fn !== "publish") {
      throw new Error(`Unknown repository diff publication job ${context.job.fn}`);
    }
    const outcome = await this.attempt();
    return outcome === "pending" ? { rescheduleAt: this.now() + RETRY_INTERVAL_MS } : undefined;
  }

  onJobError(): LifecycleJobOutcome {
    return { rescheduleAt: this.now() + RETRY_INTERVAL_MS };
  }
}
