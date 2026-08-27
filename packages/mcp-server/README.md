# @open-inspect/mcp-server

Read-only MCP server over the Open-Inspect control plane. Runs locally over stdio so an MCP client —
Claude Code, an IDE — can inspect sessions and automation runs without the web UI.

## Security model

Requests are signed as the **`mcp` service** using `sig1`, the same per-service scheme the bots use.
Two properties make this safe to keep on a laptop:

- **It asserts no actor.** `ASSERTION_RIGHTS.mcp` is `null`, so the control plane resolves it to a
  bare service principal. Unlike `slack-bot`, `github-bot`, and `linear-bot` — each of which may
  assert an actor in its own namespace — this credential cannot act as any person.
- **It reads only.** `ControlPlaneClient` exposes `get()` and nothing else. The same signature would
  be accepted on the mutating routes that share the user-or-service policy (stopping a session,
  deleting one, triggering an automation), so the restriction lives in the client rather than in
  each tool's discipline.

**Never point this at `SERVICE_AUTH_SECRET_WEB`.** The `web` service is the one that escalates to
_user_ auth by pairing its signature with a Better Auth cookie; its secret on a laptop is a
categorically larger exposure. That is why `mcp` has its own secret.

Two limits worth knowing. Nonce-reuse detection in the control plane is log-only and in-isolate, so
a captured request can be replayed inside the five-minute signature validity window — harmless for
GETs, and a reason not to widen this service to anything mutating. And the secret sits in plaintext
in your MCP client config, like any local API key; rotating it means a Terraform apply.

## Setup

Deploy first, so the control plane knows the `mcp` service name and holds its verification key, then
read the secret out of Terraform state:

```bash
cd terraform/environments/production
terraform apply
terraform output -raw mcp_service_secret
terraform output -raw control_plane_url
```

Build, then register it with your MCP client:

```bash
npm run build -w @open-inspect/shared
npm run build -w @open-inspect/mcp-server
```

```bash
claude mcp add open-inspect \
  --env OPEN_INSPECT_CONTROL_PLANE_URL=<control_plane_url> \
  --env OPEN_INSPECT_MCP_SECRET=<mcp_service_secret> \
  -- node /absolute/path/to/packages/mcp-server/dist/index.js
```

| Variable                         | Purpose                                     |
| -------------------------------- | ------------------------------------------- |
| `OPEN_INSPECT_CONTROL_PLANE_URL` | Control plane worker URL                    |
| `OPEN_INSPECT_MCP_SECRET`        | `sig1` signing secret for the `mcp` service |

Both are required; the process exits with a message on stderr if either is missing. A `401` from any
tool means the signature was rejected — a stale secret, or a control plane deployed before the `mcp`
service name existed.

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
them.

`GET /sessions/:id` (session detail) and `sandbox-access` are human-user-only and deliberately out
of reach — the latter mints credentials.

## Development

```bash
npm test -w @open-inspect/mcp-server
npm run typecheck -w @open-inspect/mcp-server
```

The client tests verify a real signature round-trip against the control plane's own
`verifyServiceSignature`, so a change to the `sig1` canonical form fails here rather than at
runtime.
