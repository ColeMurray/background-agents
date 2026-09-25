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

const STRING_OPTION = 3;
const commands = [
  {
    name: "task",
    description: "Give the coding agent a task",
    options: [
      {
        type: STRING_OPTION,
        name: "prompt",
        description: "What should the agent do?",
        required: true,
        max_length: 4000,
      },
      {
        type: STRING_OPTION,
        name: "repo",
        description: "Repository to work on (not needed inside a task thread)",
        required: false,
        autocomplete: true,
      },
    ],
  },
];

const response = await fetch(
  `https://discord.com/api/v10/applications/${DISCORD_APPLICATION_ID}/guilds/${DISCORD_GUILD_ID}/commands`,
  {
    method: "PUT",
    headers: {
      Authorization: `Bot ${DISCORD_BOT_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(commands),
  }
);

if (!response.ok) {
  console.error(`Discord rejected the commands (${response.status}): ${await response.text()}`);
  process.exit(1);
}
const registered = await response.json();
console.log(`Registered: ${registered.map((command) => `/${command.name}`).join(", ")}`);
