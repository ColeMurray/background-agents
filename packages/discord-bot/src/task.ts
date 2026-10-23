/**
 * `/task` handling after the interaction has been acknowledged.
 *
 * A new task creates a session, turns the acknowledgement into a status
 * message, opens a thread on it, and sends the prompt with a callback context
 * pointing at that thread. `/task` inside a task thread sends a follow-up to
 * the thread's session instead.
 */

import { harnessIdSchema } from "@open-inspect/shared/harnesses";
import {
  createSessionResponseSchema,
  type DiscordCallbackContext,
} from "@open-inspect/shared/types/session-api";
import { editOriginalResponse, startThreadFromMessage } from "./discord-api";
import { signedControlPlaneFetch } from "./internal-auth";
import { sessionUrl } from "./links";
import { createLogger } from "./logger";
import { finishProgress, startProgress } from "./progress";
import { findRepo, listRepos, type TaskRepo } from "./repos";
import { threadSessionSchema, type Env, type GuildCommand, type ThreadSession } from "./types";

const log = createLogger("task");

/** Thread mappings outlive Discord's longest auto-archive window (7 days). */
const THREAD_SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;

export interface TaskRequest {
  interaction: GuildCommand;
  prompt: string;
  repo: string | undefined;
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

function threadKey(threadId: string): string {
  return `thread:${threadId}`;
}

export async function lookupThreadSession(
  env: Env,
  threadId: string
): Promise<ThreadSession | null> {
  const raw = await env.DISCORD_KV.get(threadKey(threadId), "json");
  const parsed = threadSessionSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** First line of the prompt, trimmed to fit a session title and a thread name. */
export function taskTitle(prompt: string): string {
  const firstLine = prompt.trim().split("\n")[0] ?? "";
  return firstLine.length > 80 ? `${firstLine.slice(0, 77)}...` : firstLine;
}

function quote(text: string, max = 300): string {
  const clipped = text.length > max ? `${text.slice(0, max - 3)}...` : text;
  return clipped
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}

async function responseText(response: Response): Promise<string> {
  return (await response.text().catch(() => "")).slice(0, 300);
}

async function createSession(
  env: Env,
  params: { repo: TaskRepo; title: string; model: string; actor: string; displayName: string },
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
      harness: harnessIdSchema.parse(env.HARNESS),
      actorDisplayName: params.displayName,
    }),
    actor: params.actor,
    traceId,
  });
  if (!response.ok) {
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
async function createTarget(
  env: Env,
  request: TaskRequest,
  identity: { userId: string; actor: string; displayName: string },
  reply: (content: string) => Promise<string>,
  traceId: string
): Promise<PromptTarget> {
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
  const model = env.DEFAULT_MODEL;
  const sessionId = await createSession(env, { repo, title, model, ...identity }, traceId);

  const messageId = await reply(
    `🛠️ **Task started** by <@${identity.userId}> on \`${repo.fullName}\`\n${quote(prompt)}\n` +
      `[View session](<${sessionUrl(env, sessionId)}>)`
  );

  let threadId: string | undefined;
  try {
    threadId = await startThreadFromMessage(env.DISCORD_BOT_TOKEN, channelId, messageId, title);
    const record: ThreadSession = {
      sessionId,
      repoFullName: repo.fullName,
      model,
      createdAt: Date.now(),
    };
    await env.DISCORD_KV.put(threadKey(threadId), JSON.stringify(record), {
      expirationTtl: THREAD_SESSION_TTL_SECONDS,
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
    context: {
      source: "discord",
      channelId,
      threadId,
      userId: identity.userId,
      repoFullName: repo.fullName,
      model,
    },
  };
}

/** The thread's session for a follow-up, else a new session and thread. */
async function resolveTarget(
  env: Env,
  request: TaskRequest,
  identity: { userId: string; actor: string; displayName: string },
  reply: (content: string) => Promise<string>,
  traceId: string
): Promise<PromptTarget> {
  const channelId = request.interaction.channel_id;
  const existing = await lookupThreadSession(env, channelId);
  if (!existing) return createTarget(env, request, identity, reply, traceId);
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
    context: {
      source: "discord",
      channelId,
      threadId: channelId,
      userId: identity.userId,
      repoFullName: existing.repoFullName,
      model: existing.model,
    },
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

  try {
    const target = await resolveTarget(env, request, identity, reply, traceId);
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
    if (error instanceof TaskRejected) {
      await reply(error.message).catch(() => undefined);
      return;
    }
    log.error("task.failed", { trace_id: traceId, error });
    // The reply is public; internal error text stays in the logs.
    await reply(`⚠️ Couldn't start the task. Trace ID: \`${traceId}\``).catch(() => undefined);
  }
}
