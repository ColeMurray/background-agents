/**
 * Open-Inspect Linear Agent Worker
 *
 * Cloudflare Worker handling Linear AgentSessionEvent webhooks.
 * Features: dynamic repo fetching, LLM classification, project-based routing,
 * user model preferences, model override via labels, event deduplication,
 * full issue context injection, richer completion callbacks, and status
 * via Agent Activities.
 */

import { Hono } from "hono";
import type {
  Env,
  TeamRepoMapping,
  TriggerConfig,
  IssueSession,
  CallbackContext,
  StaticRepoConfig,
  ProjectRepoMapping,
  UserPreferences,
  LinearIssueDetails,
} from "./types";
import {
  buildOAuthAuthorizeUrl,
  exchangeCodeForToken,
  getLinearClient,
  emitAgentActivity,
  verifyLinearWebhook,
  fetchIssueDetails,
  updateAgentSession,
  getRepoSuggestions,
} from "./utils/linear-client";
import { generateInternalToken } from "./utils/internal";
import { classifyRepo } from "./classifier/index";
import { getAvailableRepos } from "./classifier/repos";
import { callbacksRouter } from "./callbacks";
import { createLogger } from "./logger";
import {
  getDefaultReasoningEffort,
  getValidModelOrDefault,
  isValidReasoningEffort,
  verifyInternalToken,
} from "@open-inspect/shared";
import { getLinearConfig } from "./utils/integration-config";

const log = createLogger("handler");

// ─── Agent Plan Helpers ──────────────────────────────────────────────────────

type PlanStepStatus = "pending" | "inProgress" | "completed" | "canceled";

interface PlanStep {
  content: string;
  status: PlanStepStatus;
}

function makePlan(
  stage: "start" | "repo_resolved" | "session_created" | "completed" | "failed"
): PlanStep[] {
  const steps = [
    "Analyze issue",
    "Resolve repository",
    "Create coding session",
    "Code changes",
    "Open PR",
  ];
  const statusMap: Record<string, PlanStepStatus[]> = {
    start: ["inProgress", "inProgress", "pending", "pending", "pending"],
    repo_resolved: ["completed", "completed", "inProgress", "pending", "pending"],
    session_created: ["completed", "completed", "completed", "inProgress", "pending"],
    completed: ["completed", "completed", "completed", "completed", "completed"],
    failed: ["completed", "completed", "completed", "completed", "canceled"],
  };
  const statuses = statusMap[stage];
  return steps.map((content, i) => ({ content, status: statuses[i] }));
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const DEFAULT_TRIGGER_CONFIG: TriggerConfig = {
  triggerLabel: "agent",
  autoTriggerOnCreate: false,
  triggerCommand: "@agent",
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
  } catch (e) {
    log.debug("kv.get_team_repo_mapping_failed", {
      error: e instanceof Error ? e.message : String(e),
    });
  }
  return {};
}

async function getProjectRepoMapping(env: Env): Promise<ProjectRepoMapping> {
  try {
    const data = await env.LINEAR_KV.get("config:project-repos", "json");
    if (data && typeof data === "object") return data as ProjectRepoMapping;
  } catch (e) {
    log.debug("kv.get_project_repo_mapping_failed", {
      error: e instanceof Error ? e.message : String(e),
    });
  }
  return {};
}

async function getTriggerConfig(env: Env): Promise<TriggerConfig> {
  try {
    const data = await env.LINEAR_KV.get("config:triggers", "json");
    if (data && typeof data === "object") {
      return { ...DEFAULT_TRIGGER_CONFIG, ...(data as Partial<TriggerConfig>) };
    }
  } catch (e) {
    log.debug("kv.get_trigger_config_failed", {
      error: e instanceof Error ? e.message : String(e),
    });
  }
  return DEFAULT_TRIGGER_CONFIG;
}

async function getUserPreferences(env: Env, userId: string): Promise<UserPreferences | null> {
  try {
    const data = await env.LINEAR_KV.get(`user_prefs:${userId}`, "json");
    if (data && typeof data === "object") return data as UserPreferences;
  } catch (e) {
    log.debug("kv.get_user_preferences_failed", {
      userId,
      error: e instanceof Error ? e.message : String(e),
    });
  }
  return null;
}

function getIssueSessionKey(issueId: string): string {
  return `issue:${issueId}`;
}

