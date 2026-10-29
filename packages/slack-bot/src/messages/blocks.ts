import { getHarnessLabel, type HarnessId } from "@open-inspect/shared/harnesses";
import { getModelDisplayName } from "@open-inspect/shared/models";
import { escapeMrkdwnText } from "@open-inspect/shared/slack";
import { setAssistantThreadStatusBestEffort } from "../activity-status";
import type { ModelSelection } from "../inline-flags";
import type { BackgroundTaskScheduler, Env } from "../types";

const WORKING_MESSAGE_TEXT = "Starting work...";

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

export type LaunchModelSource = "app-home" | "slack-default" | "system-default" | "request";

export function formatDisabledModelLaunchRefusal(model: string, source: LaunchModelSource): string {
  const name = escapeMrkdwnText(getModelDisplayName(model));
  if (source === "app-home") {
    return `Your App Home model "${name}" is no longer enabled. Choose another model in the Slack app's Home tab, or start your request with \`!model\` and an enabled model.`;
  }
  if (source === "request") {
    return `Your requested model "${name}" is no longer enabled. Start a new request with \`!model\` and an enabled model.`;
  }
  const label = source === "slack-default" ? "Slack default" : "system default";
  return `The ${label} model "${name}" is no longer enabled. Ask an admin to enable it in Settings > Models or update the ${label} model. You can choose another model in the Slack app's Home tab, or start your request with \`!model\` and an enabled model.`;
}

/** Reply to a request whose model the user's harness cannot run; no session was created. */
export function formatHarnessLaunchRefusal(
  compatibilityMessage: string,
  harness: HarnessId
): string {
  const label = getHarnessLabel(harness);
  return `${escapeMrkdwnText(compatibilityMessage)} Start your request with \`!model\` and a model ${label} can run, or change your model or agent harness in the Slack app's Home tab.`;
}

/** Reply to a follow-up whose `!model` the thread's harness cannot run. */
export function formatHarnessModelRefusal(controlPlaneMessage: string): string {
  return `${escapeMrkdwnText(controlPlaneMessage)} A thread keeps the harness its session started on. Reply without \`!model\`, or start a new thread to use that model.`;
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
