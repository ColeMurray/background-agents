/**
 * Agent session event handler — orchestrates issue→session lifecycle.
 * Extracted from index.ts for modularity.
 */

import type { LinearCallbackContext } from "@open-inspect/shared/types/session-api";
import { MAX_WEB_PROMPT_CHARS } from "@open-inspect/shared/types/prompts";
import { z } from "zod";
import type { Env, AgentSessionWebhook, AgentSessionWebhookIssue } from "./types";
import {
  getLinearClientOrThrow,
  LinearAuthError,
  emitAgentActivity,
  fetchIssueDetails,
  fetchUser,
  updateAgentSession,
} from "./utils/linear-client";
import type { LinearApiClient } from "./utils/linear-client";
import { signedControlPlaneFetch } from "./internal-auth";
import { createLogger } from "./logger";
import { makePlan } from "./plan";
import { extractModelFromLabels, resolveSessionModelSettings } from "./model-resolution";
import {
  resolveSessionTarget,
  resolveStoredSessionTarget,
  resolveTargetIntegration,
  targetId,
  targetLabel,
  targetRequestFields,
  type TargetIntegration,
} from "./target-resolution";
import { getUserPreferences, lookupIssueSession, storeIssueSession } from "./kv-store";
import {
  createSession,
  describeSessionCreateFailure,
  resolveLinearTeamBinding,
} from "./launch-admission";
import { buildFollowUpPrompt, buildPrompt, buildPromptContextPrompt } from "./prompts";

const log = createLogger("handler");

const sessionEventsSummaryResponseSchema = z.object({
  events: z.array(
    z.object({
      type: z.literal("token"),
      data: z.object({
        content: z.string(),
      }),
    })
  ),
});

// ─── Sub-handlers ────────────────────────────────────────────────────────────

async function getAgentSessionLinearClient(params: {
  env: Env;
  traceId: string;
  orgId: string;
  agentSessionId: string;
  issue: AgentSessionWebhookIssue;
  mode: "start" | "follow_up";
  expectedAppUserId: string;
}): Promise<LinearApiClient | null> {
  const { env, traceId, orgId, agentSessionId, issue, mode, expectedAppUserId } = params;

  try {
    return await getLinearClientOrThrow(env, orgId, expectedAppUserId);
  } catch (err) {
    if (!(err instanceof LinearAuthError)) throw err;

    log.error("agent_session.no_oauth_token", {
      trace_id: traceId,
      org_id: orgId,
      agent_session_id: agentSessionId,
      issue_id: issue.id,
      issue_identifier: issue.identifier,
      mode,
      auth_failure_reason: err.reason,
    });
    return null;
  }
}

