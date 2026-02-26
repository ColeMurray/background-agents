# Open-Inspect Teams Bot

Cloudflare Worker that integrates Microsoft Teams with Open-Inspect. Users can message the bot in
channels or DMs to trigger background coding sessions.

## How It Works

```
User @mentions bot in Teams channel or sends DM →
  Bot classifies target repo → Creates session via control plane →
  Sends prompt → Agent codes in sandbox →
  Completion callback → Bot replies with results
```

1. User @mentions the bot in a channel or sends a direct message
2. The bot strips the @mention and classifies the target GitHub repo
3. If ambiguous, shows an Adaptive Card dropdown for repo selection
4. Creates an Open-Inspect session and sends the user's message as a prompt
5. Replies with a "Working on..." message and a link to the live session
6. When the agent completes, posts the results as a plain text reply

Follow-up messages in the same thread (or DM) are sent as additional prompts to the existing session
rather than creating a new one. Type `reset` or `new` to clear the session and start fresh.

## Setup

### 1. Register an Azure Bot

1. Go to [Azure Portal](https://portal.azure.com) → **Create a resource** → search **Azure Bot**
2. Fill in:
   - **Bot handle**: `open-inspect`
   - **Type of App**: Single Tenant (recommended)
   - **Creation type**: Create new Microsoft App ID
3. After creation, go to **Configuration** and note the **Microsoft App ID**
4. Go to **Manage Password** → **Certificates & secrets** → create a **Client secret**
5. Note the **Directory (tenant) ID** from the App Registration overview

### 2. Enable the Teams Channel

1. In the Azure Bot resource, go to **Channels**
2. Click **Microsoft Teams** → **Save**

### 3. Deploy via Terraform

Set `enable_teams_bot = true` and add to your `terraform.tfvars`:

```hcl
enable_teams_bot       = true
microsoft_app_id       = "your-app-id"
microsoft_app_password = "your-client-secret"
microsoft_tenant_id    = "your-tenant-id"
```

Then `terraform apply`.

### 4. Configure Integration Settings (Optional)

In the Open-Inspect web UI, go to **Settings → Integrations → Microsoft Teams Bot** to configure:

- Default model and reasoning effort
- Typing indicator mode (`response` or `never`)

### 5. Use It

- **Channel threads**: @mention the bot with your request — it replies in the thread
- **Direct messages**: Message the bot directly for 1:1 sessions
- **Settings**: Type `settings` or `preferences` to configure your model and reasoning effort
- **Reset**: Type `reset` or `new` to clear the current session

## Session Lifecycle

Sessions are stored in KV keyed by conversation and thread:

- **Channel messages**: keyed by `thread:{conversationId}:{rootActivityId}`
- **Direct messages**: keyed by `thread:{conversationId}:dm`

Sessions expire after 24 hours. When a session's backing sandbox is archived, the bot automatically
clears the stale mapping and creates a new session on the next message.

## Authentication

### Bot Framework Token Validation

Incoming activities from Teams are verified against Microsoft's OpenID metadata:

1. Fetch signing keys from `https://login.botframework.com/v1/.well-known/openidconfiguration`
2. Validate JWT: audience matches `microsoft_app_id`, issuer is Bot Framework
3. Reject with 401 on failure

Keys are cached for 24 hours.

### Control Plane Auth

Requests to the control plane use HMAC tokens from `INTERNAL_CALLBACK_SECRET` (same mechanism as the
Slack and GitHub bots).

## Environment Bindings

| Binding                    | Type            | Description                                          |
| -------------------------- | --------------- | ---------------------------------------------------- |
| `CONTROL_PLANE`            | Service binding | Fetcher to the control plane worker                  |
| `TEAMS_KV`                 | KV namespace    | Thread sessions, user preferences, activity dedup    |
| `MICROSOFT_APP_ID`         | Plain text      | Azure Bot App ID                                     |
| `MICROSOFT_APP_PASSWORD`   | Secret          | Azure Bot client secret                              |
| `MICROSOFT_TENANT_ID`      | Plain text      | Azure AD tenant ID                                   |
| `CONTROL_PLANE_URL`        | Plain text      | Control plane URL (fallback when no service binding) |
| `WEB_APP_URL`              | Plain text      | Web app URL for session links                        |
| `DEFAULT_MODEL`            | Plain text      | Default model for new sessions                       |
| `CLASSIFICATION_MODEL`     | Plain text      | Model for repo classification                        |
| `ANTHROPIC_API_KEY`        | Secret          | API key for the LLM classifier                       |
| `INTERNAL_CALLBACK_SECRET` | Secret          | HMAC auth for control plane requests and callbacks   |

## API Endpoints

| Endpoint              | Method | Description                            |
| --------------------- | ------ | -------------------------------------- |
| `/health`             | GET    | Health check (includes repo count)     |
| `/api/messages`       | POST   | Bot Framework messaging endpoint       |
| `/callbacks/complete` | POST   | Completion callback from control plane |

## Development

```bash
# Install dependencies (from repo root)
npm install

# Build
npm run build -w @open-inspect/teams-bot

# Type check
npm run typecheck -w @open-inspect/teams-bot

# Lint
npm run lint -w @open-inspect/teams-bot
```

## Package Structure

```
src/
├── index.ts                   # Hono app, message handling, session lifecycle
├── callbacks.ts               # Completion callback handler
├── logger.ts                  # Structured JSON logger
├── types/
│   └── index.ts               # Env bindings, Activity types, ThreadSession
├── adaptive-cards/
│   ├── repo-selection.ts      # Repo picker card
│   ├── model-selection.ts     # Settings card for model/effort preferences
│   ├── completion.ts          # Re-exports completion text builder
│   └── session-progress.ts    # Session progress card (unused, kept for reference)
├── classifier/
│   ├── index.ts               # LLM-based repo classifier
│   └── repos.ts               # Available repos fetcher
├── completion/
│   ├── cards.ts               # Plain text completion message builder
│   └── extractor.ts           # Agent response extractor from session events
└── utils/
    ├── teams-client.ts        # Bot Framework REST API client (send replies, typing)
    ├── jwt-validator.ts       # Bot Framework JWT validation
    ├── internal.ts            # HMAC token generation
    └── repo.ts                # Repo URL parser
```
