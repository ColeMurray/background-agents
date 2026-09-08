import { setAssistantThreadStatusBestEffort } from "../activity-status";
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

export function buildWorkingMessageBlocks(
  repoFullName: string,
  options: { reasoning?: string; sessionId?: string; webAppUrl?: string } = {}
): Array<Record<string, unknown>> {
  const blocks: Array<Record<string, unknown>> = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: options.reasoning
          ? `Working on *${repoFullName}*...\n_${options.reasoning}_`
          : `Working on *${repoFullName}*...`,
      },
    },
  ];
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
