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
4. Resolves the target GitHub repo from the team → repo mapping
5. Creates an Open-Inspect coding session and sends the issue as a prompt
6. Emits a `Response` activity with a link to the live session
7. When the agent completes, emits a final `Response` with the PR link

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

Add to your `terraform.tfvars`:

```hcl
linear_client_id      = "your-client-id"
linear_client_secret  = "your-client-secret"
linear_webhook_secret = "your-webhook-signing-secret"
```

Then `terraform apply`.

### 3. Install the Agent in Your Workspace

Visit `https://<your-linear-bot-worker>/oauth/authorize` in your browser. This initiates the OAuth
flow with `actor=app` and installs the agent in your Linear workspace.

**Requires admin permissions** in the Linear workspace.

After installation, `@OpenInspect` will appear in the mention and assignee menus.

### 4. Configure Team → Repo Mapping

Tell the agent which Linear team maps to which GitHub repositories:

```bash
curl -X PUT https://<your-linear-bot-worker>/config/team-repos \
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

### 5. Use It

On any Linear issue:

- Type `@OpenInspect` in a comment → agent picks up the issue
- Assign the issue to `OpenInspect` → agent picks it up
- Agent status is visible directly in Linear (thinking, working, done)

## API Endpoints

| Endpoint              | Method  | Description                            |
| --------------------- | ------- | -------------------------------------- |
| `/health`             | GET     | Health check                           |
| `/webhook`            | POST    | Linear webhook receiver                |
| `/oauth/authorize`    | GET     | Start OAuth installation flow          |
| `/oauth/callback`     | GET     | OAuth callback handler                 |
| `/config/team-repos`  | GET/PUT | Team → repo mapping                    |
| `/config/triggers`    | GET/PUT | Trigger configuration (legacy)         |
| `/callbacks/complete` | POST    | Completion callback from control plane |

## Agent Activity Types

The agent uses Linear's native activity system:

| Activity     | When                            | User sees                         |
| ------------ | ------------------------------- | --------------------------------- |
| **Thought**  | Analyzing issue, resolving repo | Thinking indicator in Linear      |
| **Response** | Session created, PR opened      | Comment-like message on the issue |
| **Error**    | Something went wrong            | Error message on the issue        |

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
- **`@linear/sdk`** — webhook verification via `LinearWebhookClient`, API calls via `LinearClient`
- **AgentSessionEvent** — native trigger when users @mention or assign
- **AgentActivity** — native status updates visible in Linear's UI
- **Hono** for HTTP routing
- **KV** for OAuth tokens, issue-to-session mapping, and configuration
- **Service binding** to the control plane for session management
