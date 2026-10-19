import { slackEventPayloadSchema } from "./events/payload";
import { handleSlackEvent } from "./events/dispatcher";
import { setAssistantThreadStatusBestEffort } from "./activity-status";
import { createLogger } from "./logger";
import type { Env } from "./types";
import {
  claimSlackIngress,
  getSlackIngress,
  slackIngressJobSchema,
  transitionSlackIngress,
  type SlackIngressJob,
} from "./ingress-authority";

const log = createLogger("ingress-consumer");
export async function processSlackIngressJob(
  env: Env,
  job: SlackIngressJob,
  leaseOwner = crypto.randomUUID(),
  terminalFailure = false
): Promise<"processed" | "duplicate"> {
  const claimStarted = Date.now();
  const receipt = await claimSlackIngress(env, job.receiptId, leaseOwner);
  if (!receipt) return "duplicate";
  log.info("slack.ingress", {
    event: "slack.ingress",
    milestone: "claim",
    source: "slack",
    event_id: job.eventId,
    receipt_id: job.receiptId,
    timestamp_ms: Date.now(),
    duration_ms: Date.now() - claimStarted,
  });
  try {
    const current = receipt.payload_json ? receipt : await getSlackIngress(env, job.receiptId);
    if (!current.payload_json) throw new Error("Slack ingress payload is unavailable");
    const payload = slackEventPayloadSchema.parse(JSON.parse(current.payload_json));
    const event = payload.type === "event_callback" ? payload.event : undefined;
    const background: Promise<void>[] = [];
    if (event?.channel) {
      const threadTs = event.thread_ts ?? event.ts;
      if (threadTs) {
        const started = Date.now();
        background.push(
          setAssistantThreadStatusBestEffort(env, event.channel, threadTs, "Starting...", {
            event: "start",
            traceId: job.eventId,
          }).then(() =>
            log.info("slack.ingress", {
              event: "slack.ingress",
              milestone: "activity",
              source: "slack",
              event_id: job.eventId,
              receipt_id: job.receiptId,
              timestamp_ms: Date.now(),
              duration_ms: Date.now() - started,
            })
          )
        );
      }
    }
    await handleSlackEvent(payload, env, job.eventId, (promise) => background.push(promise));
    await Promise.allSettled(background);
    await transitionSlackIngress(env, job.receiptId, leaseOwner, "processing", "completed");
    return "processed";
  } catch (error) {
    await transitionSlackIngress(
      env,
      job.receiptId,
      leaseOwner,
      "processing",
      terminalFailure ? "failed" : "admitted",
      "dispatch_failed"
    ).catch(() => false);
    throw error;
  }
}
export async function consumeSlackIngress(batch: MessageBatch<unknown>, env: Env): Promise<void> {
  const dlq = batch.queue.includes("dlq");
  for (const message of batch.messages) {
    const parsed = slackIngressJobSchema.safeParse(message.body);
    if (!parsed.success) {
      message.ack();
      continue;
    }
    try {
      await processSlackIngressJob(env, parsed.data, crypto.randomUUID(), dlq);
      message.ack();
    } catch {
      if (dlq) message.ack();
      else message.retry();
    }
  }
  if (dlq)
    log.warn("slack.ingress.dlq", {
      event: "slack.ingress.dlq",
      queue: batch.queue,
      message_count: batch.messages.length,
    });
}
