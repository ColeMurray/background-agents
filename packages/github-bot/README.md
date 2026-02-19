# GitHub Bot

A stateless Cloudflare Worker that translates GitHub webhook events into Open-Inspect coding agent
sessions. It provides two capabilities:

1. **Code Review** — Assign the bot as a PR reviewer; it performs an automated code review and
   submits structured feedback.
2. **Comment-Triggered Actions** — @mention the bot in a PR comment; it reads the PR context and
   executes the requested action (typically making code changes and pushing commits).

The bot is a **webhook-to-session translator** — it verifies webhooks, posts an acknowledgment
reaction, creates a session via the control plane, and sends a prompt. The agent in the sandbox
handles all GitHub interaction (posting reviews, comments, pushing code) directly using the `gh`
CLI.

## Architecture

```
                 ┌─────────────┐
                 │   GitHub    │
                 │  Webhooks   │
                 └──────┬──────┘
                        │ POST /webhooks/github
                        v
                 ┌──────────────┐   service binding    ┌─────────────────┐
                 │  GitHub Bot  │ ───────────────────>  │  Control Plane  │
                 │   Worker     │                       │    Worker       │
                 └──────┬───────┘                       └────────┬────────┘
                  eyes  │                                        │
               reaction │                                        │ DO / D1
                        v                                        v
                 ┌──────────────┐                         ┌──────────────┐
                 │   GitHub     │  <─── gh CLI ─────────  │    Modal     │
                 │   REST API   │                         │   Sandbox    │
                 └──────────────┘                         └──────────────┘
```

Key design decisions:

- **Unidirectional service binding**: The bot calls the control plane to create sessions and send
  prompts. There is no reverse binding — the agent posts results to GitHub directly from the
  sandbox.
- **No session reuse**: Every webhook event creates a fresh session. Git provides continuity (the
  agent clones the latest branch state). No KV state, no TTLs, no staleness.
- **No PR context fetching**: The bot only uses metadata already in the webhook payload. The agent
  gathers additional context (diffs, prior comments, file contents) itself using `gh` CLI.

## Deployment

The bot is deployed via Terraform as a standalone Cloudflare Worker alongside the existing workers.

**Two-phase deployment** (same pattern as the Slack bot):

1. Deploy with `enable_service_bindings = false` (creates the worker)
2. Set `enable_service_bindings = true` and apply again (adds the `CONTROL_PLANE` binding)

### Environment Bindings

