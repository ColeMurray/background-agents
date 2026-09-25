# Open-Inspect Discord Bot

Cloudflare Worker that starts Open-Inspect coding sessions from a Discord `/task` slash command and
reports progress and results in a Discord thread.

For setup and day-to-day usage, see the user-facing
[Discord integration guide](../../docs/integrations/DISCORD.md).

## How It Works

```
/task prompt repo → Discord POSTs /interactions → signature + role/channel check →
  deferred ack (within 3s) → create session → "Task started" reply → open thread →
  status message in thread → send prompt with Discord callback context →
  /callbacks/tool_call edits the status message → /callbacks/complete posts the result
```

1. Discord sends every interaction to `POST /interactions`. The worker verifies the Ed25519
   signature against `DISCORD_PUBLIC_KEY` and answers Discord's `PING`.
2. `checkAccess` (`src/access.ts`) admits a command only from a server member holding one of
   `DISCORD_ALLOWED_ROLE_IDS`, in one of `DISCORD_ALLOWED_CHANNEL_IDS` or a thread under one. An
   empty role list admits no one; an empty channel list admits any channel.
3. **Autocomplete** for the `repo` option returns the repositories from the control plane's
   `GET /repos`, cached in KV for five minutes so it answers inside Discord's 3-second window.
   Denied users get an empty list.
4. **`/task`** is acknowledged with a deferred response and handled in `waitUntil` (`src/task.ts`):
   - Inside a known task thread, the prompt is sent to that thread's session as a follow-up.
   - Otherwise the worker creates a session (actor `discord:<user id>`, harness `HARNESS`, model
     `DEFAULT_MODEL`), edits the deferred reply into a "Task started" message, opens a thread on it,
     and stores `thread:<thread id> → session` in KV for 30 days.
   - It posts a status message in the thread, then sends the prompt with a `discord` callback
     context naming the channel, thread, and user.
5. The control plane calls back with signed payloads:
   - `POST /callbacks/tool_call` appends a one-line step summary to the status message (keeping the
     last five) and sends a typing indicator (`src/progress.ts`).
   - `POST /callbacks/complete` fetches the agent's response, marks the status message finished or
     stopped, and posts the summary and pull request link, mentioning the requester
     (`src/callbacks.ts`, `src/format.ts`).

If the thread cannot be created, replies go to the channel and follow-ups are unavailable.

## Bindings

| Binding                       | Kind    | Purpose                                                       |
| ----------------------------- | ------- | ------------------------------------------------------------- |
| `DISCORD_KV`                  | KV      | Thread → session map, status message records, repo list cache |
| `CONTROL_PLANE`               | Service | Control plane API                                             |
| `DISCORD_APPLICATION_ID`      | Var     | Edits the deferred interaction response                       |
| `DISCORD_PUBLIC_KEY`          | Var     | Verifies interaction signatures                               |
| `DISCORD_ALLOWED_ROLE_IDS`    | Var     | Comma-separated roles allowed to submit tasks                 |
| `DISCORD_ALLOWED_CHANNEL_IDS` | Var     | Comma-separated channels; empty accepts any                   |
| `DEFAULT_MODEL`               | Var     | Model for new sessions                                        |
| `HARNESS`                     | Var     | `claude` (default) or `opencode`                              |
| `WEB_APP_URL`                 | Var     | Session links                                                 |
| `DISCORD_BOT_TOKEN`           | Secret  | Posts and edits messages, opens threads                       |
| `SERVICE_AUTH_SECRET`         | Secret  | Signs control plane requests and verifies its callbacks       |

All of these are set by Terraform (`terraform/environments/production/workers-discord.tf`) when
`enable_discord_bot = true`.

## Development

```bash
npm run build -w @open-inspect/shared      # first, if shared types changed
npm test -w @open-inspect/discord-bot
npm run typecheck -w @open-inspect/discord-bot
npm run build -w @open-inspect/discord-bot # bundles dist/index.js for Terraform
```

Register or update the `/task` command for one server (guild commands update instantly):

```bash
DISCORD_APPLICATION_ID=... DISCORD_BOT_TOKEN=... DISCORD_GUILD_ID=... \
  npm run register-commands -w @open-inspect/discord-bot
```
