/**
 * Open-Inspect GitHub Bot Worker
 *
 * Cloudflare Worker that handles GitHub webhook events and provides
 * automated code review and comment-triggered actions via the coding agent.
 */

import { Hono } from "hono";
import type { Env } from "./types";
import type { Logger } from "./logger";
import { createLogger, parseLogLevel } from "./logger";
import { verifyWebhookSignature } from "./verify";
import { normalizeGitHubEvent, buildInternalAuthHeaders } from "@open-inspect/shared";
import {
  issueCommentPayloadSchema,
  pullRequestOpenedPayloadSchema,
  reviewCommentPayloadSchema,
  reviewRequestedPayloadSchema,
  webhookActionPayloadSchema,
  webhookSummaryPayloadSchema,
  type WebhookSummaryPayload,
} from "./payload-schemas";
import {
  handlePullRequestOpened,
  handleReviewRequested,
  handleIssueComment,
  handleReviewComment,
  isReviewRequestedForBot,
  type HandlerResult,
} from "./handlers";
import { createKvCacheStore } from "@open-inspect/shared";

const app = new Hono<{ Bindings: Env }>();
const DELIVERY_DEDUPE_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
const DELIVERY_PROCESSING_TTL_MS = 5 * 60 * 1_000;
const DELIVERY_STATUS_PROCESSING = "processing";
const DELIVERY_STATUS_PROCESSED = "processed";

function getDeliveryDedupeKey(deliveryId: string): string {
  return `delivery:${deliveryId}`;
}

function ttlSecondsFromMs(ttlMs: number): number {
  return Math.ceil(ttlMs / 1_000);
}

app.get("/health", (c) => c.json({ status: "healthy", service: "open-inspect-github-bot" }));

app.post("/webhooks/github", async (c) => {
  const log = createLogger("webhook", {}, parseLogLevel(c.env.LOG_LEVEL));
  const cacheStore = createKvCacheStore(c.env.GITHUB_KV);

  const rawBody = await c.req.text();
  const signature = c.req.header("X-Hub-Signature-256") ?? null;
  const event = c.req.header("X-GitHub-Event");
  const deliveryId = c.req.header("X-GitHub-Delivery");

  const valid = await verifyWebhookSignature(c.env.GITHUB_WEBHOOK_SECRET, rawBody, signature);
  if (!valid) {
    log.warn("webhook.signature_invalid", { delivery_id: deliveryId });
    return c.json({ error: "invalid signature" }, 401);
  }

  let dedupeKey: string | null = null;
  if (deliveryId) {
    dedupeKey = getDeliveryDedupeKey(deliveryId);
    const existing = await cacheStore.get(dedupeKey);
    if (existing) {
      log.info("webhook.duplicate_delivery", {
        delivery_id: deliveryId,
        event_type: event,
        dedupe_status: existing,
      });
      return c.json({ ok: true, duplicate: true });
    }

    await cacheStore.put(dedupeKey, DELIVERY_STATUS_PROCESSING, {
      expirationTtl: ttlSecondsFromMs(DELIVERY_PROCESSING_TTL_MS),
    });
  } else {
    log.warn("webhook.delivery_id_missing", { event_type: event });
  }

  const payload: unknown = JSON.parse(rawBody);
  const summaryResult = webhookSummaryPayloadSchema.safeParse(payload);
  const summary = summaryResult.success ? summaryResult.data : null;
  const actionResult = webhookActionPayloadSchema.safeParse(payload);
  const action = summary?.action ?? (actionResult.success ? actionResult.data.action : undefined);
  const traceId = crypto.randomUUID();

  log.info("webhook.received", {
    event_type: event,
    delivery_id: deliveryId,
    trace_id: traceId,
    repo: summary?.repository
      ? `${summary.repository.owner.login}/${summary.repository.name}`
      : undefined,
    action,
  });

  c.executionCtx.waitUntil(
    handleWebhook(c.env, log, event, payload, traceId, deliveryId)
      .then(async () => {
        if (!dedupeKey) return;

        try {
          await cacheStore.put(dedupeKey, DELIVERY_STATUS_PROCESSED, {
            expirationTtl: ttlSecondsFromMs(DELIVERY_DEDUPE_TTL_MS),
          });
        } catch (err) {
          log.warn("webhook.dedupe_finalize_failed", {
            trace_id: traceId,
            delivery_id: deliveryId,
            error: err instanceof Error ? err : new Error(String(err)),
          });
        }
      })
      .catch(async (err) => {
        if (dedupeKey) {
          try {
            await cacheStore.delete(dedupeKey);
          } catch (deleteErr) {
            log.warn("webhook.dedupe_clear_failed", {
              trace_id: traceId,
              delivery_id: deliveryId,
              error: deleteErr instanceof Error ? deleteErr : new Error(String(deleteErr)),
            });
          }
        }

        log.error("webhook.processing_error", {
          trace_id: traceId,
          delivery_id: deliveryId,
          error: err instanceof Error ? err : new Error(String(err)),
        });
      })
  );

  return c.json({ ok: true });
});

