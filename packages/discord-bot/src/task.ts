/**
 * `/task` handling after the interaction has been acknowledged.
 *
 * A new task creates a session, turns the acknowledgement into a status
 * message, opens a thread on it, and sends the prompt with a callback context
 * pointing at that thread. `/task` inside a task thread sends a follow-up to
 * the thread's session instead.
 */

import {
  createSessionResponseSchema,
  type DiscordCallbackContext,
} from "@open-inspect/shared/types/session-api";
import { editOriginalResponse, startThreadFromMessage } from "./discord-api";
import { signedControlPlaneFetch } from "./internal-auth";
import { createLogger } from "./logger";
import { findRepo, listRepos } from "./repos";
import { threadSessionSchema, type Env, type Interaction, type ThreadSession } from "./types";

const log = createLogger("task");

/** Thread mappings outlive Discord's longest auto-archive window (7 days). */
const THREAD_SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;

export interface TaskRequest {
  interaction: Interaction;
  prompt: string;
  repo: string | undefined;
}

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

export function sessionUrl(env: Env, sessionId: string): string {
  return `${env.WEB_APP_URL.replace(/\/$/, "")}/session/${sessionId}`;
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
  params: {
    repoFullName: string;
    title: string;
    model: string;
    actor: string;
    displayName: string;
  },
  traceId: string
): Promise<string> {
  const [repoOwner, repoName] = params.repoFullName.split("/");
  const response = await signedControlPlaneFetch(env, {
    method: "POST",
    url: "https://internal/sessions",
    body: JSON.stringify({
      repoOwner,
      repoName,
      title: params.title,
      model: params.model,
      harness: env.HARNESS || "claude",
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

export async function handleTask(env: Env, request: TaskRequest): Promise<void> {
  const { interaction, prompt } = request;
  const traceId = crypto.randomUUID();
  const member = interaction.member;
  const channelId = interaction.channel_id;
  if (!member || !channelId) return;

  const userId = member.user.id;
  const actor = `discord:${userId}`;
  const displayName = member.nick || member.user.global_name || member.user.username;
  const reply = (content: string) =>
    editOriginalResponse(env.DISCORD_APPLICATION_ID, interaction.token, {
      content,
      mentionUserIds: [userId],
    });

  try {
    const existing = await lookupThreadSession(env, channelId);
    if (existing) {
      await sendPrompt(
        env,
        {
          sessionId: existing.sessionId,
          content: prompt,
          actor,
          context: {
            source: "discord",
            channelId,
            threadId: channelId,
            userId,
            repoFullName: existing.repoFullName,
            model: existing.model,
          },
        },
        traceId
      );
      await reply(`↪️ Follow-up from <@${userId}> sent to the session.\n${quote(prompt)}`);
      log.info("task.follow_up", { trace_id: traceId, session_id: existing.sessionId });
      return;
    }

    if (!request.repo) {
      await reply("Pick a repository with the `repo` option to start a new task.");
      return;
    }
    const repoFullName = findRepo(await listRepos(env, traceId), request.repo);
    if (!repoFullName) {
      await reply(
        `\`${request.repo}\` isn't a repository the GitHub App can access. Pick one from the list.`
      );
      return;
    }

    const title = taskTitle(prompt);
    const model = env.DEFAULT_MODEL;
    const sessionId = await createSession(
      env,
      { repoFullName, title, model, actor, displayName },
      traceId
    );

    const messageId = await reply(
      `🛠️ **Task started** by <@${userId}> on \`${repoFullName}\`\n${quote(prompt)}\n` +
        `[View session](<${sessionUrl(env, sessionId)}>)`
    );

    let threadId: string | undefined;
    try {
      threadId = await startThreadFromMessage(env.DISCORD_BOT_TOKEN, channelId, messageId, title);
      const record: ThreadSession = { sessionId, repoFullName, model, createdAt: Date.now() };
      await env.DISCORD_KV.put(threadKey(threadId), JSON.stringify(record), {
        expirationTtl: THREAD_SESSION_TTL_SECONDS,
      });
    } catch (error) {
      // The reply still lands in the channel; only follow-ups are lost.
      log.warn("task.thread_failed", { trace_id: traceId, session_id: sessionId, error });
    }

    await sendPrompt(
      env,
      {
        sessionId,
        content: prompt,
        actor,
        context: { source: "discord", channelId, threadId, userId, repoFullName, model },
      },
      traceId
    );
    log.info("task.started", {
      trace_id: traceId,
      session_id: sessionId,
      repo: repoFullName,
      thread: threadId !== undefined,
    });
  } catch (error) {
    log.error("task.failed", { trace_id: traceId, error });
    const message = error instanceof Error ? error.message : "Unexpected error";
    await reply(`⚠️ Couldn't start the task: ${message}`).catch(() => undefined);
  }
}
