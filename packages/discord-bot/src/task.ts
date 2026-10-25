/**
 * `/task` handling after the interaction has been acknowledged.
 *
 * A new task creates a session, turns the acknowledgement into a status
 * message, opens a thread on it, and sends the prompt with a callback context
 * pointing at that thread. `/task` inside a task thread sends a follow-up to
 * the thread's session instead.
 */

import type { HarnessId } from "@open-inspect/shared/harnesses";
import {
  createSessionResponseSchema,
  type DiscordCallbackContext,
} from "@open-inspect/shared/types/session-api";
import { editOriginalResponse, startThreadFromMessage } from "./discord-api";
import { signedControlPlaneFetch } from "./internal-auth";
import { getLaunchConfig, LaunchConfigError } from "./launch-config";
import { sessionUrl } from "./links";
import { createLogger } from "./logger";
import { finishProgress, startProgress } from "./progress";
import { findRepo, listRepos, type TaskRepo } from "./repos";
import { lookupThreadSession, storeThreadSession } from "./thread-session-store";
import type { Env, GuildCommand } from "./types";

const log = createLogger("task");

const MAX_TASK_TITLE_LENGTH = 80;
const MAX_PROMPT_QUOTE_LENGTH = 300;
const MAX_ERROR_LOG_LENGTH = 300;
const ELLIPSIS = "...";
const TEAM_REQUIRED_MESSAGE =
  "This workspace requires a team for new sessions. Discord tasks do not support team selection yet. Start the task in the web app and select a team.";

export interface TaskRequest {
  interaction: GuildCommand;
  prompt: string;
  repo: string | undefined;
}

interface TaskRun {
  env: Env;
  request: TaskRequest;
  identity: { userId: string; actor: string; displayName: string };
  reply: (content: string) => Promise<string>;
  traceId: string;
}

function callbackContext(
  coordinates: Omit<DiscordCallbackContext, "source" | "statusMessage">
): Omit<DiscordCallbackContext, "statusMessage"> {
  return { source: "discord", ...coordinates };
}

/** Where a prompt goes: an existing session or one created for it. */
interface PromptTarget {
  sessionId: string;
  /** The thread when there is one, else the channel the command came from. */
  replyChannelId: string;
  context: Omit<DiscordCallbackContext, "statusMessage">;
}

/** The user declined or mistyped something; the reply says what to change. */
class TaskRejected extends Error {}

/** First line of the prompt, trimmed to fit a session title and a thread name. */
export function taskTitle(prompt: string): string {
  const firstLine = prompt.trim().split("\n")[0] ?? "";
  return firstLine.length > MAX_TASK_TITLE_LENGTH
    ? `${firstLine.slice(0, MAX_TASK_TITLE_LENGTH - ELLIPSIS.length)}${ELLIPSIS}`
    : firstLine;
}

function quote(text: string, max = MAX_PROMPT_QUOTE_LENGTH): string {
  const clipped = text.length > max ? `${text.slice(0, max - ELLIPSIS.length)}${ELLIPSIS}` : text;
  return clipped
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}

async function responseText(response: Response): Promise<string> {
  return (await response.text().catch(() => "")).slice(0, MAX_ERROR_LOG_LENGTH);
}

async function createSession(
  env: Env,
  params: {
    repo: TaskRepo;
    title: string;
    model: string;
    harness: HarnessId;
    actor: string;
    displayName: string;
  },
  traceId: string
): Promise<string> {
  const response = await signedControlPlaneFetch(env, {
    method: "POST",
    url: "https://internal/sessions",
    body: JSON.stringify({
      repoOwner: params.repo.owner,
      repoName: params.repo.name,
      title: params.title,
      model: params.model,
      harness: params.harness,
      actorDisplayName: params.displayName,
    }),
    actor: params.actor,
    traceId,
  });
  if (!response.ok) {
    // Read once. Only this expected refusal has a public explanation; never echo API text.
    if (response.status === 400) {
      const payload: unknown = await response.json().catch(() => null);
      if (
        payload &&
        typeof payload === "object" &&
        "code" in payload &&
        payload.code === "team_required"
      ) {
        throw new TaskRejected(TEAM_REQUIRED_MESSAGE);
      }
      throw new Error(`Could not create a session (${response.status})`);
    }
    throw new Error(
      `Could not create a session (${response.status}): ${await responseText(response)}`
    );
  }
  const parsed = createSessionResponseSchema.safeParse(await response.json().catch(() => null));
  if (!parsed.success) throw new Error("Control plane returned an invalid session response");
  return parsed.data.sessionId;
}

