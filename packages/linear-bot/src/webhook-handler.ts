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
  fetchUser,
  updateAgentSession,
  getRepoSuggestions,
  normalizeLinearCommentBody,
  type LinearApiClient,
} from "./utils/linear-client";
import { buildInternalAuthHeaders } from "./utils/internal";
import { classifyRepo } from "./classifier";
import { getAvailableRepos } from "./classifier/repos";
import { getLinearConfig } from "./utils/integration-config";
import { createLogger } from "./logger";
import { makePlan } from "./plan";
import {
  resolveStaticRepo,
  extractModelFromLabels,
  extractPlanModelFromLabels,
  isPlanModeTriggered,
  resolveSessionModelSettings,
} from "./model-resolution";
import {
  buildUntrustedUserContentBlock,
  fetchModelDefaults,
  parsePlanCommand,
  type PlanCommand,
} from "@open-inspect/shared";
import {
  getTeamRepoMapping,
  getProjectRepoMapping,
  getUserPreferences,
  lookupIssueSession,
  storeIssueSession,
} from "./kv-store";

const log = createLogger("handler");
const AGENT_SESSION_THREAD_PLACEHOLDER =
  "This thread is for an agent session with fountaincodingagent.";

function isAgentSessionThreadPlaceholder(content: string): boolean {
  return content.trim() === AGENT_SESSION_THREAD_PLACEHOLDER;
}

