import type { SlackAutomationEvent } from "@open-inspect/shared/triggers";
import type { SlackCallbackContext } from "@open-inspect/shared/types/session-api";
import { SlackChannelStore } from "../db/slack-channel-store";
import { IntegrationSettingsStore } from "../db/integration-settings";
import { UserStore } from "../db/user-store";
import type { AutomationRow, AutomationRunRow } from "../db/automation-store";
import type { SqlDatabase } from "../db/sql-database";
import type { GitHubEnrichment } from "../session/identity";
import { resolveScmProviderFromEnv } from "../source-control/config";
import {
  formatRunRepositoryLabel,
  buildSlackCompletionNotification,
  parseSlackTriggerMetadata,
  type SlackRunMetadata,
} from "./slack-completion";
import { SessionIndexStore } from "../db/session-index";
import { TeamChannelBindingStore } from "../db/team-channel-bindings";
import { slackPostGate } from "../authorization/slack-post-gate";
import { computeHmacHex } from "@open-inspect/shared/auth";
import { callbackSigningSecret } from "../auth/service/callback-signing";
import { retryDelivery } from "../session/callback-delivery";
import type { AutomationRunCompletion } from "./scheduler";
import { composeAutomationPrompt } from "./event-prompt";
import { evaluateEventConditions, type EventSourcePolicy } from "./event-policy";
import {
  continueSession,
  steeringActor,
  type SessionContinuityDeps,
  type SteeringActor,
  type ContinuationPolicy,
} from "./session-continuity";

export interface SlackEventPolicyDeps {
  continuity: SessionContinuityDeps;
  buildContext(event: SlackAutomationEvent): Promise<string>;
  resolveScmEnrichment(userId: string): Promise<GitHubEnrichment | null>;
  notifyConcurrencySkip(event: SlackAutomationEvent): Promise<void>;
}

export function createSlackEventPolicy(
  event: SlackAutomationEvent,
  deps: SlackEventPolicyDeps
): EventSourcePolicy {
  const { continuity } = deps;
  let context: Promise<string> | undefined;
  let actor: Promise<SteeringActor | null> | undefined;
  let sessionInstructions: Promise<string | undefined> | undefined;
  let concurrencySkipped = false;
  const resolveActor = (): Promise<SteeringActor | null> =>
    (actor ??= (async () => {
      const identity = await new UserStore(continuity.db).getIdentity("slack", event.actorUserId);
      return identity
        ? steeringActor(
            continuity.db,
            continuity.backgroundJobs,
            { userId: identity.userId, authorId: `slack:${event.actorUserId}` },
            `automation:slack-steering:${event.triggerKey}`,
            event.triggerKey
          )
        : null;
    })());

  return {
    candidates: () =>
      new SlackChannelStore(continuity.db).getSlackAutomationsForChannel(event.channelId),
    async dispatch(automation, now, fire) {
      // Natural thread replies continue the session even without the original trigger keyword.
      const continuation = await continueSession(
        continuity,
        automation,
        event.concurrencyKey,
        now,
        slackContinuation(event, automation, resolveActor, deps)
      );
      if (continuation.kind === "steered" || continuation.kind === "skipped") return continuation;
      const conditions = evaluateEventConditions(automation, event, continuity.log);
      if (conditions !== "matched")
        return conditions === "invalid" ? { kind: "skipped", invocationId: null } : null;
      sessionInstructions ??= getSlackSessionInstructions(continuity.db);
      const instructions = appendSlackSessionInstructions(
        automation.instructions,
        await sessionInstructions
      );
      const result = await fire({
        triggerMetadata: serializeSlackTriggerMetadata(event),
        instructionsOverride: composeAutomationPrompt(event.contextBlock, instructions),
        instructionsOverrideFactory: async () => {
          context ??= deps.buildContext(event);
          return composeAutomationPrompt(await context, instructions);
        },
      });
      if (result.outcome === "skipped") concurrencySkipped = true;
      return result;
    },
    async finish() {
      // A channel can match several automations; publish at most one notice per event.
      if (concurrencySkipped) await deps.notifyConcurrencySkip(event);
    },
  };
}

async function getSlackSessionInstructions(db: SqlDatabase): Promise<string | undefined> {
  try {
    const instructions = (await new IntegrationSettingsStore(db).getGlobal("slack"))?.defaults
      ?.sessionInstructions;
    return typeof instructions === "string" && instructions.trim() ? instructions : undefined;
  } catch {
    return undefined;
  }
}

function appendSlackSessionInstructions(prompt: string, instructions: string | undefined): string {
  return instructions ? `${prompt}\n\n## Additional Instructions\n\n${instructions}` : prompt;
}

/**
 * Continuity for a follow-up slack message in a thread: it becomes the next turn
 * of its run's existing session — whether that run is still in flight, completed,
 * or failed — so every reply in the thread continues the same session, like the
 * interactive @mention path. If the session has gone idle the prompt
 * re-spawns/restores it in the background; its reply posts back in-thread via the
 * slack completion callback (source "slack"), exactly like an interactive follow-up.
 */
