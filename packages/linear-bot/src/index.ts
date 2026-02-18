/**
 * Open-Inspect Linear Bot Worker
 *
 * Cloudflare Worker that receives Linear webhooks and triggers
 * background coding agent sessions for issues.
 *
 * Trigger modes:
 * 1. Label trigger: Add a configured label (e.g. "agent") to an issue
 * 2. Assignee trigger: Assign issue to a configured user (e.g. "Open-Inspect")
 * 3. Auto-trigger: Automatically trigger on all new issues (opt-in)
 *
 * Flow:
 * Linear webhook → verify signature → check trigger → resolve repo →
 * create session → send prompt → post acknowledgment comment →
 * (agent works) → completion callback → post result comment with PR link
 */

import { Hono } from "hono";
import type {
  Env,
  LinearWebhookPayload,
  LinearIssueData,
  TeamRepoMapping,
  TriggerConfig,
  IssueSession,
  CallbackContext,
} from "./types";
import { verifyLinearWebhook, postIssueComment } from "./utils/linear-client";
import { generateInternalToken } from "./utils/internal";
import { callbacksRouter } from "./callbacks";
import { createLogger } from "./logger";
import { DEFAULT_MODEL } from "@open-inspect/shared";

const log = createLogger("handler");

// ─── Defaults ────────────────────────────────────────────────────────────────

const DEFAULT_TRIGGER_CONFIG: TriggerConfig = {
  triggerLabel: "agent",
  autoTriggerOnCreate: false,
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function getAuthHeaders(env: Env, traceId?: string): Promise<Record<string, string>> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (env.INTERNAL_CALLBACK_SECRET) {
    const authToken = await generateInternalToken(env.INTERNAL_CALLBACK_SECRET);
    headers["Authorization"] = `Bearer ${authToken}`;
  }
  if (traceId) headers["x-trace-id"] = traceId;
  return headers;
}

async function getTeamRepoMapping(env: Env): Promise<TeamRepoMapping> {
  try {
    const data = await env.LINEAR_KV.get("config:team-repos", "json");
    if (data && typeof data === "object") return data as TeamRepoMapping;
  } catch {
    // Fall through
  }
  return {};
}

async function getTriggerConfig(env: Env): Promise<TriggerConfig> {
  try {
    const data = await env.LINEAR_KV.get("config:triggers", "json");
    if (data && typeof data === "object") {
      return { ...DEFAULT_TRIGGER_CONFIG, ...(data as Partial<TriggerConfig>) };
    }
  } catch {
    // Fall through
  }
  return DEFAULT_TRIGGER_CONFIG;
}

function getIssueSessionKey(issueId: string): string {
  return `issue:${issueId}`;
}

async function lookupIssueSession(env: Env, issueId: string): Promise<IssueSession | null> {
  try {
    const data = await env.LINEAR_KV.get(getIssueSessionKey(issueId), "json");
    if (data && typeof data === "object") return data as IssueSession;
  } catch {
    // Fall through
  }
  return null;
}

async function storeIssueSession(env: Env, issueId: string, session: IssueSession): Promise<void> {
  await env.LINEAR_KV.put(getIssueSessionKey(issueId), JSON.stringify(session), {
    expirationTtl: 86400 * 7, // 7 days
  });
}

/**
 * Build a prompt from a Linear issue.
 */
function buildPromptFromIssue(issue: LinearIssueData): string {
  const parts: string[] = [
    `Linear Issue: ${issue.identifier} — ${issue.title}`,
    `Priority: ${issue.priorityLabel}`,
    `URL: ${issue.url}`,
  ];

  if (issue.labels.length > 0) {
    parts.push(`Labels: ${issue.labels.map((l) => l.name).join(", ")}`);
  }

  parts.push(""); // blank line

  if (issue.description) {
    parts.push(issue.description);
  } else {
    parts.push("(No description provided)");
  }

  parts.push("");
  parts.push(
    "Please implement the changes described in this issue. " + "Create a pull request when done."
  );

  return parts.join("\n");
}

/**
 * Create a session and send the issue as a prompt.
 */