async function handleStop(webhook: AgentSessionWebhook, env: Env, traceId: string): Promise<void> {
  const startTime = Date.now();
  const agentSessionId = webhook.agentSession.id;
  const issueId = webhook.agentSession.issue?.id;

  if (issueId) {
    const existingSession = await lookupIssueSession(env, issueId);
    if (existingSession) {
      const stopUrl = new URL(`https://internal/sessions/${existingSession.sessionId}/stop`);
      const actorUserId =
        webhook.agentActivity?.userId ?? webhook.agentSession.comment?.userId ?? undefined;
      if (!actorUserId) {
        log.warn("Linear stop rejected because its author is missing", {
          event: "agent_session.stop_author_missing",
          agent_session_id: agentSessionId,
          issue_id: issueId,
          trace_id: traceId,
        });
        return;
      }
      // Older mappings lack a team coordinate; the actor's own authorization still governs them.
      const linearTeamId = webhook.agentSession.issue?.team?.id || existingSession.linearTeamId;
      if (linearTeamId) stopUrl.searchParams.set("channel", `linear:${linearTeamId}`);
      try {
        const stopRes = await signedControlPlaneFetch(env, {
          method: "POST",
          url: stopUrl.toString(),
          actor: `linear:${actorUserId}`,
          traceId,
        });
        if (!stopRes.ok) {
          log.error("agent_session.stop_failed", {
            trace_id: traceId,
            session_id: existingSession.sessionId,
            stop_status: stopRes.status,
          });
          return;
        }
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
        return;
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

/**
 * The comments and actor driving a new session. A "prompted" event that
 * reaches new-session handling is a reply to an elicitation — no
 * issue→session mapping existed, so no session was ever created. The reply
 * text lives on the agent activity and drives target resolution, while the
 * session comment remains the original instruction. Its author is the replier
 * — not necessarily the user whose comment created the elicitation.
 */
function getNewSessionInput(webhook: AgentSessionWebhook): {
  resolutionComment: { body: string } | undefined;
  instructionComment: { body: string } | undefined;
  clarificationReply: { body: string } | undefined;
  actorUserId: string | undefined;
} {
  const instructionComment = webhook.agentSession.comment ?? undefined;
  const sessionActor = instructionComment?.userId ?? webhook.agentSession.creatorId ?? undefined;
  const replyBody =
    webhook.action === "prompted" ? webhook.agentActivity?.content?.body?.trim() : undefined;
  if (replyBody) {
    const clarificationReply = { body: replyBody };
    return {
      resolutionComment: clarificationReply,
      instructionComment,
      clarificationReply,
      actorUserId: webhook.agentActivity?.userId ?? sessionActor,
    };
  }
  return {
    resolutionComment: instructionComment,
    instructionComment,
    clarificationReply: undefined,
    actorUserId: sessionActor,
  };
}

function shouldTransitionIssueOnStart(webhook: AgentSessionWebhook): boolean {
  return webhook.action === "created" && Boolean(webhook.agentSession.creatorId?.trim());
}

function getFollowUp(webhook: AgentSessionWebhook): {
  content: string;
  source: "linear_agent_activity" | "linear_comment" | "linear_fallback";
  actorUserId?: string;
} {
  const activityBody = webhook.agentActivity?.content?.body;
  if (activityBody) {
    return {
      content: activityBody,
      source: "linear_agent_activity",
      actorUserId: webhook.agentActivity?.userId ?? undefined,
    };
  }

  const comment = webhook.agentSession.comment;
  if (comment?.body) {
    return {
      content: comment.body,
      source: "linear_comment",
      actorUserId: comment.userId ?? undefined,
    };
  }

  return {
    content: "Follow-up on the issue.",
    source: "linear_fallback",
    actorUserId: undefined,
  };
}

function buildLinearCallbackContext(params: {
  webhook: AgentSessionWebhook;
  issue: AgentSessionWebhookIssue;
  model: string;
  repoFullName?: string;
  emitToolProgressActivities?: boolean;
  transitionIssueOnStart?: boolean;
}): LinearCallbackContext {
  const {
    webhook,
    issue,
    model,
    repoFullName,
    emitToolProgressActivities,
    transitionIssueOnStart,
  } = params;
  const context = {
    source: "linear" as const,
    issueId: issue.id,
    issueIdentifier: issue.identifier,
    issueUrl: issue.url,
    linearTeamId: issue.team.id,
    repoFullName,
    model,
    agentSessionId: webhook.agentSession.id,
    organizationId: webhook.organizationId,
    appUserId: webhook.appUserId,
    emitToolProgressActivities,
  };
  if (transitionIssueOnStart === true) {
    return { ...context, transitionIssueOnStart: true };
  }
  return {
    ...context,
    ...(transitionIssueOnStart === false ? { transitionIssueOnStart: false as const } : {}),
  };
}

async function handleFollowUp(
  webhook: AgentSessionWebhook,
  issue: AgentSessionWebhookIssue,
  env: Env,
  traceId: string
): Promise<void> {
  const startTime = Date.now();
  const agentSessionId = webhook.agentSession.id;
  const orgId = webhook.organizationId;
  const followUp = getFollowUp(webhook);

  const client = await getAgentSessionLinearClient({
    env,
    traceId,
    orgId,
    agentSessionId,
    issue,
    mode: "follow_up",
    expectedAppUserId: webhook.appUserId,
  });
  if (!client) return;

  if (!followUp.actorUserId) {
    log.warn("Linear follow-up rejected because its author is missing", {
      event: "agent_session.follow_up_author_missing",
      agent_session_id: agentSessionId,
      issue_id: issue.id,
      organization_id: orgId,
      trace_id: traceId,
    });
    await emitAgentActivity(
      client,
      agentSessionId,
      {
        type: "error",
        body: "Cannot process this follow-up because Linear did not identify its author.",
      },
      true
    );
    return;
  }

  const existingSession = await lookupIssueSession(env, issue.id);
  if (!existingSession) return;
  const scope = { linearTeamId: issue.team.id };
  let currentIntegration: TargetIntegration | null;
  try {
    const existingTarget = await resolveStoredSessionTarget(env, existingSession, traceId, scope);
    currentIntegration = existingTarget
      ? await resolveTargetIntegration(env, existingTarget, scope)
      : null;
  } catch {
    await emitAgentActivity(client, agentSessionId, {
      type: "error",
      body: "Cannot resolve the existing session's target or Linear settings. Verify the acting user's team membership and retry.",
    });
    return;
  }
  const callbackContext = buildLinearCallbackContext({
    webhook,
    issue,
    model: existingSession.model,
    repoFullName: currentIntegration?.callbackRepoFullName,
    emitToolProgressActivities: currentIntegration?.config.emitToolProgressActivities,
  });

  await emitAgentActivity(
    client,
    agentSessionId,
    {
      type: "thought",
      body: "Processing follow-up message...",
    },
    true
  );

  let sessionContextSummary = "";
  try {
    const eventsUrl = new URL(
      `https://internal/sessions/${existingSession.sessionId}/events?type=token&limit=20`
    );
    eventsUrl.searchParams.set("channel", `linear:${issue.team.id}`);
    const eventsRes = await signedControlPlaneFetch(env, {
      method: "GET",
      url: eventsUrl.toString(),
      actor: `linear:${followUp.actorUserId}`,
      traceId,
    });
    if (eventsRes.ok) {
      const eventsData = sessionEventsSummaryResponseSchema.safeParse(await eventsRes.json());
      const latestContent = eventsData.success
        ? eventsData.data.events[0]?.data.content
        : undefined;
      if (latestContent) {
        sessionContextSummary = latestContent.slice(0, 500);
      }
    }
  } catch {
    /* best effort */
  }

  const promptUrl = `https://internal/sessions/${existingSession.sessionId}/prompt`;
  const promptBody = JSON.stringify({
    content: buildFollowUpPrompt({
      issueIdentifier: issue.identifier,
      followUpContent: followUp.content,
      followUpSource: followUp.source,
      followUpAuthor: "linear",
      sessionContextSummary,
    }),
    source: "linear",
    callbackContext,
  });
  const promptRes = await signedControlPlaneFetch(env, {
    method: "POST",
    url: promptUrl,
    body: promptBody,
    actor: `linear:${followUp.actorUserId}`,
    traceId,
  });

  if (promptRes.ok) {
    await emitAgentActivity(client, agentSessionId, {
      type: "thought",
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
  const {
    resolutionComment,
    instructionComment,
    clarificationReply,
    actorUserId: sessionActorUserId,
  } = getNewSessionInput(webhook);
  const launchActorUserId =
    sessionActorUserId ?? (webhook.action === "created" ? webhook.appUserId : undefined);
  const orgId = webhook.organizationId;

  const client = await getAgentSessionLinearClient({
    env,
    traceId,
    orgId,
    agentSessionId,
    issue,
    mode: "start",
    expectedAppUserId: webhook.appUserId,
  });
  if (!client) return;

  if (!launchActorUserId) {
    await emitAgentActivity(client, agentSessionId, {
      type: "error",
      body: "Cannot start a coding session because Linear did not identify its author.",
    });
    return;
  }
  const scope = { linearTeamId: issue.team.id };
  const binding = await resolveLinearTeamBinding(env, issue.team.id, traceId);
  if (binding.kind === "refused") {
    await emitAgentActivity(client, agentSessionId, { type: "error", body: binding.message });
    return;
  }
  const { teamId } = binding;

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

  // ─── Resolve target ───────────────────────────────────────────────────

  const resolved = await resolveSessionTarget({
    env,
    client,
    agentSessionId,
    issue,
    labelNames,
    projectInfo,
    comment: resolutionComment,
    traceId,
    scope,
    teamId,
  }).catch(async () => {
    await emitAgentActivity(client, agentSessionId, {
      type: "error",
      body: "Cannot resolve a target for this Linear team. Verify the acting user's team membership and the team's repository grants, then retry.",
    });
    return null;
  });
  if (!resolved) return;

  const { target, reasoning: classificationReasoning } = resolved;
  const label = targetLabel(target);

  const integration = await resolveTargetIntegration(env, target, scope).catch(async () => {
    await emitAgentActivity(client, agentSessionId, {
      type: "error",
      body: "Cannot read the Linear integration settings for this target. No coding session was created; please retry.",
    });
    return null;
  });
  if (!integration) return;
  const integrationConfig = integration.config;
  if (!integration.enabled) {
    await emitAgentActivity(client, agentSessionId, {
      type: "error",
      body: `The Linear integration is not enabled for ${integration.notEnabledSubject}.`,
    });
    log.info("agent_session.repo_not_enabled", {
      trace_id: traceId,
      issue_identifier: issue.identifier,
      target: targetId(target),
      repo: integration.settingsRepo,
    });
    return;
  }

  // Prefer Linear's promptContext (includes issue, comments, guidance)
  let prompt = webhook.promptContext
    ? buildPromptContextPrompt(webhook.promptContext)
    : buildPrompt(issue, issueDetails, instructionComment, clarificationReply);

  if (integrationConfig.issueSessionInstructions) {
    prompt += `\n\n## Additional Instructions\n\n${integrationConfig.issueSessionInstructions}`;
  }

  if (prompt.length > MAX_WEB_PROMPT_CHARS) {
    await emitAgentActivity(client, agentSessionId, {
      type: "error",
      body: `The prompt for this issue is ${prompt.length.toLocaleString("en-US")} characters, exceeding the ${MAX_WEB_PROMPT_CHARS.toLocaleString("en-US")}-character limit. Linear may include the parent issue's description; shorten this issue, its parent, or the configured instructions, then delegate again.`,
    });
    log.warn("agent_session.prompt_too_long", {
      trace_id: traceId,
      issue_identifier: issue.identifier,
      prompt_length: prompt.length,
      prompt_limit: MAX_WEB_PROMPT_CHARS,
    });
    return;
  }

  // ─── Resolve user preferences and identity ────────────────────────────

  let userModel: string | undefined;
  let userReasoningEffort: string | undefined;
  let actorDisplayName: string | undefined;
  let actorEmail: string | undefined;
  if (sessionActorUserId) {
    const prefs = await getUserPreferences(env, sessionActorUserId);
    if (prefs?.model) {
      userModel = prefs.model;
    }
    userReasoningEffort = prefs?.reasoningEffort;

    const linearUser = await fetchUser(client, sessionActorUserId);
    actorDisplayName = linearUser?.name;
    actorEmail = linearUser?.email ?? undefined;
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
      body: `Creating coding session on ${label} (model: ${model})...`,
    },
    true
  );

  const sessionResult = await createSession(
    env,
    target,
    {
      title: `${issue.identifier}: ${issue.title}`,
      model,
      reasoningEffort,
      actorUserId: launchActorUserId,
      actorDisplayName,
      actorEmail,
      teamId,
    },
    traceId
  );

  if (!sessionResult.ok) {
    await emitAgentActivity(client, agentSessionId, {
      type: "error",
      body: describeSessionCreateFailure(sessionResult, label),
    });
    log.error("control_plane.create_session", {
      trace_id: traceId,
      issue_identifier: issue.identifier,
      target: targetId(target),
      http_status: sessionResult.status,
      response_body: sessionResult.body.slice(0, 500),
      duration_ms: Date.now() - startTime,
    });
    return;
  }

  const session = sessionResult;
  const callbackContext = buildLinearCallbackContext({
    webhook,
    issue,
    model,
    repoFullName: integration.callbackRepoFullName,
    emitToolProgressActivities: integrationConfig.emitToolProgressActivities,
    transitionIssueOnStart: shouldTransitionIssueOnStart(webhook),
  });

  await storeIssueSession(env, issue.id, {
    sessionId: session.sessionId,
    issueId: issue.id,
    issueIdentifier: issue.identifier,
    linearTeamId: issue.team.id,
    ...targetRequestFields(target),
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

  // ─── Send prompt ──────────────────────────────────────────────────────

  const promptUrl = `https://internal/sessions/${session.sessionId}/prompt`;
  const promptBody = JSON.stringify({
    content: prompt,
    source: "linear",
    callbackContext,
  });
  const promptRes = await signedControlPlaneFetch(env, {
    method: "POST",
    url: promptUrl,
    body: promptBody,
    actor: `linear:${launchActorUserId}`,
    traceId,
  });

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
      prompt_length: prompt.length,
      http_status: promptRes.status,
      response_body: promptErrBody.slice(0, 500),
      duration_ms: Date.now() - startTime,
    });
    return;
  }

  await emitAgentActivity(client, agentSessionId, {
    type: "thought",
    body: `Working on \`${label}\` with **${model}**.\n\n${classificationReasoning ? `*${classificationReasoning}*\n\n` : ""}[View session](${env.WEB_APP_URL}/session/${session.sessionId})`,
  });

  log.info("agent_session.session_created", {
    trace_id: traceId,
    session_id: session.sessionId,
    agent_session_id: agentSessionId,
    issue_identifier: issue.identifier,
    target: targetId(target),
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
  if (
    webhook.agentActivity?.signal === "stop" ||
    webhook.action === "stopped" ||
    webhook.action === "cancelled"
  ) {
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