function slackContinuation(
  event: SlackAutomationEvent,
  automation: AutomationRow,
  resolveActor: () => Promise<SteeringActor | null>,
  deps: SlackEventPolicyDeps
): ContinuationPolicy {
  return {
    source: "slack",
    logFields: { slack_actor_id: event.actorUserId, channel: event.channelId },
    resolveActor,
    buildPrompt: async (run, actor) => {
      const callbackContext: SlackCallbackContext = {
        source: "slack",
        channel: event.channelId,
        // Post in the existing thread; for a reply, threadTs is the thread root.
        threadTs: event.threadTs ?? event.ts,
        // React on (and later clear) the follow-up message itself.
        reactionMessageTs: event.ts,
        repoFullName: formatRunRepositoryLabel(run),
        model: automation.model,
        reasoningEffort: automation.reasoning_effort ?? undefined,
        // Marks the turn as automation-owned: a follow-up completes through the
        // interactive callback, which would otherwise treat it as a user request.
        automationId: automation.id,
      };
      const enrichment = await deps.resolveScmEnrichment(actor.userId);
      return {
        body: {
          content: event.text,
          authorId: actor.authorId,
          canonicalUserId: actor.userId,
          scmEnrichment:
            resolveScmProviderFromEnv(deps.continuity.env.SCM_PROVIDER) === "github"
              ? {
                  userId: enrichment?.scmUserId ?? null,
                  login: enrichment?.scmLogin ?? null,
                  name: enrichment?.displayName ?? null,
                  email: enrichment?.email ?? null,
                }
              : undefined,
          source: "slack",
          callbackContext,
        },
        // A steerable run takes many follow-ups; each inbound message is its
        // own hop, so the request id is the message's, not the run's.
        ctx: {
          trace_id: `automation:${automation.id}`,
          request_id: `slack:${event.channelId}:${event.ts}`,
        },
      };
    },
  };
}

/**
 * Serialize a slack event's message coordinates for the invocation's
 * trigger_metadata — carried by both real firings and concurrency skips.
 */
function serializeSlackTriggerMetadata(event: SlackAutomationEvent): string {
  const metadata: SlackRunMetadata = {
    channel: event.channelId,
    messageTs: event.ts,
  };
  return JSON.stringify(metadata);
}

/**
 * Tell the slack-bot to post a slack-triggered run's result into the triggering
 * message's thread and clear the `eyes` reaction, via its
 * `/callbacks/automation-complete` endpoint. Signs the body with the
 * slack-bot's own service secret (in-body HMAC, matching the bot's other
 * callbacks). No-ops when the run has no triggering message, when
 * `SLACK_BOT` is unbound, or when the secret is unset — all best-effort.
 */
export async function notifySlackCompletion(
  deps: Pick<SessionContinuityDeps, "db" | "env" | "store" | "log">,
  run: AutomationRunRow,
  completion: AutomationRunCompletion
): Promise<void> {
  const { db, env, store, log } = deps;
  const binding = env.SLACK_BOT;
  const secret = callbackSigningSecret(env, "slack-bot");
  if (!binding || !secret) return;

  let closureReason: string | null = null;
  await retryDelivery<void, Response>(
    async (signal) => {
      const invocation = await store.getInvocationById(run.invocation_id);
      const meta = parseSlackTriggerMetadata(invocation?.trigger_metadata ?? null);
      if (!meta?.messageTs) return { outcome: "delivered", value: undefined };
      const automation = await store.getById(completion.automationId);
      const [session, channelBinding] = await Promise.all([
        new SessionIndexStore(db).get(completion.sessionId),
        new TeamChannelBindingStore(db).get("slack", meta.channel),
      ]);
      // D1 reads cannot be canceled; an expired attempt must not reach the wire.
      signal.throwIfAborted();
      const denial = closureReason ?? slackPostGate(session, channelBinding);
      const body = denial
        ? {
            kind: "slack.thread_closed",
            sessionId: completion.sessionId,
            timestamp: Date.now(),
            context: { channel: meta.channel, threadTs: meta.messageTs },
          }
        : buildSlackCompletionNotification(meta, {
            sessionId: completion.sessionId,
            messageId: completion.messageId,
            success: completion.success,
            error: completion.error,
            repoFullName: formatRunRepositoryLabel(run),
            model: automation?.model ?? "",
            reasoningEffort: automation?.reasoning_effort ?? undefined,
          });
      if (!body) return { outcome: "delivered", value: undefined };

      if (denial) {
        log.info("Slack completion denied by session scope", {
          event: "scheduler.slack_complete_denied",
          run_id: run.id,
          session_id: completion.sessionId,
          reason: denial,
        });
      }

      const signature = await computeHmacHex(JSON.stringify(body), secret);
      signal.throwIfAborted();
      // The bot can tombstone the thread even when closure delivery fails.
      closureReason = denial;
      const endpoint = denial ? "thread_closed" : "automation-complete";
      const response = await binding.fetch(`https://internal/callbacks/${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...body, signature }),
        signal,
      });
      return response.ok
        ? { outcome: "delivered", value: undefined }
        : { outcome: "retryable_failure", failure: response };
    },
    (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    ({ attempt, failure: response, error }) => {
      log.warn("Slack completion callback failed", {
        event: "scheduler.slack_complete_failed",
        automation_id: run.automation_id,
        run_id: run.id,
        attempt,
        ...(response ? { http_status: response.status } : {}),
        ...(error !== undefined
          ? { error: error instanceof Error ? error : new Error(String(error)) }
          : {}),
      });
    }
  );
}