async function createSessionForIssue(
  env: Env,
  issue: LinearIssueData,
  repoOwner: string,
  repoName: string,
  traceId?: string
): Promise<{ sessionId: string } | null> {
  const startTime = Date.now();
  const model = env.DEFAULT_MODEL || DEFAULT_MODEL;

  // Create session
  const headers = await getAuthHeaders(env, traceId);
  const sessionRes = await env.CONTROL_PLANE.fetch("https://internal/sessions", {
    method: "POST",
    headers,
    body: JSON.stringify({
      repoOwner,
      repoName,
      title: `${issue.identifier}: ${issue.title}`,
      model,
    }),
  });

  if (!sessionRes.ok) {
    log.error("control_plane.create_session", {
      trace_id: traceId,
      issue_id: issue.id,
      issue_identifier: issue.identifier,
      repo: `${repoOwner}/${repoName}`,
      http_status: sessionRes.status,
      outcome: "error",
      duration_ms: Date.now() - startTime,
    });
    return null;
  }

  const session = (await sessionRes.json()) as { sessionId: string };

  // Store mapping
  await storeIssueSession(env, issue.id, {
    sessionId: session.sessionId,
    issueId: issue.id,
    issueIdentifier: issue.identifier,
    repoOwner,
    repoName,
    model,
    createdAt: Date.now(),
  });

  // Build and send prompt
  const callbackContext: CallbackContext = {
    issueId: issue.id,
    issueIdentifier: issue.identifier,
    issueUrl: issue.url,
    repoFullName: `${repoOwner}/${repoName}`,
    model,
  };

  const promptRes = await env.CONTROL_PLANE.fetch(
    `https://internal/sessions/${session.sessionId}/prompt`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        content: buildPromptFromIssue(issue),
        authorId: `linear:${issue.assignee?.id || issue.team.id}`,
        source: "linear",
        callbackContext,
      }),
    }
  );

  if (!promptRes.ok) {
    log.error("control_plane.send_prompt", {
      trace_id: traceId,
      session_id: session.sessionId,
      issue_identifier: issue.identifier,
      http_status: promptRes.status,
      outcome: "error",
      duration_ms: Date.now() - startTime,
    });
    return null;
  }

  log.info("session.created", {
    trace_id: traceId,
    session_id: session.sessionId,
    issue_id: issue.id,
    issue_identifier: issue.identifier,
    repo: `${repoOwner}/${repoName}`,
    model,
    duration_ms: Date.now() - startTime,
  });

  return { sessionId: session.sessionId };
}

/**
 * Check if this webhook event should trigger the agent.
 */
function shouldTrigger(
  payload: LinearWebhookPayload,
  config: TriggerConfig
): { trigger: boolean; reason: string } {
  const { action, data: issue } = payload;

  // Label trigger: issue updated and the trigger label is present
  if (action === "update") {
    const hasLabel = issue.labels.some(
      (l) => l.name.toLowerCase() === config.triggerLabel.toLowerCase()
    );
    if (hasLabel) {
      return { trigger: true, reason: `label "${config.triggerLabel}" present` };
    }

    // Assignee trigger
    if (config.triggerAssignee && issue.assignee?.name === config.triggerAssignee) {
      return { trigger: true, reason: `assigned to "${config.triggerAssignee}"` };
    }
  }

  // Auto-trigger on create
  if (action === "create" && config.autoTriggerOnCreate) {
    return { trigger: true, reason: "auto-trigger on create" };
  }

  // Label trigger on create too
  if (action === "create") {
    const hasLabel = issue.labels.some(
      (l) => l.name.toLowerCase() === config.triggerLabel.toLowerCase()
    );
    if (hasLabel) {
      return { trigger: true, reason: `label "${config.triggerLabel}" on create` };
    }
  }

  return { trigger: false, reason: "no matching trigger" };
}

// ─── Routes ──────────────────────────────────────────────────────────────────

const app = new Hono<{ Bindings: Env }>();

app.get("/health", (c) => {
  return c.json({ status: "healthy", service: "open-inspect-linear-bot" });
});

/**
 * Linear webhook endpoint.
 */