async function sendPrompt(
  env: Env,
  params: { sessionId: string; content: string; actor: string; context: DiscordCallbackContext },
  traceId: string
): Promise<void> {
  const response = await signedControlPlaneFetch(env, {
    method: "POST",
    url: `https://internal/sessions/${params.sessionId}/prompt`,
    body: JSON.stringify({
      content: params.content,
      source: "discord",
      callbackContext: params.context,
    }),
    actor: params.actor,
    traceId,
  });
  if (!response.ok) {
    throw new Error(
      `Could not send the prompt (${response.status}): ${await responseText(response)}`
    );
  }
}

/**
 * Create the session and the thread for a new task. The thread is best
 * effort: without it the reply still lands in the channel, only follow-ups
 * are lost.
 */
async function createTarget(run: TaskRun): Promise<PromptTarget> {
  const { env, request, identity, reply, traceId } = run;
  const { interaction, prompt } = request;
  const channelId = interaction.channel_id;
  if (!request.repo) {
    throw new TaskRejected("Pick a repository with the `repo` option to start a new task.");
  }
  const repo = findRepo(await listRepos(env, traceId), request.repo);
  if (!repo) {
    throw new TaskRejected(
      `\`${request.repo}\` isn't a repository the GitHub App can access. Pick one from the list.`
    );
  }

  const title = taskTitle(prompt);
  const { model, harness } = getLaunchConfig(env);
  const sessionId = await createSession(env, { repo, title, model, harness, ...identity }, traceId);

  const messageId = await reply(
    `🛠️ **Task started** by <@${identity.userId}> on \`${repo.fullName}\`\n${quote(prompt)}\n` +
      `[View session](<${sessionUrl(env, sessionId)}>)`
  );

  let threadId: string | undefined;
  try {
    threadId = await startThreadFromMessage(env.DISCORD_BOT_TOKEN, channelId, messageId, title);
    await storeThreadSession(env, threadId, {
      sessionId,
      repoFullName: repo.fullName,
      model,
      createdAt: Date.now(),
    });
  } catch (error) {
    log.warn("task.thread_failed", { trace_id: traceId, session_id: sessionId, error });
  }

  log.info("task.started", {
    trace_id: traceId,
    session_id: sessionId,
    repo: repo.fullName,
    thread: threadId !== undefined,
  });
  return {
    sessionId,
    replyChannelId: threadId ?? channelId,
    context: callbackContext({
      channelId,
      threadId,
      userId: identity.userId,
      repoFullName: repo.fullName,
      model,
    }),
  };
}

/** The thread's session for a follow-up, else a new session and thread. */
async function resolveTarget(run: TaskRun): Promise<PromptTarget> {
  const { env, request, identity, reply, traceId } = run;
  const channelId = request.interaction.channel_id;
  const existing = await lookupThreadSession(env, channelId);
  if (!existing) return createTarget(run);
  if (request.repo && request.repo.trim().toLowerCase() !== existing.repoFullName.toLowerCase()) {
    throw new TaskRejected(
      `This thread works on \`${existing.repoFullName}\`. Start a new task from the channel to use another repository.`
    );
  }

  await reply(
    `↪️ Follow-up from <@${identity.userId}> sent to the session.\n${quote(request.prompt)}`
  );
  log.info("task.follow_up", { trace_id: traceId, session_id: existing.sessionId });
  return {
    sessionId: existing.sessionId,
    replyChannelId: channelId,
    context: callbackContext({
      channelId,
      threadId: channelId,
      userId: identity.userId,
      repoFullName: existing.repoFullName,
      model: existing.model,
    }),
  };
}

export async function handleTask(env: Env, request: TaskRequest): Promise<void> {
  const { interaction, prompt } = request;
  const traceId = crypto.randomUUID();
  const { member } = interaction;
  const userId = member.user.id;
  const identity = {
    userId,
    actor: `discord:${userId}`,
    displayName: member.nick || member.user.global_name || member.user.username,
  };
  const reply = (content: string) =>
    editOriginalResponse(env.DISCORD_APPLICATION_ID, interaction.token, {
      content,
      mentionUserIds: [userId],
    });

  const run: TaskRun = { env, request, identity, reply, traceId };
  try {
    const target = await resolveTarget(run);
    // Posted before the prompt so the first tool call finds its status message.
    const statusMessage = await startProgress(env, target.replyChannelId);
    try {
      await sendPrompt(
        env,
        {
          sessionId: target.sessionId,
          content: prompt,
          actor: identity.actor,
          context: { ...target.context, statusMessage },
        },
        traceId
      );
    } catch (error) {
      if (statusMessage) {
        await finishProgress(env, {
          channelId: target.replyChannelId,
          statusMessage,
          success: false,
        });
      }
      throw error;
    }
  } catch (error) {
    if (error instanceof TaskRejected || error instanceof LaunchConfigError) {
      await reply(error.message).catch(() => undefined);
      return;
    }
    log.error("task.failed", { trace_id: traceId, error });
    // The reply is public; internal error text stays in the logs.
    await reply(`⚠️ Couldn't start the task. Trace ID: \`${traceId}\``).catch(() => undefined);
  }
}
