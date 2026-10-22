#!/usr/bin/env node
/**
 * Register the `/task` slash command with one Discord server.
 *
 * Server (guild) commands update immediately, unlike global commands.
 * Re-running is safe: the command is overwritten in place.
 *
 *   DISCORD_APPLICATION_ID=... DISCORD_BOT_TOKEN=... DISCORD_GUILD_ID=... \
 *     npm run register-commands -w @open-inspect/discord-bot
 */

import { TASK_COMMAND } from "../src/commands.ts";

const { DISCORD_APPLICATION_ID, DISCORD_BOT_TOKEN, DISCORD_GUILD_ID } = process.env;
for (const [name, value] of Object.entries({
  DISCORD_APPLICATION_ID,
  DISCORD_BOT_TOKEN,
  DISCORD_GUILD_ID,
})) {
  if (!value) {
    console.error(`Missing ${name}`);
    process.exit(1);
  }
}

const response = await fetch(
  `https://discord.com/api/v10/applications/${DISCORD_APPLICATION_ID}/guilds/${DISCORD_GUILD_ID}/commands`,
  {
    method: "PUT",
    headers: {
      Authorization: `Bot ${DISCORD_BOT_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify([TASK_COMMAND]),
  }
);

if (!response.ok) {
  console.error(`Discord rejected the commands (${response.status}): ${await response.text()}`);
  process.exit(1);
}
const registered: unknown = await response.json();
const names = Array.isArray(registered)
  ? registered.map((command: { name: string }) => `/${command.name}`)
  : [];
console.log(`Registered: ${names.join(", ")}`);