function parseCommentMaxLength(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

export function buildPromptContextPrompt(promptContext: string): string {
  return [
    "Create a pull request when done.",
    "",
    "Linear provided additional issue context below.",
    "",
    buildUntrustedUserContentBlock({
      source: "linear_prompt_context",
      author: "linear",
      content: promptContext,
      origin: "Linear",
    }),
    "",
  ].join("\n");
}

export function buildFollowUpPrompt(params: {
  issueIdentifier: string;
  followUpContent: string;
  followUpSource: string;
  followUpAuthor: string;
  sessionContextSummary?: string;
}): string {
  const {
    issueIdentifier,
    followUpContent,
    followUpSource,
    followUpAuthor,
    sessionContextSummary,
  } = params;

  return [
    `Follow-up on ${issueIdentifier}:`,
    "",
    buildUntrustedUserContentBlock({
      source: followUpSource,
      author: followUpAuthor,
      content: followUpContent,
      origin: "Linear",
    }),
    ...(sessionContextSummary
      ? [
          "",
          "---",
          "**Previous agent response (summary):**",
          buildUntrustedUserContentBlock({
            source: "linear_agent_response_summary",
            author: "agent",
            content: sessionContextSummary,
            origin: "a previous agent response",
          }),
        ]
      : []),
  ].join("\n");
}

async function getAuthHeaders(env: Env, traceId?: string): Promise<Record<string, string>> {
  return {
    "Content-Type": "application/json",
    ...(await buildInternalAuthHeaders(env.INTERNAL_CALLBACK_SECRET, traceId)),
  };
}

/**
 * Create a session via the control plane.
 */
async function createSession(
  env: Env,
  params: {
    repoOwner: string;
    repoName: string;
    title: string;
    model: string;
    reasoningEffort?: string;
    actorUserId?: string;
    actorDisplayName?: string;
    actorEmail?: string;
    planMode?: boolean;
    planModel?: string;
  },
  traceId?: string
): Promise<{ ok: true; sessionId: string } | { ok: false; status: number; body: string }> {
  const headers = await getAuthHeaders(env, traceId);
  const response = await env.CONTROL_PLANE.fetch("https://internal/sessions", {
    method: "POST",
    headers,
    body: JSON.stringify({
      ...params,
      spawnSource: "linear-bot",
    }),
  });

  if (!response.ok) {
    let body = "";
    try {
      body = await response.text();
    } catch {
      /* ignore */
    }
    return { ok: false, status: response.status, body };
  }

  const result = (await response.json()) as { sessionId: string };
  return { ok: true, sessionId: result.sessionId };
}

/**
 * Dispatch a Linear-originated plan approve / reject command to the control
 * plane and surface the outcome in the Linear agent activity stream. Emits
 * exactly one terminal activity (response or error).
 *
 * `appUserId` is used to attribute the approval in the control-plane event
 * log; it is the Linear user clicking the button / sending the comment.
 */
async function handlePlanCommand(
  command: PlanCommand,
  env: Env,
  client: LinearApiClient,
  sessionId: string,
  agentSessionId: string,
  appUserId: string | null,
  traceId?: string
): Promise<void> {
  const headers = await getAuthHeaders(env, traceId);
  const path =
    command.command === "approve"
      ? `https://internal/sessions/${sessionId}/plan/approve`
      : `https://internal/sessions/${sessionId}/plan/reject`;

  const body: Record<string, unknown> = {
    approverAuthorId: appUserId ? `linear:${appUserId}` : "linear:unknown",
  };
  if (command.command === "reject" && command.reason) {
    body.reason = command.reason;
  }

  let res: Response;
  try {
    res = await env.CONTROL_PLANE.fetch(path, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  } catch (e) {
    log.error("plan_command.transport_error", {
      trace_id: traceId,
      session_id: sessionId,
      command: command.command,
      error: e instanceof Error ? e : new Error(String(e)),
    });
    await emitAgentActivity(client, agentSessionId, {
      type: "error",
      body: `Failed to ${command.command} the plan (network error).`,
    });
    return;
  }

  if (!res.ok) {
    let errBody = "";
    try {
      errBody = await res.text();
    } catch {
      /* ignore */
    }
    log.warn("plan_command.failed", {
      trace_id: traceId,
      session_id: sessionId,
      command: command.command,
      http_status: res.status,
      response_body: errBody.slice(0, 300),
    });
    await emitAgentActivity(client, agentSessionId, {
      type: "error",
      body:
        command.command === "approve"
          ? `Approve failed (HTTP ${res.status}). The plan may already be approved, rejected, or the session is no longer in plan mode.`
          : `Reject failed (HTTP ${res.status}).`,
    });
    return;
  }

  await emitAgentActivity(client, agentSessionId, {
    type: "response",
    body:
      command.command === "approve"
        ? "Plan approved. Implementation is starting."
        : `Plan rejected${command.reason ? `: ${command.reason}` : ""}.`,
  });
}

// ─── Sub-handlers ────────────────────────────────────────────────────────────

async function handleStop(webhook: AgentSessionWebhook, env: Env, traceId: string): Promise<void> {
  const startTime = Date.now();
  const agentSessionId = webhook.agentSession.id;
  const issueId = webhook.agentSession.issue?.id;

  if (!issueId) {
    log.warn("agent_session.stop_missing_issue", {
      trace_id: traceId,
      agent_session_id: agentSessionId,
    });
  }

  if (issueId) {
    const existingSession = await lookupIssueSession(env, issueId);
    if (existingSession) {
      const headers = await getAuthHeaders(env, traceId);

      // If the user clicked Dismiss while a plan was awaiting approval,
      // mark the plan rejected before stopping so the lifecycle is auditable.
      // Best-effort: any failure here does not block the stop call.
      try {
        const planRes = await env.CONTROL_PLANE.fetch(
          `https://internal/sessions/${existingSession.sessionId}/plan`,
          { method: "GET", headers }
        );
        if (planRes.ok) {
          const planBody = (await planRes.json()) as { plan?: { id: string } | null };
          if (planBody.plan) {
            const rejectRes = await env.CONTROL_PLANE.fetch(
              `https://internal/sessions/${existingSession.sessionId}/plan/reject`,
              {
                method: "POST",
                headers,
                body: JSON.stringify({
                  reason: "Dismissed from Linear",
                  approverAuthorId: webhook.appUserId ? `linear:${webhook.appUserId}` : null,
                }),
              }
            );
            log.info("agent_session.plan_auto_reject", {
              trace_id: traceId,
              session_id: existingSession.sessionId,
              issue_id: issueId,
              status: rejectRes.status,
              // 409 = plan was not in awaiting_approval state; this is expected
              // for sessions whose plan was already approved or already rejected.
              skipped: rejectRes.status === 409,
            });
          }
        }
      } catch (e) {
        log.warn("agent_session.plan_auto_reject_failed", {
          trace_id: traceId,
          session_id: existingSession.sessionId,
          error: e instanceof Error ? e : new Error(String(e)),
        });
      }

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
    } else {
      log.info("agent_session.stop_without_existing_session", {
        trace_id: traceId,
        issue_id: issueId,
        agent_session_id: agentSessionId,
      });
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

  log.info("agent_session.followup_received", {
    trace_id: traceId,
    issue_id: issue.id,
    issue_identifier: issue.identifier,
    agent_session_id: agentSessionId,
    has_agent_activity: Boolean(agentActivity?.content?.body),
    has_comment: Boolean(comment),
  });

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
  if (!existingSession) {
    log.warn("agent_session.followup_missing_existing_session", {
      trace_id: traceId,
      issue_id: issue.id,
      issue_identifier: issue.identifier,
      agent_session_id: agentSessionId,
    });
    return;
  }

  const normalizedCommentBody = comment ? normalizeLinearCommentBody(comment) : "";
  const followUpContent =
    agentActivity?.content?.body || normalizedCommentBody || "Follow-up on the issue.";

  // Plan-approval shortcut: if the user replied with `approve` or
  // `reject [reason]`, route to the control-plane plan endpoint instead of
  // forwarding as a regular prompt. Impl model is decided by the
  // `model-<alias>` (or `build-<alias>`) label on the ticket —
  // no inline override.
  const planCommand = parsePlanCommand(followUpContent);
  if (planCommand) {
    await handlePlanCommand(
      planCommand,
      env,
      client,
      existingSession.sessionId,
      agentSessionId,
      webhook.appUserId ?? null,
      traceId
    );
    log.info("agent_session.followup", {
      trace_id: traceId,
      issue_identifier: issue.identifier,
      session_id: existingSession.sessionId,
      agent_session_id: agentSessionId,
      route: "plan_command",
      command: planCommand.command,
      duration_ms: Date.now() - startTime,
    });
    return;
  }
  const followUpMetadata = agentActivity?.content?.body
    ? { followUpSource: "linear_agent_activity", followUpAuthor: "linear" }
    : { followUpSource: "linear_comment", followUpAuthor: "unknown" };

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
  let sessionContextSummary = "";
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
          sessionContextSummary = lastContent.slice(0, 5000);
        }
      }
    } else {
      log.warn("control_plane.fetch_events_failed", {
        trace_id: traceId,
        session_id: existingSession.sessionId,
        issue_identifier: issue.identifier,
        http_status: eventsRes.status,
      });
    }
  } catch (error) {
    log.warn("control_plane.fetch_events_failed", {
      trace_id: traceId,
      session_id: existingSession.sessionId,
      issue_identifier: issue.identifier,
      error: error instanceof Error ? error : new Error(String(error)),
    });
  }

  if (!webhook.appUserId) {
    log.warn("agent_session.missing_app_user_id", {
      trace_id: traceId,
      issue_identifier: issue.identifier,
      agent_session_id: agentSessionId,
      mode: "follow_up",
    });
  }

  const promptRes = await env.CONTROL_PLANE.fetch(
    `https://internal/sessions/${existingSession.sessionId}/prompt`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        content: buildFollowUpPrompt({
          issueIdentifier: issue.identifier,
          followUpContent,
          followUpSource: followUpMetadata.followUpSource,
          followUpAuthor: followUpMetadata.followUpAuthor,
          sessionContextSummary,
        }),
        authorId: `linear:${webhook.appUserId}`,
        source: "linear",
      }),
    }
  );

  if (promptRes.ok) {
    await emitAgentActivity(client, agentSessionId, {
      type: "thought",
      body: `Follow-up sent to existing session.\n\n[View session](${env.WEB_APP_URL}/session/${existingSession.sessionId})`,
    });
  } else {
    let promptErrBody = "";
    try {
      promptErrBody = await promptRes.text();
    } catch {
      /* ignore */
    }
    await emitAgentActivity(client, agentSessionId, {
      type: "error",
      body: "Failed to send follow-up to the existing session.",
    });
    log.error("control_plane.send_followup_prompt", {
      trace_id: traceId,
      session_id: existingSession.sessionId,
      issue_identifier: issue.identifier,
      http_status: promptRes.status,
      response_body: promptErrBody.slice(0, 500),
      duration_ms: Date.now() - startTime,
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
  if (!issueDetails) {
    log.warn("linear.issue_details_missing", {
      trace_id: traceId,
      issue_id: issue.id,
      issue_identifier: issue.identifier,
      agent_session_id: agentSessionId,
    });
  }
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

      let suggestions: Array<{ repositoryFullName: string; confidence: number }> = [];
      try {
        suggestions = await getRepoSuggestions(client, issue.id, agentSessionId, candidates);
      } catch (error) {
        log.warn("agent_session.repo_suggestions_failed", {
          trace_id: traceId,
          issue_identifier: issue.identifier,
          agent_session_id: agentSessionId,
          error: error instanceof Error ? error : new Error(String(error)),
        });
      }
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
      issue.team?.name ?? null,
      issue.team?.key ?? null,
      comment?.body,
      traceId
    );

    if (classification.needsClarification || !classification.repo) {
      const altList = (classification.alternatives || [])
        .map((r) => `- **${r.fullName}**: ${r.description}`)
        .join("\n");

      await emitAgentActivity(client, agentSessionId, {
        type: "elicitation",
        body: `I couldn't determine which repository to work on.\n\n${classification.reasoning}\n\n**Available repositories:**\n${altList || "None available"}\n\nPlease reply with the repository name (e.g., \`owner/repo\`).`,
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
      body: "I couldn't determine which repository to work on. Please reply with the repository name (e.g., `owner/repo`).",
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

  // ─── Resolve user preferences and identity ────────────────────────────

  let userModel: string | undefined;
  let userReasoningEffort: string | undefined;
  let actorDisplayName: string | undefined;
  let actorEmail: string | undefined;
  const appUserId = webhook.appUserId;
  if (!appUserId) {
    log.warn("agent_session.missing_app_user_id", {
      trace_id: traceId,
      issue_identifier: issue.identifier,
      agent_session_id: agentSessionId,
      mode: "new_session",
    });
  }
  if (appUserId) {
    const prefs = await getUserPreferences(env, appUserId);
    if (prefs?.model) {
      userModel = prefs.model;
    }
    userReasoningEffort = prefs?.reasoningEffort;

    const linearUser = await fetchUser(client, appUserId);
    actorDisplayName = linearUser?.name;
    actorEmail = linearUser?.email ?? undefined;
  }

  const labelModel = extractModelFromLabels(labels);
  const modelDefaults = await fetchModelDefaults(env);
  const { model, reasoningEffort } = resolveSessionModelSettings({
    envDefaultModel: modelDefaults.defaultModel,
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

  // Plan-mode trigger: a label named `plan` (case-insensitive) on the Linear
  // issue opts this session into the HITL plan-first workflow. The agent
  // proposes a markdown plan that the user must approve before any
  // implementation step runs.
  //
  // Label conventions on Linear (which forbids `:` in label names, so we use
  // flat dash-separated labels — see isPlanModeTriggered / extractByPrefix
  // in model-resolution.ts):
  //   • `plan` or `plan-<alias>`     → trigger plan-mode; alias sets plan model
  //                                    (`plan` or `plan-default` = env default).
  //   • `model-<alias>`              → build model override.
  //   • `build-<alias>`              → build model override (alias of `model-<alias>`).
  //                                    Useful in plan-mode where it reads more naturally.
  //   • `review-<alias>`             → review model override (GitHub-only feature).
  const planMode = isPlanModeTriggered(labels);
  const planModel = planMode
    ? (extractPlanModelFromLabels(labels) ?? modelDefaults.defaultPlanModel)
    : undefined;

  const sessionResult = await createSession(
    env,
    {
      repoOwner: repoOwner!,
      repoName: repoName!,
      title: `${issue.identifier}: ${issue.title}`,
      model,
      reasoningEffort,
      actorUserId: appUserId,
      actorDisplayName,
      actorEmail,
      planMode,
      planModel,
    },
    traceId
  );

  if (!sessionResult.ok) {
    await emitAgentActivity(client, agentSessionId, {
      type: "error",
      body: `Failed to create a coding session.\n\n\`HTTP ${sessionResult.status}: ${sessionResult.body.slice(0, 200)}\``,
    });
    log.error("control_plane.create_session", {
      trace_id: traceId,
      issue_identifier: issue.identifier,
      repo: repoFullName,
      http_status: sessionResult.status,
      response_body: sessionResult.body.slice(0, 500),
      duration_ms: Date.now() - startTime,
    });
    return;
  }

  const headers = await getAuthHeaders(env, traceId);
  const session = sessionResult;

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
  const commentMaxLength = parseCommentMaxLength(env.LINEAR_COMMENT_MAX_LENGTH);

  let prompt = webhook.agentSession.promptContext
    ? buildPromptContextPrompt(webhook.agentSession.promptContext)
    : buildPrompt(issue, issueDetails, comment, commentMaxLength);

  if (integrationConfig.issueSessionInstructions) {
    prompt += `\n\n## Additional Instructions\n\n${integrationConfig.issueSessionInstructions}`;
  }
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
    type: "thought",
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
  const startTime = Date.now();
  const agentSessionId = webhook.agentSession.id;
  const issue = webhook.agentSession.issue;

  try {
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
      log.info("agent_session.route", {
        trace_id: traceId,
        route: "stop",
        action: webhook.action,
        agent_session_id: agentSessionId,
      });
      return handleStop(webhook, env, traceId);
    }

    if (!issue) {
      log.warn("agent_session.no_issue", { trace_id: traceId, agent_session_id: agentSessionId });
      return;
    }

    // Follow-up handling (action: "prompted" with existing session)
    const existingSession = await lookupIssueSession(env, issue.id);
    if (existingSession && webhook.action === "prompted") {
      log.info("agent_session.route", {
        trace_id: traceId,
        route: "follow_up",
        action: webhook.action,
        issue_id: issue.id,
        issue_identifier: issue.identifier,
        session_id: existingSession.sessionId,
        agent_session_id: agentSessionId,
      });
      return handleFollowUp(webhook, issue, env, traceId);
    }

    log.info("agent_session.route", {
      trace_id: traceId,
      route: "new_session",
      action: webhook.action,
      issue_id: issue.id,
      issue_identifier: issue.identifier,
      has_existing_session: Boolean(existingSession),
      agent_session_id: agentSessionId,
    });
    return handleNewSession(webhook, issue, env, traceId);
  } catch (error) {
    log.error("agent_session.unhandled_error", {
      trace_id: traceId,
      action: webhook.action,
      issue_id: issue?.id,
      issue_identifier: issue?.identifier,
      agent_session_id: agentSessionId,
      duration_ms: Date.now() - startTime,
      error: error instanceof Error ? error : new Error(String(error)),
    });
    throw error;
  }
}

// ─── Prompt Builder ──────────────────────────────────────────────────────────

export function buildPrompt(
  issue: { identifier: string; title: string; description?: string | null; url: string },
  issueDetails: LinearIssueDetails | null,
  comment?: { body?: unknown; bodyData?: unknown } | null,
  commentMaxLength?: number
): string {
  const effectiveCommentMaxLength =
    typeof commentMaxLength === "number" &&
    Number.isFinite(commentMaxLength) &&
    commentMaxLength > 0
      ? Math.floor(commentMaxLength)
      : undefined;
  const normalizedCommentBody = comment ? normalizeLinearCommentBody(comment) : "";
  const parts: string[] = [
    `Linear Issue: ${issue.identifier}`,
    `URL: ${issue.url}`,
    "",
    "## Issue Title",
    buildUntrustedUserContentBlock({
      source: "linear_issue_title",
      author: "unknown",
      content: issue.title,
      origin: "Linear",
    }),
    "",
    "## Description",
  ];

  if (issue.description) {
    parts.push(
      buildUntrustedUserContentBlock({
        source: "linear_issue_description",
        author: "unknown",
        content: issue.description,
        origin: "Linear",
      })
    );
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
    const filteredComments = issueDetails.comments
      .slice(-5)
      .filter((c) => !isAgentSessionThreadPlaceholder(c.body))
      .map((c) => ({
        ...c,
        promptBody:
          effectiveCommentMaxLength !== undefined
            ? c.body.slice(0, effectiveCommentMaxLength)
            : c.body,
      }))
      .filter((c) => c.promptBody.trim().length > 0);
    if (filteredComments.length > 0) {
      parts.push("", "---", "**Recent comments:**");
      for (const c of filteredComments) {
        const author = c.user?.name || "Unknown";
        parts.push(
          buildUntrustedUserContentBlock({
            source: "linear_issue_comment",
            author,
            content: c.promptBody,
            origin: "Linear",
          })
        );
      }
    }
  }

  if (normalizedCommentBody && !isAgentSessionThreadPlaceholder(normalizedCommentBody)) {
    parts.push(
      "",
      "---",
      "**Agent instruction:**",
      buildUntrustedUserContentBlock({
        source: "linear_agent_instruction",
        author: "unknown",
        content: normalizedCommentBody,
        origin: "Linear",
      })
    );
  }

  return parts.join("\n");
}
