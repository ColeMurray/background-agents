# @open-inspect/mcp-server

Read-only MCP server over the Open-Inspect control plane. Runs locally over stdio so an MCP client —
Claude Code, an IDE — can inspect sessions and automation runs without the web UI.

## Security model

Requests authenticate with a **personal access token** you issue to yourself in the web UI. Three
properties make this safe to keep on a laptop:

- **It is yours, and it says so.** The control plane resolves the token to your canonical user id,
  so every request it makes is attributable to a person rather than to an anonymous service. Routes
  that scope their answers to a viewer scope them to you.
- **It reads only, and the control plane enforces that.** An access-token principal is refused every
  method but `GET`/`HEAD` on every route, whatever that route's own policy allows
  (`principalMayUseMethod` in control-plane `auth/principal.ts`). A leaked token cannot issue a
  `DELETE /sessions/:id` or a `PUT /secrets`. `ControlPlaneClient` exposing only `get()` is
  convenience on top of that, not the boundary itself.

  Safe methods are the boundary rather than a route allowlist because every mutating route is
  already a non-GET, while an allowlist would fail open for each read route added later.

- **You can revoke it yourself, immediately.** Settings → Access Tokens → Revoke. No deploy, no
  Terraform apply. A token also cannot mint another token: `/access-tokens` is a human-only route,
  so a leaked credential cannot issue itself a successor to survive its own revocation.

The control plane stores only a SHA-256 hash of the token, so a database read cannot recover a
working credential.

Two limits worth knowing. Human-only routes — `GET /sessions/:id` and `sandbox-access`, the latter
of which mints credentials — are deliberately out of reach; a token that could reach them would be a
larger credential than the one it replaces. And the token sits in plaintext in your MCP client
config, like any local API key. That is the reason it is read-only, scoped to you, and revocable in
one click.

## Setup

Issue a token in the web UI: **Settings → Access Tokens → New Token**. Name it after the machine it
will live on, pick an expiry, and copy the value — it is shown once and never again.

Build the server:

```bash
npm run build -w @open-inspect/shared
npm run build -w @open-inspect/mcp-server
```

Register it with your MCP client, from the repository root:

```bash
claude mcp add open-inspect \
  --env OPEN_INSPECT_CONTROL_PLANE_URL=https://<your-control-plane> \
  --env OPEN_INSPECT_TOKEN=oi_pat_... \
  -- node /absolute/path/to/packages/mcp-server/dist/index.js
```

| Variable                         | Purpose                            |
| -------------------------------- | ---------------------------------- |
| `OPEN_INSPECT_CONTROL_PLANE_URL` | Control plane worker URL           |
| `OPEN_INSPECT_TOKEN`             | Personal access token (`oi_pat_…`) |

Both are required; the process exits with a message on stderr if either is missing. A `401` from any
tool means the token was rejected — mistyped, revoked, or expired. Issue a new one and update the
client config.

Note that `claude mcp add` does not validate that `--env` values are non-empty. If you populate them
from a command, check that the command actually printed something first.

## Tools

| Tool                   | Route                              | Use                                            |
| ---------------------- | ---------------------------------- | ---------------------------------------------- |
| `list_sessions`        | `GET /sessions`                    | find a session id                              |
| `get_session_events`   | `GET /sessions/:id/events`         | what a session did, and where it went wrong    |
| `get_session_messages` | `GET /sessions/:id/messages`       | prompts and responses without tool detail      |
| `get_session_diff`     | `GET /sessions/:id/diff`           | the changes a session produced                 |
| `list_automation_runs` | `GET /automations/:id/invocations` | did a scheduled automation fire, skip, or fail |
| `get_automation_run`   | `GET /automations/:id/runs/:runId` | one run and the sessions it launched           |

Every route above already carried a user-or-service auth policy; adding this package changed none of
them. `get_session_events` and `get_session_messages` are paged — pass the cursor from a response
back to continue.

## Development

```bash
npm test -w @open-inspect/mcp-server
npm run typecheck -w @open-inspect/mcp-server
```

Control-plane coverage for the credential itself lives in
`packages/control-plane/test/integration/access-tokens.test.ts`, which exercises the real D1 path:
read-only enforcement, expiry, revocation, and the human-only guard on `/access-tokens`.
