# @open-inspect/mcp-server

MCP server over the Open-Inspect control plane. It runs locally over stdio, so an MCP client such as
Claude Code or an IDE can inspect sessions, read automation runs, create and run automations, and
manage skills without the web UI.

## Security model

Requests authenticate with a **personal access token** you issue to yourself in the web UI
(**Settings › Access tokens**). The control plane decides what each request may do. This server only
presents tools:

- **The token acts as you, within its grant.** Every request is attributed to you, and to the token
  that made it. The token's permissions are the overlap of the permissions you granted it and your
  role's permissions now, so it never exceeds either. If your role loses a permission, or your
  account is suspended, the token loses it too.
- **It reaches only routes that accept tokens.** Each route the tools call declares that it accepts
  personal access tokens. Every other route refuses one, whatever it was granted. A token cannot
  create, list, or revoke tokens, so a leaked one cannot issue itself a successor.
- **You can revoke it immediately** under Settings › Access tokens. No deploy is involved.
- **Your workspace's token policy also applies.** An administrator can turn tokens off, cap their
  lifetime, limit the permissions they may hold, or revoke any member's token, and each change
  applies to existing tokens at once.

The control plane stores only a SHA-256 hash of the token. The token itself sits in plaintext in
your MCP client's configuration, like any local API key, so grant it only what you will use, and
give it the shortest lifetime that works.

### Choose the grant for what you want the assistant to do

| You want the assistant to…               | Grant                                                                                         |
| ---------------------------------------- | --------------------------------------------------------------------------------------------- |
| Investigate sessions and automation runs | `sessions.read`, `automations.read`, `skills.read`                                            |
| Also run existing automations            | add `automations.trigger.own` (or `.any`), `sessions.create`, and the targets' use permission |
| Also create automations                  | add `automations.create`, `sessions.create`, and `repositories.use` and/or `environments.use` |
| Also import and update skills            | add `skills.manage` (the picker adds `skills.read` with it)                                   |

The **Read-only** button in the token picker selects the first row and every other read permission
your role has and your workspace allows.

### Prompt injection

The read tools return content that the agent, tools, and repositories in a session produced, and
that content goes straight into your assistant's context. Treat it as untrusted. Text in a session
transcript or diff can ask the assistant to call a write tool. A write tool used that way acts with
your authority:

- An automation runs its instructions later, in a sandbox, as you. It has your repository and
  environment access, and the secrets those sessions receive.
- A skill with a `global` assignment loads into every later session in the workspace, not just
  yours.

Three things limit this:

- A token without write permissions cannot be talked into writing. The control plane refuses the
  call whatever the assistant sends. This is the only one of the three that is enforced.
- Every write tool is annotated `readOnlyHint: false`. That is a hint, not an enforced prompt:
  whether your client asks before running the tool depends on its settings, and a client set to
  approve tools automatically will not ask. Check yours before you grant write permissions, and read
  what a write is about to create before you approve it.
- Automations and skills created this way are visible in the dashboard and audit log, and you can
  delete them there.

For investigation, a read-only token is the right default.

## Setup

1. Issue a token in the web UI under **Settings › Access tokens › New token**. Name it after the
   machine it lives on, choose its permissions and lifetime, and copy the value. It is shown once.
2. Build the server:

   ```bash
   npm run build -w @open-inspect/shared
   npm run build -w @open-inspect/mcp-server
   ```

3. Register it with your MCP client, from the repository root:

   ```bash
   claude mcp add open-inspect \
     --env OPEN_INSPECT_CONTROL_PLANE_URL=https://<your-control-plane> \
     --env OPEN_INSPECT_TOKEN=oi_pat_... \
     -- node /absolute/path/to/packages/mcp-server/dist/index.js
   ```

| Variable                         | Purpose                               |
| -------------------------------- | ------------------------------------- |
| `OPEN_INSPECT_CONTROL_PLANE_URL` | Control plane worker URL (`https://`) |
| `OPEN_INSPECT_TOKEN`             | Personal access token (`oi_pat_…`)    |

Both are required. The process exits with a message on stderr if either is missing, or if the token
is not shaped like a personal access token. The URL must be `https://`, because the token travels in
an `Authorization` header on every request. Plain `http://` is accepted only for a loopback host
(`localhost`, `127.0.0.1`, `[::1]`). Redirects are refused rather than followed, so a redirect
cannot send the token anywhere else.

When a tool fails, its output says why:

- A `401` means the token was mistyped, revoked, or expired, or that your workspace has turned
  tokens off or capped their lifetime below the token's age. Issue a new one, if tokens are on, and
  update the client configuration.
- A `403` with `permission_required` names the permission the token was not granted, that your role
  no longer has, or that your workspace's token policy no longer allows.

