import {
  matchesConditions,
  conditionRegistry,
  type SlackAutomationEvent,
  type TriggerConfig,
} from "@open-inspect/shared/triggers";
import type { SlackCallbackContext } from "@open-inspect/shared/types/session-api";
import { parseAutomationTriggerFields, type AutomationRow } from "../db/automation-store";
import type { SlackChannelStore } from "../db/slack-channel-store";
import type { GitHubEnrichment } from "../session/identity";
import type { SourceControlProviderName } from "../source-control/types";
import type { Logger } from "../logger";
import type { SchedulerEventResult } from "./contracts";
import type { AutomationInvocationService } from "./invocation-service";
import type { AutomationSlackService } from "./slack-service";
import type { ContinuationOutcome, ContinuationPolicy, SteeringActor } from "./session-continuity";
import { formatRunRepositoryLabel, type SlackRunMetadata } from "./slack-completion";
import { composeAutomationPrompt } from "./event-prompt";
import { recordEventLaunch, recordContinuation, logEventResult } from "./event-outcome";

export interface SlackEventDeps {
  channels: Pick<SlackChannelStore, "getSlackAutomationsForChannel">;
  slack: Pick<
    AutomationSlackService,
    "getSessionInstructions" | "contextWithThread" | "notifySkip"
  >;
  invocations: Pick<AutomationInvocationService, "start">;
  continueSession(
    automation: AutomationRow,
    concurrencyKey: string,
    now: number,
    policy: ContinuationPolicy
  ): Promise<ContinuationOutcome>;
  resolveActor(event: SlackAutomationEvent): Promise<SteeringActor | null>;
  resolveScmEnrichment(userId: string): Promise<GitHubEnrichment | null>;
  scmProvider(): SourceControlProviderName;
  nowMs(): number;
  log: Logger;
}

/** Continue thread replies before evaluating conditions for a new firing. */
export async function handleSlackEvent(
  event: SlackAutomationEvent,
  deps: SlackEventDeps
): Promise<SchedulerEventResult> {
  const candidates = await deps.channels.getSlackAutomationsForChannel(event.channelId);
  // Share lazy reads across candidates, but never across incoming events.
  let contextPromise: Promise<string> | undefined;
  const contextBlock = () => (contextPromise ??= deps.slack.contextWithThread(event));
  let actorPromise: Promise<SteeringActor | null> | undefined;
  const resolveActor = () => (actorPromise ??= deps.resolveActor(event));
  let sessionInstructions: string | undefined;
  let settingsLoaded = false;
  let concurrencySkipped = false;
  const summary: SchedulerEventResult = { triggered: 0, skipped: 0, steered: 0, invocationIds: [] };

  for (const automation of candidates) {
    const now = deps.nowMs();
    // A reply need not repeat the keyword that started the original session.
    // A missing or refusing session falls through to new-trigger evaluation.
    const outcome = await deps.continueSession(
      automation,
      event.concurrencyKey,
      now,
      slackContinuation(deps, event, automation, resolveActor)
    );
    if (outcome.kind === "steered" || outcome.kind === "skipped") {
      recordContinuation(summary, outcome);
      continue;
    }

    let config: TriggerConfig;
    try {
      config = parseAutomationTriggerFields(automation).triggerConfig ?? { conditions: [] };
    } catch {
      deps.log.error("Skipped automation with invalid stored trigger fields", {
        event: "scheduler.invalid_trigger_fields",
        automation_id: automation.id,
      });
      summary.skipped++;
      continue;
    }
    if (!matchesConditions(config.conditions, event, conditionRegistry)) continue;

    if (!settingsLoaded) {
      sessionInstructions = await deps.slack.getSessionInstructions();
      settingsLoaded = true;
    }
    const instructions = appendSlackSessionInstructions(
      automation.instructions,
      sessionInstructions
    );
    const result = await deps.invocations.start({
      automation,
      source: "event",
      triggerKey: event.triggerKey,
      concurrencyKey: event.concurrencyKey,
      triggerMetadata: serializeSlackTriggerMetadata(event),
      instructionsOverride: composeAutomationPrompt(event.contextBlock, instructions),
      // Admission owns when this is evaluated: skipped firings do not read the thread.
      instructionsOverrideFactory: async () =>
        composeAutomationPrompt(await contextBlock(), instructions),
    });
    if (result.outcome === "skipped") concurrencySkipped = true;
    recordEventLaunch(summary, result, automation, event, deps.log);
  }
  if (concurrencySkipped) await deps.slack.notifySkip(event);
  logEventResult(deps.log, event, summary, candidates.length);
  return summary;
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
  deps: SlackEventDeps,
  event: SlackAutomationEvent,
  automation: AutomationRow,
  resolveActor: () => Promise<SteeringActor | null>
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
            deps.scmProvider() === "github"
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
