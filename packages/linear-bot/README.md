# Open-Inspect Linear Bot

Cloudflare Worker that integrates [Linear](https://linear.app) with Open-Inspect, enabling
background coding agent sessions triggered directly from Linear issues.

## How It Works

```
Linear Issue → Webhook → Linear Bot → Control Plane → Sandbox → PR
     ↑                                                            │
     └────────── Comment with PR link ←── Completion callback ────┘
```

1. You create or update a Linear issue (add a label, assign it, etc.)
2. Linear sends a webhook to this worker
3. The worker resolves the team → GitHub repo mapping
4. Creates an Open-Inspect session and sends the issue as a prompt
5. Posts an acknowledgment comment with a session link
6. When the agent completes, posts a comment with the PR link

## Trigger Modes

Configure via `PUT /config/triggers`:

| Mode            | Description                              | Config                            |
| --------------- | ---------------------------------------- | --------------------------------- |
| **Label**       | Trigger when a specific label is added   | `triggerLabel: "agent"`           |
| **Assignee**    | Trigger when assigned to a specific user | `triggerAssignee: "Open-Inspect"` |
| **Auto-create** | Trigger on all new issues                | `autoTriggerOnCreate: true`       |

Default: Label trigger with `"agent"` label.

## Setup

### 1. Configure Team → Repo Mapping

Tell the bot which Linear team maps to which GitHub repository:

```bash
curl -X PUT https://your-linear-bot.workers.dev/config/team-repos \
  -H "Content-Type: application/json" \
  -d '{
    "YOUR_TEAM_ID": {
      "owner": "your-org",
      "name": "your-repo"
    }
  }'
```

Find your team ID in Linear's URL or via the API.

### 2. Create a Linear Webhook

1. Go to **Linear Settings → API → Webhooks**
2. Click **New Webhook**
3. URL: `https://your-linear-bot.workers.dev/webhook`
4. Select events: **Issues** (create, update)
5. Note the **Signing Secret**

### 3. Set Secrets

```bash
wrangler secret put LINEAR_WEBHOOK_SECRET
wrangler secret put LINEAR_API_KEY
wrangler secret put INTERNAL_CALLBACK_SECRET
```

- `LINEAR_WEBHOOK_SECRET`: The signing secret from step 2
- `LINEAR_API_KEY`: A Linear API key (Settings → API → Personal API keys)
- `INTERNAL_CALLBACK_SECRET`: Same secret used by the control plane for callback verification

### 4. Configure Triggers (Optional)

```bash
# Use a custom label name
curl -X PUT https://your-linear-bot.workers.dev/config/triggers \
  -H "Content-Type: application/json" \
  -d '{
    "triggerLabel": "🔵agent",
    "autoTriggerOnCreate": false
  }'
```

## API Endpoints

| Endpoint              | Method  | Description                            |
| --------------------- | ------- | -------------------------------------- |
| `/health`             | GET     | Health check                           |
| `/webhook`            | POST    | Linear webhook receiver                |
| `/config/team-repos`  | GET/PUT | Team → repo mapping                    |
| `/config/triggers`    | GET/PUT | Trigger configuration                  |
| `/callbacks/complete` | POST    | Completion callback from control plane |

## Development

```bash
cd packages/linear-bot
npm install
npm run build
wrangler dev  # Local development
```

## Deployment

Production deployment is managed via Terraform alongside the other Open-Inspect services. For
standalone deployment:

```bash
npm run build
wrangler deploy
```

## Architecture

The Linear bot follows the same patterns as the Slack bot:

- **Hono** for HTTP routing
- **KV** for issue-to-session mapping and configuration
- **Service binding** to the control plane for session management
- **Structured JSON logging** matching the control-plane envelope
- **HMAC signature verification** for both Linear webhooks and internal callbacks
