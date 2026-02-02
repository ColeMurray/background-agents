/**
 * Linear integration route handlers.
 * Handles Linear issue and team management.
 */

import type { Env } from "../types";
import { LinearAdapter } from "../adapters/linear-adapter";
import { json, error, getSessionStub } from "./helpers";

/**
 * List Linear issues.
 * GET /linear/issues?teamId=xxx&teamKey=xxx&query=xxx&cursor=xxx&limit=50
 */
export async function handleLinearIssues(
  request: Request,
  env: Env,
  _match: RegExpMatchArray
): Promise<Response> {
  if (!env.LINEAR_API_KEY) {
    return error("Linear integration not configured", 503);
  }
  const url = new URL(request.url);
  const teamId = url.searchParams.get("teamId") ?? undefined;
  const teamKey = url.searchParams.get("teamKey") ?? undefined;
  const query = url.searchParams.get("query") ?? undefined;
  const cursor = url.searchParams.get("cursor") ?? undefined;
  const limit = url.searchParams.get("limit");
  try {
    const client = new LinearAdapter(env.LINEAR_API_KEY);
    const result = await client.listIssues({
      teamId,
      teamKey,
      query,
      cursor,
      limit: limit ? parseInt(limit, 10) : undefined,
    });
    return json({
      issues: result.issues,
      cursor: result.cursor,
      hasMore: result.hasMore,
    });
  } catch (e) {
    console.error("[router] Linear listIssues error:", e);
    const msg = e instanceof Error ? e.message : "Failed to list Linear issues";
    return error(msg, 500);
  }
}

/**
 * List Linear teams.
 * GET /linear/teams
 */
export async function handleLinearTeams(
  _request: Request,
  env: Env,
  _match: RegExpMatchArray
): Promise<Response> {
  if (!env.LINEAR_API_KEY) {
    return error("Linear integration not configured", 503);
  }
  try {
    const client = new LinearAdapter(env.LINEAR_API_KEY);
    const teams = await client.listTeams();
    return json({ teams });
  } catch (e) {
    console.error("[router] Linear listTeams error:", e);
    const msg = e instanceof Error ? e.message : "Failed to list Linear teams";
    return error(msg, 500);
  }
}

/**
 * Link a task to a Linear issue.
 * POST /sessions/:id/linear/link-task
 */
export async function handleLinearLinkTask(
  request: Request,
  env: Env,
  match: RegExpMatchArray
): Promise<Response> {
  const sessionId = match.groups?.id;
  if (!sessionId) return error("Session ID required");

  let body: { messageId: string; eventId: string; taskIndex: number; linearIssueId: string };
  try {
    body = (await request.json()) as {
      messageId: string;
      eventId: string;
      taskIndex: number;
      linearIssueId: string;
    };
  } catch {
    return error("Invalid JSON body", 400);
  }
  if (
    !body.messageId ||
    !body.eventId ||
    typeof body.taskIndex !== "number" ||
    !body.linearIssueId
  ) {
    return error("messageId, eventId, taskIndex, and linearIssueId are required", 400);
  }

  const stub = getSessionStub(env, match);
  if (!stub) return error("Session ID required");

  const response = await stub.fetch(
    new Request("http://internal/internal/linear/link-task", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
  );
  return response;
}

/**
 * Link a session to a Linear issue or team.
 * POST /sessions/:id/linear/link-session
 */
export async function handleLinearLinkSession(
  request: Request,
  env: Env,
  match: RegExpMatchArray
): Promise<Response> {
  const sessionId = match.groups?.id;
  if (!sessionId) return error("Session ID required");

  let body: { linearIssueId?: string | null; linearTeamId?: string | null };
  try {
    body = (await request.json()) as {
      linearIssueId?: string | null;
      linearTeamId?: string | null;
    };
  } catch {
    return error("Invalid JSON body", 400);
  }
  const payload: { linearIssueId?: string | null; linearTeamId?: string | null } = {};
  if ("linearIssueId" in body) payload.linearIssueId = body.linearIssueId ?? null;
  if ("linearTeamId" in body) payload.linearTeamId = body.linearTeamId ?? null;

  const stub = getSessionStub(env, match);
  if (!stub) return error("Session ID required");

  const response = await stub.fetch(
    new Request("http://internal/internal/linear/link-session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    })
  );
  return response;
}

/**
 * Create a Linear issue and link it to a task.
 * POST /sessions/:id/linear/create-issue
 */
export async function handleLinearCreateIssue(
  request: Request,
  env: Env,
  match: RegExpMatchArray
): Promise<Response> {
  const sessionId = match.groups?.id;
  if (!sessionId) return error("Session ID required");

  if (!env.LINEAR_API_KEY) {
    return error("Linear integration not configured", 503);
  }

  let body: {
    messageId: string;
    eventId: string;
    taskIndex: number;
    teamId: string;
    title?: string;
    description?: string;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return error("Invalid JSON body", 400);
  }
  if (!body.messageId || !body.eventId || typeof body.taskIndex !== "number" || !body.teamId) {
    return error("messageId, eventId, taskIndex, and teamId are required", 400);
  }

  const title = body.title?.trim() || "Task from Open-Inspect";
  const description = body.description ?? undefined;

  try {
    const client = new LinearAdapter(env.LINEAR_API_KEY);
    const issue = await client.createIssue({
      teamId: body.teamId,
      title,
      description: description ?? null,
    });
    const stub = getSessionStub(env, match);
    if (!stub) return error("Session ID required");
    const linkResponse = await stub.fetch(
      new Request("http://internal/internal/linear/link-task", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messageId: body.messageId,
          eventId: body.eventId,
          taskIndex: body.taskIndex,
          linearIssueId: issue.id,
        }),
      })
    );
    if (!linkResponse.ok) {
      console.error("[router] Linear link-task after create failed:", await linkResponse.text());
      return json({ issue, linked: false }, 201);
    }
    return json({ issue, linked: true }, 201);
  } catch (e) {
    console.error("[router] Linear createIssue error:", e);
    const msg = e instanceof Error ? e.message : "Failed to create Linear issue";
    return error(msg, 500);
  }
}

/**
 * Update a Linear issue.
 * PATCH /linear/issues/:id
 */
export async function handleLinearUpdateIssue(
  request: Request,
  env: Env,
  match: RegExpMatchArray
): Promise<Response> {
  const issueId = match.groups?.id;
  if (!issueId) return error("Issue ID required");

  if (!env.LINEAR_API_KEY) {
    return error("Linear integration not configured", 503);
  }

  let body: { stateId?: string; assigneeId?: string | null; title?: string; description?: string };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return error("Invalid JSON body", 400);
  }

  try {
    const client = new LinearAdapter(env.LINEAR_API_KEY);
    const issue = await client.updateIssue(issueId, {
      stateId: body.stateId ?? undefined,
      assigneeId: body.assigneeId ?? undefined,
      title: body.title ?? undefined,
      description: body.description ?? undefined,
    });
    return json(issue);
  } catch (e) {
    console.error("[router] Linear updateIssue error:", e);
    const msg = e instanceof Error ? e.message : "Failed to update Linear issue";
    return error(msg, 500);
  }
}
