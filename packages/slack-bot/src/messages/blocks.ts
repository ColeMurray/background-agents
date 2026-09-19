import { getModelDisplayName } from "@open-inspect/shared/models";
import { setAssistantThreadStatusBestEffort } from "../activity-status";
import type { ModelSelection } from "../inline-flags";
import type { Env } from "../types";

const WORKING_MESSAGE_TEXT = "Starting work...";

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
 * Describe a session's model and reasoning when they are not the user's App
 * Home defaults. Returns undefined for the common case so the acknowledgement
 * stays bare unless there is something to report.
 */
export function formatSessionDefaultsNotice(launch: {
  sessionDefaults: ModelSelection;
  differsFromUserDefaults: boolean;
}): string | undefined {
  if (!launch.differsFromUserDefaults) return undefined;
  const parts = [getModelDisplayName(launch.sessionDefaults.model)];
  const { reasoningEffort } = launch.sessionDefaults;
  if (reasoningEffort) parts.push(`${reasoningEffort} reasoning`);
  return `Session defaults: ${parts.join(" · ")}`;
}

export interface WorkingMessage {
  /** Also the notification preview and the screen-reader fallback. */
  text: string;
  blocks: Array<Record<string, unknown>>;
}

/**
 * The whole acknowledgement, so `text` and `blocks` cannot drift apart. Slack
 * falls back to `text` wherever Block Kit is not rendered, so anything the
 * blocks say has to be said there too.
 */
export function buildWorkingMessage(
  options: { sessionId?: string; webAppUrl?: string; sessionDefaultsNotice?: string } = {}
): WorkingMessage {
  const blocks: Array<Record<string, unknown>> = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: WORKING_MESSAGE_TEXT,
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
  const text = options.sessionDefaultsNotice
    ? `${WORKING_MESSAGE_TEXT}\n${options.sessionDefaultsNotice}`
    : WORKING_MESSAGE_TEXT;
  return { text, blocks };
}
