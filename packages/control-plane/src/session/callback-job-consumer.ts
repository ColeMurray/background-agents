import { computeHmacHex } from "@open-inspect/shared/auth";
import type { SessionCallbackJob } from "@open-inspect/shared/types/session-callback-jobs";
import { callbackSigningSecret } from "../auth/service/callback-signing";
import type { JobDelivery, JobDeps, JobOutcome } from "../jobs";
import { Scheduler } from "../scheduler/scheduler";
import { sessionMessagePageSchema, SessionInternalPaths } from "./contracts";
import { createSessionRuntimeClient } from "./runtime-client";

const CALLBACK_ATTEMPT_TIMEOUT_MS = 10_000;
const ACTIVITY_MAX_AGE_MS = 60_000;

/** One bounded delivery; the host owns retry scheduling. */
export async function handleSessionCallback(
  job: SessionCallbackJob,
  delivery: JobDelivery,
  deps: JobDeps
): Promise<JobOutcome> {
  if (job.type === "automation.completed") {
    const pending: Promise<unknown>[] = [];
    const scheduler = new Scheduler(deps.db, deps.env, {
      submit: (task) => {
        pending.push(Promise.resolve().then(task));
      },
    });
    try {
      const { context, timestamp: _timestamp, ...completion } = job.payload;
      await scheduler.runComplete({ ...context, ...completion });
      return "ack";
    } finally {
      await Promise.all(pending);
    }
  }
  const cosmetic = job.type.endsWith("tool_call") || job.type === "slack.activity_refresh";
  const failed = (): JobOutcome => (cosmetic ? "ack" : { retry: true });
  const destination = job.type.startsWith("linear.") ? "linear-bot" : "slack-bot";
  const binding = destination === "linear-bot" ? deps.env.LINEAR_BOT : deps.env.SLACK_BOT;
  const secret = callbackSigningSecret(deps.env, destination);
  if (!binding || !secret) {
    deps.log.warn("callback.delivery_unconfigured", { job_type: job.type, destination });
    return failed();
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CALLBACK_ATTEMPT_TIMEOUT_MS);
  try {
    const payload = {
      ...job.payload,
      signature: await computeHmacHex(JSON.stringify(job.payload), secret),
    };
    if (job.type === "slack.activity_refresh") {
      // A queued refresh must not resurrect Working after its turn completes.
      if (Math.abs(Date.now() - job.payload.timestamp) > ACTIVITY_MAX_AGE_MS) return "ack";
      const response = await createSessionRuntimeClient(deps.env, deps.correlation).fetch(
        job.payload.sessionId,
        SessionInternalPaths.messages,
        { signal: controller.signal },
        "?status=processing&limit=1"
      );
      if (!response.ok) return "ack";
      const page = sessionMessagePageSchema.safeParse(await response.json());
      if (
        !page.success ||
        !page.data.messages.some((message) => message.id === job.payload.messageId)
      )
        return "ack";
    }
    const endpoint = job.type.endsWith("completed")
      ? "complete"
      : job.type === "linear.started"
        ? "start"
        : job.type === "slack.activity_refresh"
          ? "activity"
          : "tool_call";
    const response = await binding.fetch(`https://internal/callbacks/${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    await response.body?.cancel();
    deps.log.info("callback.delivery", {
      job_type: job.type,
      destination,
      attempts: delivery.attempts,
      http_status: response.status,
    });
    return response.ok ? "ack" : failed();
  } catch (error) {
    deps.log.warn("callback.delivery_failed", {
      job_type: job.type,
      destination,
      error: error instanceof Error ? error : new Error(String(error)),
    });
    return failed();
  } finally {
    clearTimeout(timeout);
  }
}