async function lookupIssueSession(env: Env, issueId: string): Promise<IssueSession | null> {
  try {
    const data = await env.LINEAR_KV.get(getIssueSessionKey(issueId), "json");
    if (data && typeof data === "object") return data as IssueSession;
  } catch (e) {
    log.debug("kv.lookup_issue_session_failed", {
      issueId,
      error: e instanceof Error ? e.message : String(e),
    });
  }
  return null;
}

async function storeIssueSession(env: Env, issueId: string, session: IssueSession): Promise<void> {
  await env.LINEAR_KV.put(getIssueSessionKey(issueId), JSON.stringify(session), {
    expirationTtl: 86400 * 7,
  });
}

/**
 * Check if an event has already been processed (deduplication).
 */
async function isDuplicateEvent(env: Env, eventKey: string): Promise<boolean> {
  const existing = await env.LINEAR_KV.get(`event:${eventKey}`);
  if (existing) return true;
  await env.LINEAR_KV.put(`event:${eventKey}`, "1", { expirationTtl: 3600 });
  return false;
}

/**
 * Resolve repo from static team mapping (legacy/override).
 */
export function resolveStaticRepo(
  teamMapping: TeamRepoMapping,
  teamId: string,
  issueLabels?: string[]
): StaticRepoConfig | null {
  const repoConfigs = teamMapping[teamId];
  if (!repoConfigs || repoConfigs.length === 0) return null;

  const labelSet = new Set((issueLabels || []).map((l) => l.toLowerCase()));
  return (
    repoConfigs.find((r) => r.label && labelSet.has(r.label.toLowerCase())) ||
    repoConfigs.find((r) => !r.label) ||
    null
  );
}

/**
 * Extract model override from issue labels (e.g., "model:opus" → "anthropic/claude-opus-4-5").
 */
export function extractModelFromLabels(labels: Array<{ name: string }>): string | null {
  const MODEL_LABEL_MAP: Record<string, string> = {
    haiku: "anthropic/claude-haiku-4-5",
    sonnet: "anthropic/claude-sonnet-4-5",
    opus: "anthropic/claude-opus-4-5",
    "opus-4-6": "anthropic/claude-opus-4-6",
    "gpt-5.2": "openai/gpt-5.2",
    "gpt-5.2-codex": "openai/gpt-5.2-codex",
    "gpt-5.3-codex": "openai/gpt-5.3-codex",
  };

  for (const label of labels) {
    const match = label.name.match(/^model:(.+)$/i);
    if (match) {
      const key = match[1].toLowerCase();
      if (MODEL_LABEL_MAP[key]) return MODEL_LABEL_MAP[key];
    }
  }
  return null;
}

interface ResolveSessionModelInput {
  envDefaultModel: string;
  configModel: string | null;
  configReasoningEffort: string | null;
  allowUserPreferenceOverride: boolean;
  allowLabelModelOverride: boolean;
  userModel?: string;
  userReasoningEffort?: string;
  labelModel?: string | null;
}

export function resolveSessionModelSettings(input: ResolveSessionModelInput): {
  model: string;
  reasoningEffort: string | undefined;
} {
  let model = input.configModel ?? input.envDefaultModel;
  let modelSource: "config" | "env" | "user" | "label" = input.configModel ? "config" : "env";

  if (input.allowUserPreferenceOverride && input.userModel) {
    model = input.userModel;
    modelSource = "user";
  }

  if (input.allowLabelModelOverride && input.labelModel) {
    model = input.labelModel;
    modelSource = "label";
  }

  const normalizedModel = getValidModelOrDefault(model);

  if (
    input.allowUserPreferenceOverride &&
    input.userReasoningEffort &&
    isValidReasoningEffort(normalizedModel, input.userReasoningEffort)
  ) {
    return { model: normalizedModel, reasoningEffort: input.userReasoningEffort };
  }

  if (
    modelSource !== "user" &&
    modelSource !== "label" &&
    input.configReasoningEffort &&
    isValidReasoningEffort(normalizedModel, input.configReasoningEffort)
  ) {
    return { model: normalizedModel, reasoningEffort: input.configReasoningEffort };
  }

  return { model: normalizedModel, reasoningEffort: getDefaultReasoningEffort(normalizedModel) };
}

// ─── Routes ──────────────────────────────────────────────────────────────────

const app = new Hono<{ Bindings: Env }>();

app.get("/health", (c) => {
  return c.json({ status: "healthy", service: "open-inspect-linear-bot" });
});

