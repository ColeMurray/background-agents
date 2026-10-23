/**
 * Open-Inspect Discord bot.
 *
 * Discord posts every interaction (the `/task` command and its repository
 * autocomplete) to `POST /interactions`. Commands are acknowledged within
 * Discord's 3-second window and processed in the background; the control
 * plane reports completion to `/callbacks`.
 */

import { Hono } from "hono";
import { checkAccess, denialMessage, parseIdList, type AccessDecision } from "./access";
import { callbacksRouter } from "./callbacks";
import { PROMPT_OPTION_NAME, REPO_OPTION_NAME, TASK_COMMAND_NAME } from "./commands";
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
  type Interaction,
} from "./types";
import { MAX_SIGNATURE_SKEW_MS, verifyDiscordSignature } from "./verify";

const log = createLogger("interactions");

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

function autocompleteResult(choices: { name: string; value: string }[]) {
  return { type: InteractionResponseType.AutocompleteResult, data: { choices } };
}

async function handleAutocomplete(env: Env, interaction: Interaction, access: AccessDecision) {
  // Only reveal the repository list to people allowed to use it.
  if (!access.allowed) return autocompleteResult([]);
  const query = String(interaction.data?.options?.find((option) => option.focused)?.value ?? "");
  try {
    return autocompleteResult(repoChoices(await listRepos(env), query));
  } catch (error) {
    log.error("autocomplete.failed", { error });
    return autocompleteResult([]);
  }
}

function handleCommand(
  env: Env,
  interaction: Interaction,
  access: AccessDecision,
  allowedChannelIds: string[],
  waitUntil: (promise: Promise<unknown>) => void
) {
  if (!access.allowed) {
    log.info("task.denied", {
      reason: access.reason,
      user_id: interaction.member?.user.id,
      channel_id: interaction.channel_id,
    });
    return ephemeral(denialMessage(access, allowedChannelIds));
  }

  const prompt = optionValue(interaction.data?.options, PROMPT_OPTION_NAME);
  if (!prompt) return ephemeral(`Describe the task in the \`${PROMPT_OPTION_NAME}\` option.`);

  waitUntil(
    handleTask(env, {
      interaction: access.command,
      prompt,
      repo: optionValue(interaction.data?.options, REPO_OPTION_NAME),
    })
  );
  return { type: InteractionResponseType.DeferredChannelMessageWithSource };
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
  if (interaction.data?.name !== TASK_COMMAND_NAME) {
    return c.json(ephemeral("Unknown command."));
  }

  const allowedChannelIds = parseIdList(c.env.DISCORD_ALLOWED_CHANNEL_IDS);
  const access = checkAccess(interaction, {
    allowedRoleIds: parseIdList(c.env.DISCORD_ALLOWED_ROLE_IDS),
    allowedChannelIds,
  });

  switch (interaction.type) {
    case InteractionType.Autocomplete:
      return c.json(await handleAutocomplete(c.env, interaction, access));
    case InteractionType.ApplicationCommand:
      if (await isReplay(c.env, interaction.id)) {
        return c.json(ephemeral("This command was already received."));
      }
      return c.json(
        handleCommand(c.env, interaction, access, allowedChannelIds, (promise) =>
          c.executionCtx.waitUntil(promise)
        )
      );
    default:
      return c.json(ephemeral("Unsupported interaction."));
  }
});

/**
 * Best-effort dedupe for a command delivered twice inside the signature window.
 * KV is not atomic, so two copies racing in parallel can both pass. A KV
 * failure skips dedupe, so the command proceeds.
 */
async function isReplay(env: Env, interactionId: string): Promise<boolean> {
  const key = `interaction:${interactionId}`;
  try {
    if ((await env.DISCORD_KV.get(key)) !== null) return true;
    await env.DISCORD_KV.put(key, "1", {
      expirationTtl: Math.ceil((2 * MAX_SIGNATURE_SKEW_MS) / 1000),
    });
  } catch (error) {
    log.warn("interactions.replay_check_failed", { interaction_id: interactionId, error });
  }
  return false;
}

app.route("/callbacks", callbacksRouter);

export default app;
