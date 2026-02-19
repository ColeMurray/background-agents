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
} from "./handlers";

const app = new Hono<{ Bindings: Env }>();

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
    handleWebhook(c.env, log, event, payload, traceId, deliveryId).catch((err) => {
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
  switch (event) {
    case "pull_request":
      if (p.action === "opened") {
        return handlePullRequestOpened(env, log, payload as PullRequestOpenedPayload, traceId);
      }
      if (p.action === "review_requested") {
        return handleReviewRequested(env, log, payload as ReviewRequestedPayload, traceId);
      }
      break;
    case "issue_comment":
      if (p.action === "created") {
        return handleIssueComment(env, log, payload as IssueCommentPayload, traceId);
      }
      break;
    case "pull_request_review_comment":
      if (p.action === "created") {
        return handleReviewComment(env, log, payload as ReviewCommentPayload, traceId);
      }
      break;
  }
  log.debug("webhook.ignored", {
    event_type: event,
    action: p?.action,
    trace_id: traceId,
    delivery_id: deliveryId,
  });
}

export default app;
