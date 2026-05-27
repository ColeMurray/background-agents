/**
 * GitHub automation event webhook route — internal endpoint that receives
 * pre-normalized GitHubAutomationEvents from the github-bot and proxies
 * them to the SchedulerDO for automation matching and session dispatch.
 */

import type { GitHubAutomationEvent } from "@open-inspect/shared";
import { verifyInternalToken } from "../auth/internal";
import type { Route, RequestContext } from "../routes/shared";
import { parsePattern, json, error } from "../routes/shared";
import type { Env } from "../types";

async function handleGitHubAutomationEvent(
  request: Request,
  env: Env,
  _match: RegExpMatchArray,
  _ctx: RequestContext
): Promise<Response> {
  // 0. Authenticate — fail closed if secret is unconfigured or token is invalid
  if (!env.INTERNAL_CALLBACK_SECRET) {
    return error("Internal authentication not configured", 500);
  }
  const isValid = await verifyInternalToken(
    request.headers.get("Authorization"),
    env.INTERNAL_CALLBACK_SECRET
  );
  if (!isValid) {
    return error("Unauthorized", 401);
  }

  // 1. Parse body
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return error("Invalid JSON", 400);
  }

  // 2. Validate required fields
  const event = body as Partial<GitHubAutomationEvent>;
  if (event.source !== "github") {
    return error("Invalid event: source must be 'github'", 400);
  }
  if (!event.repoOwner || !event.repoName) {
    return error("Invalid event: repoOwner and repoName are required", 400);
  }
  if (!event.eventType || !event.triggerKey || !event.concurrencyKey) {
    return error("Invalid event: eventType, triggerKey, and concurrencyKey are required", 400);
  }

  // 3. Forward to SchedulerDO
  if (!env.SCHEDULER) {
    return error("Scheduler not configured", 503);
  }

  const doId = env.SCHEDULER.idFromName("global-scheduler");
  const stub = env.SCHEDULER.get(doId);

  let response: Response;
  try {
    response = await stub.fetch("http://internal/internal/event", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(event),
    });
  } catch (_e) {
    return json({ ok: false, error: "Failed to reach scheduler" }, 502);
  }

  let result: { triggered: number; skipped: number };
  try {
    result = await response.json<{ triggered: number; skipped: number }>();
  } catch {
    return json({ ok: false, error: "Invalid response from scheduler" }, 502);
  }

  return json({ ok: true, ...result }, response.status);
}

export const githubAutomationEventRoute: Route = {
  method: "POST",
  pattern: parsePattern("/internal/github-event"),
  handler: handleGitHubAutomationEvent,
};
