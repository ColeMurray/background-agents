import { postBlocks } from "@open-inspect/shared/slack";
import { canReadProject } from "@open-inspect/shared/types/projects";
import { ProjectStore } from "../db/project-store";
import { SessionIndexStore, type SessionEntry } from "../db/session-index";
import { IntegrationSettingsStore, resolveSlackSettings } from "../db/integration-settings";
import type { SlackGlobalSettings } from "@open-inspect/shared/types/integrations";
import type { SqlDatabase } from "../db/sql-database";
import type { Env } from "../types";
import { projectViewer } from "./project-context";

/** Originating Slack conversations retain their destination; projects are only a fallback. */
export async function projectSlackChannel(
  db: SqlDatabase,
  session: SessionEntry
): Promise<string | null> {
  if (!session.projectId || !session.userId || session.spawnSource === "slack-bot") return null;
  const project = await new ProjectStore(db).get(session.projectId);
  if (!project?.primarySlackChannelId) return null;
  const viewer = await projectViewer(db, session.userId);
  return canReadProject(viewer, project) ? project.primarySlackChannelId : null;
}

/** Best-effort, at-most-one attempt. Never posts conversation content or private-session metadata. */
export async function notifyProjectCompletion(
  db: SqlDatabase,
  env: Env,
  sessionId: string,
  messageId: string,
  success: boolean,
  claim: () => boolean
): Promise<boolean> {
  if (!env.SLACK_BOT_TOKEN) return false;
  const session = await new SessionIndexStore(db).get(sessionId);
  if (!session || session.visibility === "private") return false;
  const channel = await projectSlackChannel(db, session);
  if (!channel) return false;
  const store = new IntegrationSettingsStore(db);
  const settings =
    session.repoOwner && session.repoName
      ? (await store.getResolvedConfig("slack", `${session.repoOwner}/${session.repoName}`))
          .settings
      : ((await store.getGlobal("slack"))?.defaults ?? {});
  if (
    !resolveSlackSettings(settings as Partial<SlackGlobalSettings>).agentNotificationsEnabled ||
    !claim()
  )
    return false;
  const blocks: unknown[] = [
    {
      type: "section",
      text: {
        type: "plain_text",
        text: `Project session ${success ? "completed" : "needs attention"}.`,
      },
    },
  ];
  if (env.WEB_APP_URL)
    blocks.push({
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "View session" },
          url: `${env.WEB_APP_URL.replace(/\/$/, "")}/session/${encodeURIComponent(sessionId)}`,
        },
      ],
    });
  const result = await postBlocks(env.SLACK_BOT_TOKEN, channel, blocks, {
    signal: AbortSignal.timeout(10_000),
  });
  if (!result.ok)
    throw new Error(
      `Project completion notification failed: ${result.error ?? "unknown"} (${messageId})`
    );
  return true;
}
