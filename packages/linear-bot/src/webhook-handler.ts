/**
 * Agent session event handler — orchestrates issue→session lifecycle.
 * Extracted from index.ts for modularity.
 */

import type {
  Env,
  CallbackContext,
  LinearIssueDetails,
  AgentSessionWebhook,
  AgentSessionWebhookIssue,
} from "./types";
import {
  getLinearClient,
  emitAgentActivity,
  fetchIssueDetails,
  updateAgentSession,
  getRepoSuggestions,
} from "./utils/linear-client";
import { generateInternalToken } from "./utils/internal";
import { classifyRepo } from "./classifier";
import { getAvailableRepos } from "./classifier/repos";
import { getLinearConfig } from "./utils/integration-config";
import { createLogger } from "./logger";
import { makePlan } from "./plan";
import {
  resolveStaticRepo,
  extractModelFromLabels,
  resolveSessionModelSettings,
} from "./model-resolution";
import {
  getTeamRepoMapping,
  getProjectRepoMapping,
  getUserPreferences,
  lookupIssueSession,
  storeIssueSession,
} from "./kv-store";

const log = createLogger("handler");

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function getAuthHeaders(env: Env, traceId?: string): Promise<Record<string, string>> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (env.INTERNAL_CALLBACK_SECRET) {
    const authToken = await generateInternalToken(env.INTERNAL_CALLBACK_SECRET);
    headers["Authorization"] = `Bearer ${authToken}`;
  }
  if (traceId) headers["x-trace-id"] = traceId;
  return headers;
}

// ─── Sub-handlers ────────────────────────────────────────────────────────────

async function handleStop(webhook: AgentSessionWebhook, env: Env, traceId: string): Promise<void> {
  const startTime = Date.now();
  const agentSessionId = webhook.agentSession.id;
  const issueId = webhook.agentSession.issue?.id;

  if (issueId) {
    const existingSession = await lookupIssueSession(env, issueId);
    if (existingSession) {
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
      await env.LINEAR_KV.delete(`issue:${issueId}`);
    }
  }

  log.info("agent_session.stop_handled", {
    trace_id: traceId,
    action: webhook.action,
    agent_session_id: agentSessionId,
    duration_ms: Date.now() - startTime,
  });
}

async function handleFollowUp(
  webhook: AgentSessionWebhook,
  issue: AgentSessionWebhookIssue,
  env: Env,
  traceId: string
): Promise<void> {
  const startTime = Date.now();
  const agentSessionId = webhook.agentSession.id;
  const comment = webhook.agentSession.comment;
  const agentActivity = webhook.agentActivity;
  const orgId = webhook.organizationId;

  const client = await getLinearClient(env, orgId);
  if (!client) {
    log.error("agent_session.no_oauth_token", {
      trace_id: traceId,
      org_id: orgId,
      agent_session_id: agentSessionId,
    });
    return;
  }

  const existingSession = await lookupIssueSession(env, issue.id);
  if (!existingSession) return;

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
}

async function handleNewSession(
  webhook: AgentSessionWebhook,
  issue: AgentSessionWebhookIssue,
  env: Env,
  traceId: string
): Promise<void> {
  const startTime = Date.now();
  const agentSessionId = webhook.agentSession.id;
  const comment = webhook.agentSession.comment;
  const orgId = webhook.organizationId;

  const client = await getLinearClient(env, orgId);
  if (!client) {
    log.error("agent_session.no_oauth_token", {
      trace_id: traceId,
      org_id: orgId,
      agent_session_id: agentSessionId,
    });
    return;
  }

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
  const appUserId = webhook.appUserId;
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
  const prompt = webhook.agentSession.promptContext || buildPrompt(issue, issueDetails, comment);
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

// ─── Dispatcher ──────────────────────────────────────────────────────────────

export async function handleAgentSessionEvent(
  webhook: AgentSessionWebhook,
  env: Env,
  traceId: string
): Promise<void> {
  const agentSessionId = webhook.agentSession.id;
  const issue = webhook.agentSession.issue;

  log.info("agent_session.received", {
    trace_id: traceId,
    action: webhook.action,
    agent_session_id: agentSessionId,
    issue_id: issue?.id,
    issue_identifier: issue?.identifier,
    has_comment: Boolean(webhook.agentSession.comment),
    org_id: webhook.organizationId,
  });

  // Stop handling
  if (webhook.action === "stopped" || webhook.action === "cancelled") {
    return handleStop(webhook, env, traceId);
  }

  if (!issue) {
    log.warn("agent_session.no_issue", { trace_id: traceId, agent_session_id: agentSessionId });
    return;
  }

  // Follow-up handling (action: "prompted" with existing session)
  const existingSession = await lookupIssueSession(env, issue.id);
  if (existingSession && webhook.action === "prompted") {
    return handleFollowUp(webhook, issue, env, traceId);
  }

  // New session
  return handleNewSession(webhook, issue, env, traceId);
}

// ─── Prompt Builder ──────────────────────────────────────────────────────────

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
