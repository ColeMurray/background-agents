/**
 * Open-Inspect Discord bot.
 *
 * Discord posts every interaction (the `/task` command and its repository
 * autocomplete) to `POST /interactions`. Commands are acknowledged within
 * Discord's 3-second window and processed in the background; the control
 * plane reports completion to `/callbacks`.
 */

import { Hono } from "hono";
import { checkAccess, denialMessage, parseIdList } from "./access";
import { callbacksRouter } from "./callbacks";
import { createLogger } from "./logger";
import { listRepos, repoChoices } from "./repos";
import { handleTask } from "./task";
import {
  EPHEMERAL_FLAG,
  InteractionResponseType,
  InteractionType,
  interactionSchema,
  type CommandOption,
  type Env,
} from "./types";
import { verifyDiscordSignature } from "./verify";

const log = createLogger("interactions");

export const TASK_COMMAND = "task";

function optionValue(options: CommandOption[] | undefined, name: string): string | undefined {
  const value = options?.find((option) => option.name === name)?.value;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function ephemeral(content: string) {
  return {
    type: InteractionResponseType.ChannelMessageWithSource,
    data: { content, flags: EPHEMERAL_FLAG, allowed_mentions: { parse: [] } },
  };
}

const app = new Hono<{ Bindings: Env }>();

app.get("/health", (c) => c.json({ status: "healthy", service: "open-inspect-discord-bot" }));

app.post("/interactions", async (c) => {
  const body = await c.req.text();
  const authentic = await verifyDiscordSignature({
    publicKey: c.env.DISCORD_PUBLIC_KEY,
    signature: c.req.header("x-signature-ed25519"),
    timestamp: c.req.header("x-signature-timestamp"),
    body,
  });
  if (!authentic) return c.json({ error: "invalid request signature" }, 401);

  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    return c.json({ error: "invalid payload" }, 400);
  }
  const parsed = interactionSchema.safeParse(raw);
  if (!parsed.success) return c.json({ error: "invalid payload" }, 400);
  const interaction = parsed.data;

  if (interaction.type === InteractionType.Ping) {
    return c.json({ type: InteractionResponseType.Pong });
  }

  if (interaction.data?.name !== TASK_COMMAND) {
    return c.json(ephemeral("Unknown command."));
  }

  const allowedChannelIds = parseIdList(c.env.DISCORD_ALLOWED_CHANNEL_IDS);
  const access = checkAccess(interaction, {
    allowedRoleIds: parseIdList(c.env.DISCORD_ALLOWED_ROLE_IDS),
    allowedChannelIds,
  });

  if (interaction.type === InteractionType.Autocomplete) {
    // Only reveal the repository list to people allowed to use it.
    if (!access.allowed) {
      return c.json({ type: InteractionResponseType.AutocompleteResult, data: { choices: [] } });
    }
    const query = String(interaction.data.options?.find((option) => option.focused)?.value ?? "");
    try {
      const repos = await listRepos(c.env);
      return c.json({
        type: InteractionResponseType.AutocompleteResult,
        data: { choices: repoChoices(repos, query) },
      });
    } catch (error) {
      log.error("autocomplete.failed", { error });
      return c.json({ type: InteractionResponseType.AutocompleteResult, data: { choices: [] } });
    }
  }

  if (interaction.type !== InteractionType.ApplicationCommand) {
    return c.json(ephemeral("Unsupported interaction."));
  }

  if (!access.allowed) {
    log.info("task.denied", {
      reason: access.reason,
      user_id: interaction.member?.user.id,
      channel_id: interaction.channel_id,
    });
    return c.json(ephemeral(denialMessage(access, allowedChannelIds)));
  }

  const prompt = optionValue(interaction.data.options, "prompt");
  if (!prompt) return c.json(ephemeral("Describe the task in the `prompt` option."));

  c.executionCtx.waitUntil(
    handleTask(c.env, {
      interaction,
      prompt,
      repo: optionValue(interaction.data.options, "repo"),
    })
  );
  return c.json({ type: InteractionResponseType.DeferredChannelMessageWithSource });
});

app.route("/callbacks", callbacksRouter);

export default app;