app.post("/webhook", async (c) => {
  const startTime = Date.now();
  const traceId = crypto.randomUUID();
  const body = await c.req.text();
  const signature = c.req.header("linear-signature") ?? null;

  // Verify webhook signature
  const isValid = await verifyLinearWebhook(body, signature, c.env.LINEAR_WEBHOOK_SECRET);
  if (!isValid) {
    log.warn("http.request", {
      trace_id: traceId,
      http_path: "/webhook",
      http_status: 401,
      outcome: "rejected",
      reject_reason: "invalid_signature",
      duration_ms: Date.now() - startTime,
    });
    return c.json({ error: "Invalid signature" }, 401);
  }

  const payload = JSON.parse(body) as LinearWebhookPayload;

  // Only handle Issue events
  if (payload.type !== "Issue") {
    return c.json({ ok: true, skipped: true, reason: "not an issue event" });
  }

  // Deduplicate
  const dedupeKey = `event:${payload.data.id}:${payload.action}:${payload.data.updatedAt}`;
  const existing = await c.env.LINEAR_KV.get(dedupeKey);
  if (existing) {
    return c.json({ ok: true, skipped: true, reason: "duplicate" });
  }
  await c.env.LINEAR_KV.put(dedupeKey, "1", { expirationTtl: 3600 });

  // Process async
  c.executionCtx.waitUntil(handleLinearWebhook(payload, c.env, traceId));

  log.info("http.request", {
    trace_id: traceId,
    http_path: "/webhook",
    http_status: 200,
    action: payload.action,
    issue_identifier: payload.data.identifier,
    duration_ms: Date.now() - startTime,
  });

  return c.json({ ok: true });
});

/**
 * Configuration endpoints for team → repo mapping and triggers.
 */
app.get("/config/team-repos", async (c) => {
  const mapping = await getTeamRepoMapping(c.env);
  return c.json(mapping);
});

app.put("/config/team-repos", async (c) => {
  const body = await c.req.json();
  await c.env.LINEAR_KV.put("config:team-repos", JSON.stringify(body));
  return c.json({ ok: true });
});

app.get("/config/triggers", async (c) => {
  const config = await getTriggerConfig(c.env);
  return c.json(config);
});

app.put("/config/triggers", async (c) => {
  const body = await c.req.json();
  await c.env.LINEAR_KV.put("config:triggers", JSON.stringify(body));
  return c.json({ ok: true });
});

// Mount callbacks router
app.route("/callbacks", callbacksRouter);

/**
 * Handle a Linear webhook event.
 */
async function handleLinearWebhook(
  payload: LinearWebhookPayload,
  env: Env,
  traceId: string
): Promise<void> {
  const issue = payload.data;

  // Check trigger conditions
  const triggerConfig = await getTriggerConfig(env);
  const { trigger, reason } = shouldTrigger(payload, triggerConfig);

  if (!trigger) {
    log.debug("webhook.skipped", {
      trace_id: traceId,
      issue_identifier: issue.identifier,
      action: payload.action,
      reason,
    });
    return;
  }

  // Check if we already have a session for this issue
  const existingSession = await lookupIssueSession(env, issue.id);
  if (existingSession) {
    log.info("webhook.existing_session", {
      trace_id: traceId,
      issue_identifier: issue.identifier,
      session_id: existingSession.sessionId,
    });
    // Could send a follow-up prompt here if the issue was updated
    return;
  }

  // Resolve repo from team mapping
  const teamMapping = await getTeamRepoMapping(env);
  const repoConfig = teamMapping[issue.team.id];

  if (!repoConfig) {
    log.warn("webhook.no_repo_mapping", {
      trace_id: traceId,
      issue_identifier: issue.identifier,
      team_id: issue.team.id,
      team_key: issue.team.key,
      team_name: issue.team.name,
    });

    await postIssueComment(
      env.LINEAR_API_KEY,
      issue.id,
      `⚠️ **Open-Inspect:** No repository mapping configured for team "${issue.team.name}". ` +
        `Please configure the team → repo mapping via \`PUT /config/team-repos\`.`
    );
    return;
  }

  // Post acknowledgment comment
  await postIssueComment(
    env.LINEAR_API_KEY,
    issue.id,
    `🤖 **Open-Inspect** is picking up this issue. Working on \`${repoConfig.owner}/${repoConfig.name}\`...`
  );

  // Create session and send prompt
  const result = await createSessionForIssue(
    env,
    issue,
    repoConfig.owner,
    repoConfig.name,
    traceId
  );

  if (!result) {
    await postIssueComment(
      env.LINEAR_API_KEY,
      issue.id,
      `⚠️ **Open-Inspect:** Failed to create a coding session. Please try again or check the logs.`
    );
    return;
  }

  // Update the acknowledgment with session link
  await postIssueComment(
    env.LINEAR_API_KEY,
    issue.id,
    `🔗 [View session](${env.WEB_APP_URL}/session/${result.sessionId})`
  );

  log.info("webhook.session_started", {
    trace_id: traceId,
    issue_identifier: issue.identifier,
    session_id: result.sessionId,
    trigger_reason: reason,
    repo: `${repoConfig.owner}/${repoConfig.name}`,
  });
}

export default app;