| Binding                      | Type                  | Description                                                                         |
| ---------------------------- | --------------------- | ----------------------------------------------------------------------------------- |
| `CONTROL_PLANE`              | Service binding       | Fetcher to the control plane worker                                                 |
| `DEPLOYMENT_NAME`            | Plain text            | Deployment identifier for logging                                                   |
| `DEFAULT_MODEL`              | Plain text            | Model ID for new sessions (e.g., `anthropic/claude-haiku-4-5`)                      |
| `GITHUB_BOT_USERNAME`        | Plain text            | Bot's GitHub login (e.g., `my-app[bot]`) for @mention detection and loop prevention |
| `GITHUB_APP_ID`              | Secret                | GitHub App ID for JWT generation                                                    |
| `GITHUB_APP_PRIVATE_KEY`     | Secret                | GitHub App private key (must be PKCS#8 format)                                      |
| `GITHUB_APP_INSTALLATION_ID` | Secret                | GitHub App installation ID for token exchange                                       |
| `GITHUB_WEBHOOK_SECRET`      | Secret                | Shared secret for verifying webhook signatures                                      |
| `INTERNAL_CALLBACK_SECRET`   | Secret                | Shared secret for HMAC auth to the control plane                                    |
| `LOG_LEVEL`                  | Plain text (optional) | Log level override (`debug`, `info`, `warn`, `error`)                               |

### GitHub App Configuration

The existing GitHub App needs these additions:

**Permissions**: `Pull requests: Read & write`, `Issues: Read & write`

**Event subscriptions**: `Pull request`, `Issue comment`, `Pull request review comment`

**Webhook URL**: `https://open-inspect-github-bot-{suffix}.{account}.workers.dev/webhooks/github`

**Webhook secret**: Must match `GITHUB_WEBHOOK_SECRET` in the Terraform configuration.

### Sandbox Prerequisites

For the agent to interact with GitHub from the sandbox, two prerequisites must be met:

1. **`gh` CLI** installed in the Modal sandbox image (`packages/modal-infra/src/images/base.py`)
2. **`GITHUB_TOKEN`** injected as an environment variable at sandbox spawn time by the lifecycle
   manager

## Webhook Events

| Event                         | Action             | Trigger                     | Handler                   |
| ----------------------------- | ------------------ | --------------------------- | ------------------------- |
| `pull_request`                | `opened`           | Non-draft PR opened         | `handlePullRequestOpened` |
| `pull_request`                | `review_requested` | Bot assigned as reviewer    | `handleReviewRequested`   |
| `issue_comment`               | `created`          | @mention in a PR comment    | `handleIssueComment`      |
| `pull_request_review_comment` | `created`          | @mention in a review thread | `handleReviewComment`     |

All events are processed asynchronously via `executionCtx.waitUntil()`. The webhook endpoint returns
200 immediately after signature verification.

### Handler Flows

**Pull Request Opened (Auto-Review):**

1. Check `pull_request.draft` — skip draft PRs
2. Check `pull_request.user.login !== GITHUB_BOT_USERNAME` — prevent loops on bot-created PRs
3. Post eyes reaction on the PR (fire-and-forget)
4. Create session via control plane
5. Send code review prompt (includes PR metadata + `gh` CLI instructions)

**Review Requested:**

1. Check `requested_reviewer.login` matches `GITHUB_BOT_USERNAME` — return early if not
2. Post eyes reaction on the PR (fire-and-forget)
3. Create session via control plane
4. Send code review prompt (includes PR metadata + `gh` CLI instructions)

**Issue Comment:**

1. Check `issue.pull_request` exists — ignore non-PR comments
2. Check comment body contains `@{GITHUB_BOT_USERNAME}` — ignore if no mention
3. Check `sender.login !== GITHUB_BOT_USERNAME` — prevent loops
4. Strip @mention, post eyes reaction, create session, send comment action prompt

**Review Comment:** Same as issue comment, but the prompt additionally includes `filePath`,
`diffHunk`, and `commentId` for thread-specific context and reply threading.

## Authentication

### Webhook Verification

Incoming webhooks are verified using HMAC-SHA256 with `GITHUB_WEBHOOK_SECRET`:

1. Compute `HMAC-SHA256(secret, raw_body)`
2. Compare against `X-Hub-Signature-256` header using constant-time comparison
3. Reject with 401 on mismatch

### GitHub App Tokens

The bot generates a GitHub App installation token for posting acknowledgment reactions:

```
Private key → JWT (RS256, 10-min expiry) → Installation access token (1-hour TTL)
```

The token generation code is duplicated from the control plane (`src/auth/github-app.ts`) rather
than extracted to `@open-inspect/shared`, because it uses Cloudflare Workers' `crypto.subtle` API
for RSA key import.

### Control Plane Auth

Requests to the control plane use HMAC tokens generated from `INTERNAL_CALLBACK_SECRET` (same
mechanism as the Slack bot). The token is sent as a `Bearer` token in the `Authorization` header.

## Prompt Construction

Two prompt templates in `src/prompts.ts`:

**`buildCodeReviewPrompt`** — Includes PR title, body, author, branches, and instructions to:

- Run `gh pr diff` for the full diff
- Submit a review via `gh api .../reviews`
- Post inline comments via `gh api .../comments`

**`buildCommentActionPrompt`** — Includes the user's request (with @mention stripped) and
instructions to:

- Check prior conversation via `gh pr view --comments`
- Make code changes and push, or respond with analysis
- Post a summary comment via `gh api .../issues/{n}/comments`
- Reply to a specific review thread (when `commentId` is present)

The prompts embed only metadata from the webhook payload. The agent gathers everything else.

## Observability

All log entries are structured JSON with `trace_id` for cross-service correlation:

```
GitHub webhook → Bot (trace_id generated) → Control plane (trace_id in x-trace-id header) → Sandbox
```

Key log events:

| Event                       | Level | When                                       |
| --------------------------- | ----- | ------------------------------------------ |
| `webhook.received`          | info  | Webhook arrives (event type, repo, action) |
| `webhook.signature_invalid` | warn  | Signature verification fails               |
| `webhook.ignored`           | debug | Event doesn't match any handler            |
| `session.created`           | info  | Session created via control plane          |
| `prompt.sent`               | info  | Prompt delivered to session                |
| `acknowledgment.posted`     | debug | Eyes reaction posted                       |
| `acknowledgment.failed`     | warn  | Reaction failed (non-blocking)             |

## Development

```bash
# Install dependencies (from repo root)
npm install

# Build
npm run build -w @open-inspect/github-bot

# Run tests (46 tests)
npm run test -w @open-inspect/github-bot

# Type check
npm run typecheck -w @open-inspect/github-bot

# Lint
npm run lint -w @open-inspect/github-bot
```

Tests run in Node.js via Vitest (no `@cloudflare/vitest-pool-workers` needed — the bot has no
Durable Objects or D1). All tests are deterministic and run without network access.

## Package Structure

```
src/
├── index.ts          # Hono app, routes, webhook endpoint, event routing
├── types.ts          # Env bindings, webhook payload types
├── verify.ts         # HMAC-SHA256 webhook signature verification
├── handlers.ts       # Event handlers (review, issue comment, review comment)
├── prompts.ts        # Prompt construction for code review and comment actions
├── github-auth.ts    # GitHub App JWT + installation token generation, reaction posting
├── logger.ts         # Structured JSON logger (mirrors control plane format)
└── utils/
    └── internal.ts   # Re-exports generateInternalToken from @open-inspect/shared
test/
├── verify.test.ts    # Signature verification (8 tests)
├── webhook.test.ts   # Endpoint routing and integration (6 tests)
├── prompts.test.ts   # Prompt construction (10 tests)
├── github-auth.test.ts # JWT generation and reactions (7 tests)
└── handlers.test.ts  # Event handler flows and edge cases (15 tests)
```