// ─── OAuth Routes ────────────────────────────────────────────────────────────

app.get("/oauth/authorize", (c) => {
  return c.redirect(buildOAuthAuthorizeUrl(c.env), 302);
});

app.get("/oauth/callback", async (c) => {
  const error = c.req.query("error");
  if (error) return c.text(`OAuth Error: ${error}`, 400);

  const code = c.req.query("code");
  if (!code) return c.text("Missing required OAuth parameters", 400);

  try {
    const { orgName } = await exchangeCodeForToken(c.env, code);
    return c.html(`
      <html>
        <head><title>OAuth Success</title></head>
        <body>
          <h1>Open-Inspect Agent Installed!</h1>
          <p>Successfully connected to workspace: <strong>${escapeHtml(orgName)}</strong></p>
          <p>You can now @mention or assign the agent on Linear issues.</p>
        </body>
      </html>
    `);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error("oauth.callback_error", { error: err instanceof Error ? err : new Error(msg) });
    return c.text(`Token exchange error: ${msg}`, 500);
  }
});

// ─── Webhook Handler ─────────────────────────────────────────────────────────

app.post("/webhook", async (c) => {
  const startTime = Date.now();
  const traceId = crypto.randomUUID();
  const body = await c.req.text();
  const signature = c.req.header("linear-signature") ?? null;

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

  const payload = JSON.parse(body) as Record<string, unknown>;
  const eventType = payload.type as string;
  const action = payload.action as string;

  if (eventType === "AgentSessionEvent") {
    // Deduplicate: use agentSession.id + action as key
    const agentSession = payload.agentSession as { id: string } | undefined;
    if (agentSession) {
      const eventKey = `${agentSession.id}:${action}`;
      const isDuplicate = await isDuplicateEvent(c.env, eventKey);
      if (isDuplicate) {
        log.info("webhook.deduplicated", { trace_id: traceId, event_key: eventKey });
        return c.json({ ok: true, skipped: true, reason: "duplicate" });
      }
    }

    c.executionCtx.waitUntil(handleAgentSessionEvent(payload, c.env, traceId));

    log.info("http.request", {
      trace_id: traceId,
      http_path: "/webhook",
      http_status: 200,
      type: eventType,
      action,
      duration_ms: Date.now() - startTime,
    });
    return c.json({ ok: true });
  }

  log.debug("webhook.skipped", { trace_id: traceId, type: eventType, action });
  return c.json({ ok: true, skipped: true, reason: `unhandled event type: ${eventType}` });
});

// ─── Config Auth Middleware ───────────────────────────────────────────────────

app.use("/config/*", async (c, next) => {
  const secret = c.env.INTERNAL_CALLBACK_SECRET;
  if (!secret) return c.json({ error: "Auth not configured" }, 500);
  const isValid = await verifyInternalToken(c.req.header("Authorization") ?? null, secret);
  if (!isValid) return c.json({ error: "Unauthorized" }, 401);
  return next();
});

// ─── Config Endpoints ────────────────────────────────────────────────────────

app.get("/config/team-repos", async (c) => {
  return c.json(await getTeamRepoMapping(c.env));
});

app.put("/config/team-repos", async (c) => {
  const body = await c.req.json();
  await c.env.LINEAR_KV.put("config:team-repos", JSON.stringify(body));
  return c.json({ ok: true });
});

app.get("/config/triggers", async (c) => {
  return c.json(await getTriggerConfig(c.env));
});

app.put("/config/triggers", async (c) => {
  const body = await c.req.json();
  await c.env.LINEAR_KV.put("config:triggers", JSON.stringify(body));
  return c.json({ ok: true });
});

app.get("/config/project-repos", async (c) => {
  return c.json(await getProjectRepoMapping(c.env));
});

app.put("/config/project-repos", async (c) => {
  const body = await c.req.json();
  await c.env.LINEAR_KV.put("config:project-repos", JSON.stringify(body));
  return c.json({ ok: true });
});

app.get("/config/user-prefs/:userId", async (c) => {
  const userId = c.req.param("userId");
  const prefs = await getUserPreferences(c.env, userId);
  if (!prefs) return c.json({ error: "not found" }, 404);
  return c.json(prefs);
});

