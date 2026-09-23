# Discord Integration

Submit coding tasks from a Discord server with a slash command:

```text
/task prompt: make the WhatsApp icon black  repo: acme/website
```

The bot replies in the channel, opens a thread on its reply, and posts the result (pull request link
and summary) in that thread when the session finishes. Running `/task` inside a task thread sends a
follow-up to the same session; the `repo` option is not needed there.

## Who can submit tasks

- Only members holding one of `discord_allowed_role_ids` (for example a **dev** role).
- Only in `discord_allowed_channel_ids` and threads under them. Leave it empty to accept any
  channel.
- Everyone else gets a private reply saying why, and the repository autocomplete stays empty for
  them.

> **The Discord role is the admission gate.** Each Discord user who submits a task becomes a
> workspace **Member** (identity `discord:<user id>`), without the web app's sign-in allowlists.
> Grant the role only to people you would let use the GitHub App's repositories.

Discord provides no email address to bots, so a Discord user is not linked to their web account.
Pull requests from Discord tasks are opened by the GitHub App.

## Billing: Claude subscription or API key

Sessions run on the **Claude Agent** harness (`discord_bot_harness = "claude"`), which can use a
connected Claude subscription. In **Settings → Accounts**, connect a Claude account, choose **Make
default**, and under **Automated sessions** set **Claude** to that account. Without a default
account the session falls back to an Anthropic API key.

Set `discord_bot_harness = "opencode"` to use OpenCode instead; it always uses the API key.

## Setup

### 1. Create the Discord application

1. https://discord.com/developers/applications → **New Application**.
2. **General Information**: copy the **Application ID** and **Public Key**.
3. **Bot**: **Reset Token** and copy the token. No privileged intents are needed.
4. **Installation**: Install Link → **Discord Provided Link**; Guild Install scopes `bot` and
   `applications.commands`; permissions **View Channels**, **Send Messages**, **Send Messages in
   Threads**, **Create Public Threads**, **Read Message History**. Open the link and add the bot to
   your server.
5. In Discord, enable **User Settings → Advanced → Developer Mode**, then right-click to **Copy ID**
   for the server, the dev role (Server Settings → Roles), and the task channel.

### 2. Deploy the worker

In `terraform.tfvars`:

```hcl
enable_discord_bot          = true
discord_application_id      = "<application id>"
discord_public_key          = "<public key>"
discord_bot_token           = "<bot token>"
discord_allowed_role_ids    = "<dev role id>"
discord_allowed_channel_ids = "<task channel id>"
```

Then run `terraform apply`. On an existing deployment one apply is enough: Terraform creates the bot
worker before it adds the binding to it on the control plane. On a first deployment, follow the
usual two-phase apply.

### 3. Point Discord at the worker

1. **General Information → Interactions Endpoint URL**:
   `terraform output -raw discord_bot_interactions_url`. Discord verifies the URL when you save.
2. Register the command with your server:

   ```bash
   DISCORD_APPLICATION_ID=... DISCORD_BOT_TOKEN=... DISCORD_GUILD_ID=... \
     npm run register-commands -w @open-inspect/discord-bot
   ```

## Troubleshooting

- **"The application did not respond"**: the interactions URL is wrong, or the worker cannot verify
  signatures because `discord_public_key` does not match the application.
- **No thread appears**: the bot lacks **Create Public Threads** in that channel. The result is
  posted in the channel instead, but follow-ups need the thread.
- **"x-api-key header is required"** in the session: no default Claude account is set for automated
  sessions (see Billing).
- **`/task` is missing**: re-run `register-commands` with the server's ID.
