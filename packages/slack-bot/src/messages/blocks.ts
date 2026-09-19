import { getModelDisplayName } from "@open-inspect/shared/models";
import { setAssistantThreadStatusBestEffort } from "../activity-status";
import { divergesFromUserDefaults, type ResolvedTurnPlan } from "../inline-flags";
import type { Env } from "../types";

export type BackgroundTaskScheduler = (promise: Promise<void>) => void;

export function scheduleStartingStatus(
  scheduleBackground: BackgroundTaskScheduler,
  env: Env,
  channel: string,
  threadTs: string,
  traceId?: string
): void {
  scheduleBackground(
    setAssistantThreadStatusBestEffort(env, channel, threadTs, "Starting...", {
      event: "start",
      traceId,
    })
  );
}

/**
 * Describe a new session's model and reasoning when they differ from the
 * user's App Home defaults. Returns undefined for the common case so the
 * acknowledgement stays bare unless there is something to report.
 */
export function formatSessionDefaultsNotice(plan: ResolvedTurnPlan): string | undefined {
  if (!divergesFromUserDefaults(plan)) return undefined;
  const parts = [getModelDisplayName(plan.effective.model)];
  if (plan.effective.reasoningEffort) parts.push(`${plan.effective.reasoningEffort} reasoning`);
  return `Session defaults: ${parts.join(" · ")}`;
}

export function buildWorkingMessageBlocks(
  options: { sessionId?: string; webAppUrl?: string; sessionDefaultsNotice?: string } = {}
): Array<Record<string, unknown>> {
  const blocks: Array<Record<string, unknown>> = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: "Starting work...",
      },
    },
  ];
  // A context line on the acknowledgement that is already in the thread, so a
  // non-default session is visible without adding a message of its own.
  if (options.sessionDefaultsNotice) {
    blocks.push({
      type: "context",
      elements: [{ type: "mrkdwn", text: options.sessionDefaultsNotice }],
    });
  }
  if (options.sessionId && options.webAppUrl) {
    blocks.push({
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "View Session" },
          url: `${options.webAppUrl}/session/${options.sessionId}`,
          action_id: "view_session",
        },
      ],
    });
  }
  return blocks;
}
