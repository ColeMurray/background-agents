/**
 * Open-Inspect GitHub Bot Worker
 *
 * Cloudflare Worker that handles GitHub webhook events and provides
 * automated code review and comment-triggered actions via the coding agent.
 */

import { Hono } from "hono";
import type {
  Env,
  PullRequestOpenedPayload,
  ReviewRequestedPayload,
  IssueCommentPayload,
  ReviewCommentPayload,
} from "./types";
import type { Logger } from "./logger";
import { createLogger, parseLogLevel } from "./logger";
import { verifyWebhookSignature } from "./verify";
import {
  handlePullRequestOpened,
  handleReviewRequested,
  handleIssueComment,
  handleReviewComment,
  type HandlerResult,
} from "./handlers";

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
    const existing = await c.env.GITHUB_KV.get(dedupeKey);
    if (existing) {
      log.info("webhook.duplicate_delivery", {
        delivery_id: deliveryId,
        event_type: event,
        dedupe_status: existing,
      });
      return c.json({ ok: true, duplicate: true });
    }

    await c.env.GITHUB_KV.put(dedupeKey, DELIVERY_STATUS_PROCESSING, {
      expirationTtl: ttlSecondsFromMs(DELIVERY_PROCESSING_TTL_MS),
    });
  } else {
    log.warn("webhook.delivery_id_missing", { event_type: event });
  }

  const payload = JSON.parse(rawBody);
  const traceId = crypto.randomUUID();

  log.info("webhook.received", {
    event_type: event,
    delivery_id: deliveryId,
    trace_id: traceId,
    repo: payload?.repository
      ? `${payload.repository.owner?.login}/${payload.repository.name}`
      : undefined,
    action: payload?.action,
  });

  c.executionCtx.waitUntil(
    handleWebhook(c.env, log, event, payload, traceId, deliveryId)
      .then(async () => {
        if (!dedupeKey) return;

        try {
          await c.env.GITHUB_KV.put(dedupeKey, DELIVERY_STATUS_PROCESSED, {
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
            await c.env.GITHUB_KV.delete(dedupeKey);
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
  const p = payload as Record<string, unknown>;
  const repo = p.repository
    ? `${(p.repository as Record<string, unknown> & { owner: { login: string }; name: string }).owner.login}/${(p.repository as Record<string, unknown> & { name: string }).name}`
    : undefined;
  const sender = (p.sender as { login?: string } | undefined)?.login;
  const pullNumber =
    (p.pull_request as { number?: number } | undefined)?.number ??
    (p.issue as { number?: number } | undefined)?.number;

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
}

function dispatchHandler(
  env: Env,
  log: Logger,
  event: string | undefined,
  p: Record<string, unknown>,
  payload: unknown,
  traceId: string
): Promise<HandlerResult> {
  switch (event) {
    case "pull_request":
      if (p.action === "opened") {
        return handlePullRequestOpened(env, log, payload as PullRequestOpenedPayload, traceId);
      }
      if (p.action === "review_requested") {
        return handleReviewRequested(env, log, payload as ReviewRequestedPayload, traceId);
      }
      return Promise.resolve({
        outcome: "skipped",
        skip_reason: "unsupported_action",
      });
    case "issue_comment":
      if (p.action === "created") {
        return handleIssueComment(env, log, payload as IssueCommentPayload, traceId);
      }
      return Promise.resolve({
        outcome: "skipped",
        skip_reason: "unsupported_action",
      });
    case "pull_request_review_comment":
      if (p.action === "created") {
        return handleReviewComment(env, log, payload as ReviewCommentPayload, traceId);
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
