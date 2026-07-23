import { Hono } from "hono";
import { linearStartCallbackSchema } from "@open-inspect/shared";
import type { Env } from "../types";
import { createLogger } from "../logger";
import { rejectInvalidCallback } from "./reject-invalid-callback";
import { getLinearClient } from "../utils/linear-client";
import { transitionIssueToStarted } from "../utils/issue-start-transition";

const log = createLogger("callback");
const START_CALLBACK_MAX_AGE_MS = 5 * 60 * 1000;
const START_CALLBACK_MAX_FUTURE_SKEW_MS = 60 * 1000;

interface StartCallbackDependencies {
  getLinearClient: typeof getLinearClient;
  transitionIssueToStarted: typeof transitionIssueToStarted;
  now: () => number;
}

const defaultDependencies: StartCallbackDependencies = {
  getLinearClient,
  transitionIssueToStarted,
  now: () => Date.now(),
};

export function createStartCallbackRouter(
  dependencies: StartCallbackDependencies = defaultDependencies
): Hono<{ Bindings: Env }> {
  const router = new Hono<{ Bindings: Env }>();

  router.post("/start", async (c) => {
    const requestStartedAt = dependencies.now();
    const traceId = c.req.header("x-trace-id") || crypto.randomUUID();
    let rawPayload: unknown;
    try {
      rawPayload = await c.req.json();
    } catch {
      return c.json({ error: "invalid payload" }, 400);
    }

    const parsed = linearStartCallbackSchema.safeParse(rawPayload);
    if (!parsed.success) return c.json({ error: "invalid payload" }, 400);
    const payload = parsed.data;
    const callbackLogFields = {
      trace_id: traceId,
      session_id: payload.sessionId,
      message_id: payload.messageId,
      issue_id: payload.context.issueId,
    };

    const rejection = await rejectInvalidCallback(
      c,
      rawPayload as Record<string, unknown> & { signature: string }
    );
    if (rejection) return rejection;

    const ageMs = requestStartedAt - payload.timestamp;
    if (ageMs > START_CALLBACK_MAX_AGE_MS || ageMs < -START_CALLBACK_MAX_FUTURE_SKEW_MS) {
      log.warn("callback.started", {
        ...callbackLogFields,
        outcome: "skipped",
        skip_reason: "stale_callback",
        age_ms: ageMs,
      });
      return c.json({ ok: true, outcome: "stale_callback" });
    }

    const { context } = payload;
    if (context.transitionIssueOnStart !== true) {
      return c.json({ ok: true, outcome: "not_eligible" });
    }

    let client;
    try {
      client = await dependencies.getLinearClient(c.env, context.organizationId, context.appUserId);
    } catch (error) {
      log.warn("callback.started", {
        ...callbackLogFields,
        outcome: "error",
        error: error instanceof Error ? error : new Error(String(error)),
        duration_ms: dependencies.now() - requestStartedAt,
      });
      return c.json({ error: "Linear authentication failed" }, 503);
    }
    if (!client) return c.json({ error: "Linear authentication failed" }, 503);

    try {
      const result = await dependencies.transitionIssueToStarted(client, context.issueId);
      log.info("callback.started", {
        ...callbackLogFields,
        issue_identifier: context.issueIdentifier,
        outcome: result.outcome,
        ...(result.outcome !== "issue_not_found"
          ? { previous_state_type: result.previousStateType }
          : {}),
        ...(result.outcome === "transitioned"
          ? { state_id: result.stateId, state_name: result.stateName }
          : {}),
        duration_ms: dependencies.now() - requestStartedAt,
      });
      return c.json({ ok: true, outcome: result.outcome });
    } catch (error) {
      log.warn("callback.started", {
        ...callbackLogFields,
        outcome: "error",
        error: error instanceof Error ? error : new Error(String(error)),
        duration_ms: dependencies.now() - requestStartedAt,
      });
      return c.json({ error: "Linear issue transition failed" }, 502);
    }
  });

  return router;
}
