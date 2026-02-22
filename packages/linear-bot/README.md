# Open-Inspect Linear Agent

Cloudflare Worker that integrates [Linear](https://linear.app) with Open-Inspect as a first-class
**Linear Agent**. Users can `@mention` or assign the agent on issues to trigger background coding
sessions.

## How It Works

```
@OpenInspect on issue → Linear sends AgentSessionEvent webhook →
  Agent emits "Thinking..." → Resolves repo → Creates session →
  Agent emits "Working on owner/repo..." → Agent codes in sandbox →
  Completion callback → Agent emits "PR opened: <link>"
```

1. A user `@mentions` or assigns the agent on a Linear issue
2. Linear sends an `AgentSessionEvent` webhook to this worker
3. The worker emits a `Thought` activity (visible in Linear as "thinking")
4. Resolves the target GitHub repo (see [Repo Resolution](#repo-resolution) below)
5. Creates an Open-Inspect coding session and sends the issue as a prompt
6. Emits a `Response` activity with a link to the live session
7. When the agent completes, emits a final `Response` with the PR link

Follow-up messages on an issue with an active session are sent as additional prompts to the existing
session rather than creating a new one. Stopping or cancelling the agent in Linear kills the sandbox
session.

## Setup

### 1. Create a Linear OAuth Application

Go to
**[Linear Settings → API → Applications → New](https://linear.app/settings/api/applications/new)**

Fill in:

- **Application name:** `OpenInspect` (this is how the bot appears in @mentions)
- **Developer name:** Your org name
- **Callback URL:** `https://<your-linear-bot-worker>/oauth/callback`
- **Webhooks:** Enable, set URL to `https://<your-linear-bot-worker>/webhook`
- **Webhook events:** Check **Agent session events**, **Issues**, **Comments**
- **Public:** OFF (unless distributing to other workspaces)

Note the **Client ID**, **Client Secret**, and **Webhook Signing Secret**.

### 2. Deploy via Terraform

Set `enable_linear_bot = true` and add to your `terraform.tfvars`:

```hcl
enable_linear_bot     = true
linear_client_id      = "your-client-id"
linear_client_secret  = "your-client-secret"
linear_webhook_secret = "your-webhook-signing-secret"
```

The worker also requires these secrets (set via `wrangler secret put` or Terraform):

- **`ANTHROPIC_API_KEY`** — used by the LLM classifier for repo resolution fallback
- **`INTERNAL_CALLBACK_SECRET`** — HMAC auth for config endpoints and callback verification

Then `terraform apply`.

### 3. Install the Agent in Your Workspace

Visit `https://<your-linear-bot-worker>/oauth/authorize` in your browser. This initiates the OAuth
flow with `actor=app` and installs the agent in your Linear workspace.

**Requires admin permissions** in the Linear workspace.

After installation, `@OpenInspect` will appear in the mention and assignee menus.

### 4. Configure Repo Mapping (Optional)

The agent resolves repos automatically in most cases (see [Repo Resolution](#repo-resolution)).
Static mappings are optional overrides. All `/config/*` endpoints require an `Authorization` header
with an HMAC-signed bearer token (from `INTERNAL_CALLBACK_SECRET`).

**Team → repo mapping:**

```bash
curl -X PUT https://<your-linear-bot-worker>/config/team-repos \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "YOUR_TEAM_ID": [
      { "owner": "your-org", "name": "frontend", "label": "frontend" },
      { "owner": "your-org", "name": "backend", "label": "backend" },
      { "owner": "your-org", "name": "main-repo" }
    ]
  }'
```

Each team maps to an array of repos. If a repo has a `label`, it only matches issues with that
label. The first repo without a label is the default fallback.

**Project → repo mapping:**

```bash
curl -X PUT https://<your-linear-bot-worker>/config/project-repos \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "LINEAR_PROJECT_ID": { "owner": "your-org", "name": "my-repo" }
  }'
```

Project mappings take the highest priority during repo resolution.

### 5. Configure Integration Settings (Optional)

In the Open-Inspect web UI, go to **Settings → Integrations → Linear** to configure:

- Default model and reasoning effort
- Whether users can override the model via preferences or issue labels
- Whether real-time tool progress activities are shown in Linear
- Which repos the Linear agent is enabled for (allowlist or all)

These can also be set per-repo as overrides.

### 6. Use It

On any Linear issue:

- Type `@OpenInspect` in a comment → agent picks up the issue
- Assign the issue to `OpenInspect` → agent picks it up
- Agent status is visible directly in Linear (thinking, working, done)
- Add a `model:<name>` label to override the model (e.g., `model:opus`, `model:sonnet`,
  `model:haiku`, `model:gpt-5.2-codex`)

## Repo Resolution

When an issue is triggered, the agent resolves the target GitHub repo using a 4-step cascade:

1. **Project → repo mapping** — static mapping from Linear project IDs (highest priority)
2. **Team → repo mapping** — static mapping from Linear team IDs, with optional label filtering
3. **Linear's `issueRepositorySuggestions` API** — Linear's built-in repo suggestion (>= 70%
   confidence)
4. **LLM classifier** — uses Claude Haiku to classify based on issue content, labels, and available
   repo descriptions. Asks the user to clarify if confidence is low.

## API Endpoints

All `/config/*` endpoints require HMAC auth via `Authorization: Bearer <token>`.

| Endpoint                     | Method  | Description                               |
| ---------------------------- | ------- | ----------------------------------------- |
| `/health`                    | GET     | Health check                              |
| `/webhook`                   | POST    | Linear webhook receiver                   |
| `/oauth/authorize`           | GET     | Start OAuth installation flow             |
| `/oauth/callback`            | GET     | OAuth callback handler                    |
| `/config/team-repos`         | GET/PUT | Team → repo mapping                       |
| `/config/project-repos`      | GET/PUT | Project → repo mapping                    |
| `/config/user-prefs/:userId` | GET/PUT | Per-user model and reasoning preferences  |
| `/config/triggers`           | GET/PUT | Trigger configuration (legacy)            |
| `/callbacks/complete`        | POST    | Completion callback from control plane    |
| `/callbacks/tool_call`       | POST    | Tool progress callback from control plane |

## Agent Activity Types

The agent uses Linear's native activity system:

| Activity        | When                              | User sees                                       |
| --------------- | --------------------------------- | ----------------------------------------------- |
| **Thought**     | Analyzing issue, resolving repo   | Thinking indicator in Linear                    |
| **Response**    | Session created, PR opened        | Comment-like message on the issue               |
| **Error**       | Something went wrong              | Error message on the issue                      |
| **Action**      | Tool calls (file edits, commands) | Ephemeral status (e.g., "Editing `src/foo.ts`") |
| **Elicitation** | Repo classification is uncertain  | Question asking user to clarify                 |

## Development

```bash
cd packages/linear-bot
npm install
npm run build
wrangler dev  # Local development
```

## Architecture

Built on Linear's [Agents API](https://linear.app/developers/agents):

- **OAuth2 with `actor=app`** — agent has its own identity in the workspace
- **Raw Linear GraphQL API** — direct `fetch` calls (no SDK, Workers can't import CJS)
- **AgentSessionEvent** — native trigger when users @mention or assign
- **AgentActivity** — native status updates visible in Linear's UI
- **Hono** for HTTP routing
- **KV** for OAuth tokens, issue-to-session mapping, and configuration
- **Service binding** to the control plane for session management