app.put("/config/user-prefs/:userId", async (c) => {
  const userId = c.req.param("userId");
  const body = (await c.req.json()) as Partial<UserPreferences>;
  const prefs: UserPreferences = {
    userId,
    model: body.model || c.env.DEFAULT_MODEL,
    reasoningEffort: body.reasoningEffort,
    updatedAt: Date.now(),
  };
  await c.env.LINEAR_KV.put(`user_prefs:${userId}`, JSON.stringify(prefs));
  return c.json({ ok: true });
});

// Mount callbacks router
app.route("/callbacks", callbacksRouter);

// ─── Agent Session Event Handler ─────────────────────────────────────────────

async function handleAgentSessionEvent(
  webhook: Record<string, unknown>,
  env: Env,
  traceId: string
): Promise<void> {
  const startTime = Date.now();
  const agentSession = webhook.agentSession as {
    id: string;
    issue?: {
      id: string;
      identifier: string;
      title: string;
      description?: string;
      url: string;
      priority: number;
      priorityLabel: string;
      team: { id: string; key: string; name: string };
      teamId?: string;
      labels?: Array<{ id: string; name: string }>;
      assignee?: { id: string; name: string };
      project?: { id: string; name: string };
    };
    comment?: { body: string };
    promptContext?: string;
  };
  // For "prompted" action, the follow-up message is in agentActivity.body
  const agentActivity = webhook.agentActivity as { body?: string } | undefined;
  const issue = agentSession.issue;
  const comment = agentSession.comment;
  const orgId = webhook.organizationId as string;
  const agentSessionId = agentSession.id;

  log.info("agent_session.received", {
    trace_id: traceId,
    action: webhook.action,
    agent_session_id: agentSessionId,
    issue_id: issue?.id,
    issue_identifier: issue?.identifier,
    has_comment: Boolean(comment),
    org_id: orgId,
  });

  // ─── Stop handling ──────────────────────────────────────────────────────
  if (webhook.action === "stopped" || webhook.action === "cancelled") {
    const issueId = issue?.id;
    if (issueId) {
      const existingSession = await lookupIssueSession(env, issueId);
      if (existingSession) {
        // Kill the sandbox session via control plane
        const headers = await getAuthHeaders(env, traceId);
        try {
          const stopRes = await env.CONTROL_PLANE.fetch(
            `https://internal/sessions/${existingSession.sessionId}/stop`,
            { method: "POST", headers }
          );
          log.info("agent_session.stopped", {
            trace_id: traceId,
            agent_session_id: agentSessionId,
            session_id: existingSession.sessionId,
            issue_id: issueId,
            stop_status: stopRes.status,
          });
        } catch (e) {
          log.error("agent_session.stop_failed", {
            trace_id: traceId,
            session_id: existingSession.sessionId,
            error: e instanceof Error ? e : new Error(String(e)),
          });
        }
        // Clean up the issue→session mapping
        await env.LINEAR_KV.delete(`issue:${issueId}`);
      }
    }
    log.info("agent_session.stop_handled", {
      trace_id: traceId,
      action: webhook.action,
      agent_session_id: agentSessionId,
      duration_ms: Date.now() - startTime,
    });
    return;
  }

  if (!issue) {
    log.warn("agent_session.no_issue", { trace_id: traceId, agent_session_id: agentSessionId });
    return;
  }

  const client = await getLinearClient(env, orgId);
  if (!client) {
    log.error("agent_session.no_oauth_token", {
      trace_id: traceId,
      org_id: orgId,
      agent_session_id: agentSessionId,
    });
    return;
  }

  // ─── Follow-up handling (action: "prompted") ───────────────────────────
  const existingSession = await lookupIssueSession(env, issue.id);
  if (existingSession && webhook.action === "prompted") {
    // For "prompted" action, the user's message is in agentActivity.body
    const followUpContent = agentActivity?.body || comment?.body || "Follow-up on the issue.";

    await emitAgentActivity(
      client,
      agentSessionId,
      {
        type: "thought",
        body: "Processing follow-up message...",
      },
      true
    );

    // Fetch recent session events for context
    const headers = await getAuthHeaders(env, traceId);
    let sessionContext = "";
    try {
      const eventsRes = await env.CONTROL_PLANE.fetch(
        `https://internal/sessions/${existingSession.sessionId}/events?limit=20`,
        { method: "GET", headers }
      );
      if (eventsRes.ok) {
        const eventsData = (await eventsRes.json()) as {
          events: Array<{ type: string; data: Record<string, unknown> }>;
        };
        const recentTokens = eventsData.events.filter((e) => e.type === "token").slice(-1);
        if (recentTokens.length > 0) {
          const lastContent = String(recentTokens[0].data.content ?? "");
          if (lastContent) {
            sessionContext = `\n\n---\n**Previous agent response (summary):**\n${lastContent.slice(0, 500)}`;
          }
        }
      }
    } catch {
      /* best effort */
    }

    const promptRes = await env.CONTROL_PLANE.fetch(
      `https://internal/sessions/${existingSession.sessionId}/prompt`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          content: `Follow-up on ${issue.identifier}:\n\n${followUpContent}${sessionContext}`,
          authorId: `linear:${webhook.appUserId}`,
          source: "linear",
        }),
      }
    );

    if (promptRes.ok) {
      await emitAgentActivity(client, agentSessionId, {
        type: "response",
        body: `Follow-up sent to existing session.\n\n[View session](${env.WEB_APP_URL}/session/${existingSession.sessionId})`,
      });
    } else {
      await emitAgentActivity(client, agentSessionId, {
        type: "error",
        body: "Failed to send follow-up to the existing session.",
      });
    }

    log.info("agent_session.followup", {
      trace_id: traceId,
      issue_identifier: issue.identifier,
      session_id: existingSession.sessionId,
      agent_session_id: agentSessionId,
      duration_ms: Date.now() - startTime,
    });
    return;
  }

  // ─── New session ───────────────────────────────────────────────────────

  await updateAgentSession(client, agentSessionId, { plan: makePlan("start") });
  await emitAgentActivity(
    client,
    agentSessionId,
    {
      type: "thought",
      body: "Analyzing issue and resolving repository...",
    },
    true
  );

  // Fetch full issue details for context
  const issueDetails = await fetchIssueDetails(client, issue.id);
  const labels = issueDetails?.labels || issue.labels || [];
  const labelNames = labels.map((l) => l.name);
  const projectInfo = issueDetails?.project || issue.project;

  // ─── Resolve repo ─────────────────────────────────────────────────────

  let repoOwner: string | null = null;
  let repoName: string | null = null;
  let repoFullName: string | null = null;
  let classificationReasoning: string | null = null;

  // 1. Check project→repo mapping FIRST
  if (projectInfo?.id) {
    const projectMapping = await getProjectRepoMapping(env);
    const mapped = projectMapping[projectInfo.id];
    if (mapped) {
      repoOwner = mapped.owner;
      repoName = mapped.name;
      repoFullName = `${mapped.owner}/${mapped.name}`;
      classificationReasoning = `Project "${projectInfo.name}" is mapped to ${repoFullName}`;
    }
  }

  // 2. Check static team→repo mapping (override)
  if (!repoOwner) {
    const teamMapping = await getTeamRepoMapping(env);
    const teamId = issue.team?.id ?? "";
    if (teamId && teamMapping[teamId] && teamMapping[teamId].length > 0) {
      const staticRepo = resolveStaticRepo(teamMapping, teamId, labelNames);
      if (staticRepo) {
        repoOwner = staticRepo.owner;
        repoName = staticRepo.name;
        repoFullName = `${staticRepo.owner}/${staticRepo.name}`;
        classificationReasoning = `Team static mapping`;
      }
    }
  }

  // 3. Try Linear's built-in issueRepositorySuggestions API
  if (!repoOwner) {
    const repos = await getAvailableRepos(env, traceId);
    if (repos.length > 0) {
      const candidates = repos.map((r) => ({
        hostname: "github.com",
        repositoryFullName: `${r.owner}/${r.name}`,
      }));

      const suggestions = await getRepoSuggestions(client, issue.id, agentSessionId, candidates);
      const topSuggestion = suggestions.find((s) => s.confidence >= 0.7);
      if (topSuggestion) {
        const [owner, name] = topSuggestion.repositoryFullName.split("/");
        repoOwner = owner;
        repoName = name;
        repoFullName = topSuggestion.repositoryFullName;
        classificationReasoning = `Linear suggested ${repoFullName} (confidence: ${Math.round(topSuggestion.confidence * 100)}%)`;
      }
    }
  }

  // 4. Fall back to our LLM classification
  if (!repoOwner) {
    await emitAgentActivity(
      client,
      agentSessionId,
      {
        type: "thought",
        body: "Classifying repository using AI...",
      },
      true
    );

    const classification = await classifyRepo(
      env,
      issue.title,
      issue.description,
      labelNames,
      projectInfo?.name,
      traceId
    );

    if (classification.needsClarification || !classification.repo) {
      // Use elicitation to ask user to clarify
      const altList = (classification.alternatives || [])
        .map((r) => `- **${r.fullName}**: ${r.description}`)
        .join("\n");

      await emitAgentActivity(client, agentSessionId, {
        type: "elicitation",
        body: `I couldn't determine which repository to work on.\n\n${classification.reasoning}\n\n**Available repositories:**\n${altList || "None available"}\n\nPlease reply with the repository name, or configure a project→repo mapping.`,
      });

      log.warn("agent_session.classification_uncertain", {
        trace_id: traceId,
        issue_identifier: issue.identifier,
        confidence: classification.confidence,
        reasoning: classification.reasoning,
      });
      return;
    }

    repoOwner = classification.repo.owner;
    repoName = classification.repo.name;
    repoFullName = classification.repo.fullName;
    classificationReasoning = classification.reasoning;
  }

  if (!repoOwner || !repoName || !repoFullName) {
    await emitAgentActivity(client, agentSessionId, {
      type: "elicitation",
      body: "I couldn't determine which repository to work on. Please configure a project→repo or team→repo mapping and try again.",
    });
    log.warn("agent_session.repo_resolution_failed", {
      trace_id: traceId,
      issue_identifier: issue.identifier,
    });
    return;
  }

  const integrationConfig = await getLinearConfig(env, repoFullName.toLowerCase());
  if (
    integrationConfig.enabledRepos !== null &&
    !integrationConfig.enabledRepos.includes(repoFullName.toLowerCase())
  ) {
    await emitAgentActivity(client, agentSessionId, {
      type: "error",
      body: `The Linear integration is not enabled for \`${repoFullName}\`.`,
    });
    log.info("agent_session.repo_not_enabled", {
      trace_id: traceId,
      issue_identifier: issue.identifier,
      repo: repoFullName,
    });
    return;
  }

  // ─── Resolve model ────────────────────────────────────────────────────

  let userModel: string | undefined;
  let userReasoningEffort: string | undefined;
  const appUserId = webhook.appUserId as string | undefined;
  if (appUserId) {
    const prefs = await getUserPreferences(env, appUserId);
    if (prefs?.model) {
      userModel = prefs.model;
    }
    userReasoningEffort = prefs?.reasoningEffort;
  }

  const labelModel = extractModelFromLabels(labels);
  const { model, reasoningEffort } = resolveSessionModelSettings({
    envDefaultModel: env.DEFAULT_MODEL,
    configModel: integrationConfig.model,
    configReasoningEffort: integrationConfig.reasoningEffort,
    allowUserPreferenceOverride: integrationConfig.allowUserPreferenceOverride,
    allowLabelModelOverride: integrationConfig.allowLabelModelOverride,
    userModel,
    userReasoningEffort,
    labelModel,
  });

  // ─── Create session ───────────────────────────────────────────────────

  await updateAgentSession(client, agentSessionId, { plan: makePlan("repo_resolved") });
  await emitAgentActivity(
    client,
    agentSessionId,
    {
      type: "thought",
      body: `Creating coding session on ${repoFullName} (model: ${model})...`,
    },
    true
  );

  const headers = await getAuthHeaders(env, traceId);

  const sessionRes = await env.CONTROL_PLANE.fetch("https://internal/sessions", {
    method: "POST",
    headers,
    body: JSON.stringify({
      repoOwner,
      repoName,
      title: `${issue.identifier}: ${issue.title}`,
      model,
      reasoningEffort,
    }),
  });

  if (!sessionRes.ok) {
    let sessionErrBody = "";
    try {
      sessionErrBody = await sessionRes.text();
    } catch {
      /* ignore */
    }
    await emitAgentActivity(client, agentSessionId, {
      type: "error",
      body: `Failed to create a coding session.\n\n\`HTTP ${sessionRes.status}: ${sessionErrBody.slice(0, 200)}\``,
    });
    log.error("control_plane.create_session", {
      trace_id: traceId,
      issue_identifier: issue.identifier,
      repo: repoFullName,
      http_status: sessionRes.status,
      response_body: sessionErrBody.slice(0, 500),
      duration_ms: Date.now() - startTime,
    });
    return;
  }

  const session = (await sessionRes.json()) as { sessionId: string };

  await storeIssueSession(env, issue.id, {
    sessionId: session.sessionId,
    issueId: issue.id,
    issueIdentifier: issue.identifier,
    repoOwner: repoOwner!,
    repoName: repoName!,
    model,
    agentSessionId,
    createdAt: Date.now(),
  });

  // Set externalUrls and update plan
  await updateAgentSession(client, agentSessionId, {
    externalUrls: [
      { label: "View Session", url: `${env.WEB_APP_URL}/session/${session.sessionId}` },
    ],
    plan: makePlan("session_created"),
  });

  // ─── Build and send prompt ────────────────────────────────────────────

  // Prefer Linear's promptContext (includes issue, comments, guidance)
  const prompt = agentSession.promptContext || buildPrompt(issue, issueDetails, comment);
  const callbackContext: CallbackContext = {
    source: "linear",
    issueId: issue.id,
    issueIdentifier: issue.identifier,
    issueUrl: issue.url,
    repoFullName: repoFullName!,
    model,
    agentSessionId,
    organizationId: orgId,
    emitToolProgressActivities: integrationConfig.emitToolProgressActivities,
  };

  const promptRes = await env.CONTROL_PLANE.fetch(
    `https://internal/sessions/${session.sessionId}/prompt`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        content: prompt,
        authorId: `linear:${webhook.appUserId}`,
        source: "linear",
        callbackContext,
      }),
    }
  );

  if (!promptRes.ok) {
    let promptErrBody = "";
    try {
      promptErrBody = await promptRes.text();
    } catch {
      /* ignore */
    }
    await emitAgentActivity(client, agentSessionId, {
      type: "error",
      body: `Failed to send the prompt to the coding session.\n\n\`HTTP ${promptRes.status}: ${promptErrBody.slice(0, 200)}\``,
    });
    log.error("control_plane.send_prompt", {
      trace_id: traceId,
      session_id: session.sessionId,
      issue_identifier: issue.identifier,
      http_status: promptRes.status,
      response_body: promptErrBody.slice(0, 500),
      duration_ms: Date.now() - startTime,
    });
    return;
  }

  await emitAgentActivity(client, agentSessionId, {
    type: "response",
    body: `Working on \`${repoFullName}\` with **${model}**.\n\n${classificationReasoning ? `*${classificationReasoning}*\n\n` : ""}[View session](${env.WEB_APP_URL}/session/${session.sessionId})`,
  });

  log.info("agent_session.session_created", {
    trace_id: traceId,
    session_id: session.sessionId,
    agent_session_id: agentSessionId,
    issue_identifier: issue.identifier,
    repo: repoFullName,
    model,
    classification_reasoning: classificationReasoning,
    duration_ms: Date.now() - startTime,
  });
}

