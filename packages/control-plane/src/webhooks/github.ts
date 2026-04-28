/**
 * GitHub automation event webhook route — internal endpoint that receives
 * pre-normalized GitHubAutomationEvents from the github-bot and proxies
 * them to the SchedulerDO for automation matching and session dispatch.
 */

import type { GitHubAutomationEvent } from "@open-inspect/shared";
import type { Route, RequestContext } from "../routes/shared";
import { parsePattern, json, error } from "../routes/shared";
import type { Env } from "../types";

async function handleGitHubAutomationEvent(
  request: Request,
  env: Env,
  _match: RegExpMatchArray,
  _ctx: RequestContext
): Promise<Response> {
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

  const response = await stub.fetch("http://internal/internal/event", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(event),
  });

  const result = await response.json<{ triggered: number; skipped: number }>();
  return json({ ok: true, ...result }, response.status === 200 ? 200 : response.status);
}

export const githubAutomationEventRoute: Route = {
  method: "POST",
  pattern: parsePattern("/internal/github-event"),
  handler: handleGitHubAutomationEvent,
};