`claude mcp add` does not check that `--env` values are non-empty. If you fill them from a command,
check that the command printed something.

## Tools

Each tool's description states the grant it needs, so the assistant can tell you what is missing.

| Tool                          | Route                                              | Grant                                                  |
| ----------------------------- | -------------------------------------------------- | ------------------------------------------------------ |
| `list_sessions`               | `GET /sessions`                                    | `sessions.read`                                        |
| `get_session_events`          | `GET /sessions/:id/events`                         | `sessions.read`                                        |
| `get_session_messages`        | `GET /sessions/:id/messages`                       | `sessions.read`                                        |
| `get_session_diff`            | `GET /sessions/:id/diff`                           | `sessions.read`                                        |
| `get_session_diff_file`       | `GET /sessions/:id/diff/:revisionId/files/:fileId` | `sessions.read`                                        |
| `list_automations`            | `GET /automations`                                 | `automations.read`                                     |
| `list_automation_invocations` | `GET /automations/:id/invocations`                 | `automations.read`                                     |
| `get_automation_run`          | `GET /automations/:id/runs/:runId`                 | `automations.read`                                     |
| `create_automation`           | `POST /automations`                                | `automations.create`, `sessions.create`                |
| `trigger_automation`          | `POST /automations/:id/trigger`                    | `automations.trigger.own` or `.any`, `sessions.create` |
| `list_skills`                 | `GET /skills`                                      | `skills.read`                                          |
| `import_skill_from_git`       | `POST /skills/import` (+ preview)                  | `skills.read`, `skills.manage`                         |
| `update_skill_from_git`       | `POST /skills/:id/reimport` (+ …)                  | `skills.read`, `skills.manage`                         |

`create_automation` and `trigger_automation` also need `repositories.use` or `environments.use` for
the automation's targets, the same checks you face in the web UI. A triggered run uses only what the
token was granted, even where your role allows more.

`get_session_diff` lists a diff's changed files without their patches; `get_session_diff_file` reads
one file's patch, using the revision and file ids from that list. `list_automation_invocations`
returns one invocation per firing, each with its child runs (one per target); `get_automation_run`
reads one child run by its id.

`get_session_events`, `get_session_messages`, `list_automations`, and `list_skills` are paged. Pass
the cursor from a response back to continue. `list_automations` also filters by name (`search`) and
by target repository (`repo_owner`, `repo_name`, either alone).

### Automation writes

- `create_automation` takes a name, instructions, a trigger, and an optional `team_id`, which a
  workspace that requires a team on creation needs. The default trigger is `schedule`, which needs a
  `schedule_cron` and the `schedule_tz` it is read in. The timezone defaults to UTC, which is rarely
  the hour anyone means, so pass your own.
  - Event-driven triggers (`github_event`, `linear_event`, `slack_event`, `sentry`, `webhook`) need
    an `event_type` and usually a `trigger_config` of conditions.
  - A `sentry` trigger also needs `sentry_client_secret`.
  - A `webhook` automation returns the key that calls it, shown once.

  The automation is created **enabled**, so a schedule starts firing at its next occurrence. No tool
  edits or pauses an automation, so create it with the schedule it should keep, and fix a mistake in
  the web UI.

- `trigger_automation` runs one now, outside its schedule. It returns the invocation id and its
  child runs; read one with `get_automation_run`. It fails with `409` while a run of that automation
  is already active. The invocation records its author as `unknown`, since a token does not
  establish whether a person or an agent fired it.

### Skill writes

Both run the control plane's preview-then-confirm handshake inside one tool call. The confirmation
sends the preview's digests back, and the control plane refuses to store anything that no longer
matches.

**That handshake only covers the source moving between the two requests. It is not the web UI's
preview screen.** Your MCP client shows you the repository and ref being requested, never the
content that comes back. Approve a ref the way you would approve running code from it. To read the
content first, import it through the web UI.

- `import_skill_from_git` takes a repository, an optional `ref` and `subdirectory`, and optional
  `assignments`. Without assignments the skill is stored, but no session loads it. It refuses a name
  that already exists.
- `update_skill_from_git` takes a skill id and an optional `ref`. The repository and subdirectory
  come from the skill's recorded source. It pins the write to the revision it read (`If-Match`), and
  reports `revisionCreated: false` when the source had not changed.

## Development

```bash
npm test -w @open-inspect/mcp-server
npm run typecheck -w @open-inspect/mcp-server
npm run build -w @open-inspect/mcp-server
```

The control plane's tests for these routes cover token admission, grant narrowing, and owner
attribution: `packages/control-plane/test/integration/personal-access-token-routes.test.ts`.