/**
 * Build a prompt from issue data with full context.
 */
function buildPrompt(
  issue: { identifier: string; title: string; description?: string | null; url: string },
  issueDetails: LinearIssueDetails | null,
  comment?: { body: string } | null
): string {
  const parts: string[] = [
    `Linear Issue: ${issue.identifier} — ${issue.title}`,
    `URL: ${issue.url}`,
    "",
  ];

  if (issue.description) {
    parts.push(issue.description);
  } else {
    parts.push("(No description provided)");
  }

  // Add context from full issue details
  if (issueDetails) {
    if (issueDetails.labels.length > 0) {
      parts.push("", `**Labels:** ${issueDetails.labels.map((l) => l.name).join(", ")}`);
    }
    if (issueDetails.project) {
      parts.push(`**Project:** ${issueDetails.project.name}`);
    }
    if (issueDetails.assignee) {
      parts.push(`**Assignee:** ${issueDetails.assignee.name}`);
    }
    if (issueDetails.priorityLabel) {
      parts.push(`**Priority:** ${issueDetails.priorityLabel}`);
    }

    // Include recent comments for context
    if (issueDetails.comments.length > 0) {
      parts.push("", "---", "**Recent comments:**");
      for (const c of issueDetails.comments.slice(-5)) {
        const author = c.user?.name || "Unknown";
        parts.push(`- **${author}:** ${c.body.slice(0, 200)}`);
      }
    }
  }

  if (comment?.body) {
    parts.push("", "---", `**Agent instruction:** ${comment.body}`);
  }

  parts.push(
    "",
    "Please implement the changes described in this issue. Create a pull request when done."
  );

  return parts.join("\n");
}

export default app;
