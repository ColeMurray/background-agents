import { postMessage } from "@open-inspect/shared/slack";
import { getAvailableModels } from "../app-home/models";
import { notifyDroppedAttachments, prepareImageAttachments } from "../attachments";
import { getUserRepoBranchPreference } from "../branch-preferences";
import { getResolvedUserPreferences } from "../user-preferences";
import { createSession } from "./control-plane-client";
import { getSlackSettings } from "../slack-settings";
import { deliverPrompt } from "./prompt-delivery";
import { buildThreadSession, storeThreadSession } from "./thread-session-store";
import { createSessionLauncher } from "./session-launcher-application";

export type { StartSessionOptions } from "./session-launcher-application";

/** Production composition root for the Slack session-launch application. */
export const startSessionAndSendPrompt = createSessionLauncher({
  getAvailableModels,
  getSlackSettings,
  getResolvedUserPreferences,
  getUserRepoBranchPreference,
  createSession,
  prepareImageAttachments,
  notifyDroppedAttachments,
  deliverPrompt,
  postMessage,
  buildThreadSession,
  storeThreadSession,
});