async function handleWebhook(
  env: Env,
  log: Logger,
  event: string | undefined,
  payload: unknown,
  traceId: string,
  deliveryId: string | undefined
): Promise<void> {
  const parsed = webhookSummaryPayloadSchema.safeParse(payload);
  const actionResult = webhookActionPayloadSchema.safeParse(payload);
  const p: WebhookSummaryPayload = parsed.success
    ? parsed.data
    : { action: actionResult.success ? actionResult.data.action : undefined };
  const repo = p.repository ? `${p.repository.owner.login}/${p.repository.name}` : undefined;
  const sender = p.sender?.login;
  const pullNumber = p.pull_request?.number ?? p.issue?.number;

  const wideEventBase = {
    trace_id: traceId,
    delivery_id: deliveryId,
    event_type: event,
    action: p.action,
    repo,
    pull_number: pullNumber,
    sender,
  };

  const start = Date.now();
  let result: HandlerResult;

  try {
    result = await dispatchHandler(env, log, event, p, payload, traceId);
  } catch (err) {
    log.info("webhook.handled", {
      ...wideEventBase,
      outcome: "error",
      duration_ms: Date.now() - start,
      error: err instanceof Error ? err : new Error(String(err)),
    });
    throw err;
  }

  const wideEvent: Record<string, unknown> = {
    ...wideEventBase,
    outcome: result.outcome,
    duration_ms: Date.now() - start,
  };
  if (result.outcome === "skipped") {
    wideEvent.skip_reason = result.skip_reason;
  } else {
    wideEvent.session_id = result.session_id;
    wideEvent.message_id = result.message_id;
    wideEvent.handler_action = result.handler_action;
  }
  log.info("webhook.handled", wideEvent);

  // Forward normalized event to control-plane for automation triggering.
  // This is additive — failures here must not affect existing bot behavior.
  if (event) {
    const normalizedEvent = normalizeGitHubEvent(event, p);
    if (normalizedEvent !== null) {
      try {
        const body = JSON.stringify(normalizedEvent);
        const authHeaders = await buildInternalAuthHeaders(env.INTERNAL_CALLBACK_SECRET, traceId);
        const response = await env.CONTROL_PLANE.fetch("https://internal/internal/github-event", {
          method: "POST",
          headers: { "Content-Type": "application/json", ...authHeaders },
          body,
        });
        if (!response.ok) {
          log.warn("webhook.github_event_forward_failed", {
            trace_id: traceId,
            delivery_id: deliveryId,
            event_type: event,
            status: response.status,
          });
        }
      } catch (err) {
        log.warn("webhook.github_event_forward_error", {
          trace_id: traceId,
          delivery_id: deliveryId,
          event_type: event,
          error: err instanceof Error ? err : new Error(String(err)),
        });
      }
    }
  }
}

function dispatchHandler(
  env: Env,
  log: Logger,
  event: string | undefined,
  p: WebhookSummaryPayload,
  payload: unknown,
  traceId: string
): Promise<HandlerResult> {
  switch (event) {
    case "pull_request":
      if (p.action === "opened") {
        const parsed = pullRequestOpenedPayloadSchema.safeParse(payload);
        if (!parsed.success) throw new Error("Malformed pull_request opened payload");
        return handlePullRequestOpened(env, log, parsed.data, traceId);
      }
      if (p.action === "review_requested") {
        if (!isReviewRequestedForBot(payload, env.GITHUB_BOT_USERNAME)) {
          return Promise.resolve({ outcome: "skipped", skip_reason: "review_not_for_bot" });
        }
        const parsed = reviewRequestedPayloadSchema.safeParse(payload);
        if (!parsed.success) throw new Error("Malformed pull_request review_requested payload");
        return handleReviewRequested(env, log, parsed.data, traceId);
      }
      return Promise.resolve({
        outcome: "skipped",
        skip_reason: "unsupported_action",
      });
    case "issue_comment":
      if (p.action === "created") {
        const parsed = issueCommentPayloadSchema.safeParse(payload);
        if (!parsed.success) throw new Error("Malformed issue_comment created payload");
        return handleIssueComment(env, log, parsed.data, traceId);
      }
      return Promise.resolve({
        outcome: "skipped",
        skip_reason: "unsupported_action",
      });
    case "pull_request_review_comment":
      if (p.action === "created") {
        const parsed = reviewCommentPayloadSchema.safeParse(payload);
        if (!parsed.success)
          throw new Error("Malformed pull_request_review_comment created payload");
        return handleReviewComment(env, log, parsed.data, traceId);
      }
      return Promise.resolve({
        outcome: "skipped",
        skip_reason: "unsupported_action",
      });
    default:
      return Promise.resolve({
        outcome: "skipped",
        skip_reason: "unsupported_event",
      });
  }
}

export default app;
