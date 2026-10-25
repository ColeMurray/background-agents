import { computeHmacHex } from "@open-inspect/shared/auth";
import { callbackSigningSecret } from "../auth/service/callback-signing";
import { AutomationStore } from "../db/automation-store";
import { IntegrationSettingsStore } from "../db/integration-settings";
import { SessionIndexStore } from "../db/session-index";
import type { SqlDatabase } from "../db/sql-database";
import { TeamChannelBindingStore } from "../db/team-channel-bindings";
import { createLogger, parseLogLevel } from "../logger";
import type { BackgroundTasks } from "../platform-ports";
import { retryDelivery } from "../session/callback-delivery";
import type { Env } from "../types";
import { Scheduler } from "./scheduler";
import { AutomationSlackService } from "./slack-service";

/** Assemble scheduler collaborators without starting database or network work. */
export function createScheduler(
  db: SqlDatabase,
  env: Env,
  backgroundJobs: BackgroundTasks
): Scheduler {
  const log = createLogger("scheduler", {}, parseLogLevel(env.LOG_LEVEL));
  const sessions = new SessionIndexStore(db);
  const channels = new TeamChannelBindingStore(db);
  const slack = new AutomationSlackService({
    bot: env.SLACK_BOT,
    signingSecret: callbackSigningSecret(env, "slack-bot"),
    automations: new AutomationStore(db),
    settings: new IntegrationSettingsStore(db),
    postScope: {
      getSession: (sessionId) => sessions.get(sessionId),
      getChannelBinding: (channelId) => channels.get("slack", channelId),
    },
    sign: computeHmacHex,
    retryDelivery,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    nowMs: () => Date.now(),
    log,
  });
  return new Scheduler({ db, env, backgroundJobs, slack, log });
}
