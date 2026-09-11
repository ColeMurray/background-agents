# MCP Servers

Open-Inspect sessions run [OpenCode](https://opencode.ai) as their agent, so any MCP server you
register is available to the agent as tools. Servers can run locally in the sandbox (an `npx`
command) or connect to a remote HTTP endpoint, and each one can be scoped to specific repositories
so it only loads for the sessions that need it.

This guide covers day-to-day configuration. For how local MCP commands are prepared and cached at
session startup, see [How It Works](../HOW_IT_WORKS.md#preinstalling-local-mcp-dependencies).

---

## Quick Start

1. Go to **Settings > MCP Servers** and click **Add Server**.
2. Choose a **Name** (for example `you-search`) and a **Type**:
   - **Remote** — an HTTP endpoint such as `https://api.you.com/mcp`
   - **Local** — a command such as `npx -y @playwright/mcp`
3. Fill in the type-specific fields, plus optional environment variables (local) or HTTP headers
   (remote) for credentials.
4. Optionally set the scope to **Selected repositories only** so the server applies just to sessions
   on those repositories.
5. Save, then start a session. The agent can call the server's tools immediately.

Remote servers need no sandbox-side installation, so they are the lightest option when a hosted MCP
endpoint is available.

---

## Remote Server Example: You.com Web Search

A common use for background agents is looking up current documentation, error messages, or library
versions that fall outside the model's training data. The [You.com MCP server](https://you.com/docs)
provides web search and URL content extraction as remote MCP tools, so it works here with no local
install.

To register it:

1. In **Settings > MCP Servers**, click **Add Server**.
2. Set **Name** to `you-search` and **Type** to `Remote`.
3. Set **URL** to `https://api.you.com/mcp`.
4. Under **HTTP Headers**, add:
   - Header name: `Authorization`
   - Value: `Bearer <YDC_API_KEY>`
5. Save and start a session.

The agent can then call `you-search` (web search with citations) and `you-contents` (URL content
extraction). Get an API key at [you.com/platform/api-keys](https://you.com/platform/api-keys).

If you would rather not manage an API key, the keyless profile
`https://api.you.com/mcp?profile=free` exposes a basic `you-search` tool with no header
configuration — leave the headers empty in that case.

Alternatively, register the server from the web app's API directly:

```bash
curl -X POST "$OPENINSPECT_URL/api/mcp-servers" \
  -H "Authorization: Bearer $OPENINSPECT_SESSION_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
        "name": "you-search",
        "type": "remote",
        "url": "https://api.you.com/mcp",
        "headers": { "Authorization": "Bearer $YDC_API_KEY" },
        "enabled": true
      }'
```

Sessions started after the server is registered can use it right away; in-flight sessions are not
retrofitted.

### Troubleshooting

| Symptom                          | What to check                                                         |
| -------------------------------- | --------------------------------------------------------------------- |
| Tools do not appear in a session | The server must be saved before the session starts; check **Enabled** |
| Remote calls fail auth           | Confirm the `Authorization` header value is exactly `Bearer <key>`    |
| Server applies to the wrong repo | Switch the scope between global and **Selected repositories only**    |

---

## Repository Scoping

Each server can be scoped globally or to selected repositories only. Use scopes to keep sessions
lean: an MCP server's tools are injected into every session it applies to, so a search server scoped
to the repos that need it avoids loading tools elsewhere.

---

## Local Server Example: Playwright

Local servers run a command inside the sandbox. For example, browser automation:

- **Name**: `playwright`
- **Type**: `Local`
- **Command**: `npx -y @playwright/mcp`

Local commands that start with `npx` are pre-installed during sandbox startup; see
[How It Works](../HOW_IT_WORKS.md#preinstalling-local-mcp-dependencies) for how versions are cached
and pinned. Environment variables entered for a local server are passed to the command at launch.

---

## Permissions

Reading the MCP server list requires the `mcp_servers.read` permission and creating, updating, or
deleting servers requires `mcp_servers.manage`. See [Auth](../AUTH.md) for the role model.
