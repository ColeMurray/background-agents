# Linear Agent Integration with Control Plane

The Linear agent requires changes to the control plane to support callback routing.

## Control Plane Changes

### 1. Add `LINEAR_BOT` service binding to `Env` (types.ts)

```typescript
LINEAR_BOT?: Fetcher; // Optional - only if linear-bot is deployed
```

### 2. Add `"linear"` to `MessageSource` (types.ts)

```typescript
export type MessageSource = "web" | "slack" | "linear" | "extension" | "github";
```

### 3. Generic callback routing (durable-object.ts)

The `notifyCallbackClient()` method routes based on the `source` field of the message:

- `"linear"` → `LINEAR_BOT` service binding
- `"slack"` → `SLACK_BOT` service binding
- default → `SLACK_BOT` (backward compat)

### 4. Relaxed `callbackContext` type (durable-object.ts)

Changed from Slack-specific interface to `Record<string, unknown>` so any integration can pass its
own context (e.g. `agentSessionId` for Linear agent activities).

### 5. Repository query includes `source` (repository.ts)

`getMessageCallbackContext()` now returns `{ callback_context, source }` for routing.

## Linear Agent Architecture

### Authentication

- OAuth2 with `actor=app` installs the agent identity per workspace
- Client credentials must be enabled on the Linear OAuth application
- The client ID and secret mint 30-day app-actor runtime tokens
- Verified runtime tokens are cached in KV at `oauth:client-credentials:{orgId}`
- Missing, near-expiry, or explicitly rejected tokens are replaced automatically; no refresh token
  is maintained
- No personal API key is needed for normal Agent API delivery. `LINEAR_API_KEY` remains an optional
  legacy fallback for posting a completion comment when an old callback lacks Agent API context.

For existing deployments, enable **Client credentials tokens** in **Linear Settings → API →
Applications** before deploying this credential mode. Eligible single-workspace installations
transition on their next request without uninstalling or reinstalling the app. The issued token's
viewer organization must match the webhook organization.

### Agent Session Lifecycle

1. User @mentions or assigns the agent → Linear sends `AgentSessionEvent`
2. Agent emits `Thought` activities (visible as "thinking" in Linear)
3. Agent creates Open-Inspect session and sends prompt
4. Agent emits a `Thought` with the session link while work continues
5. On completion callback, agent emits `Response` with PR link

### Callback Context

The `callbackContext` is stored on every queued message, including follow-ups. It includes the
`agentSessionId`, `organizationId`, and installed `appUserId` so completion can verify the runtime
credential and emit `AgentActivity` on the correct Linear session. It also carries issue, model,
optional repository/settings, and tool-progress fields needed by callback delivery.

Callback context is message-scoped rather than inherited by the control plane. A producer that
queues a follow-up must attach it again; otherwise the control plane has no safe callback
destination and intentionally skips completion delivery.

## Terraform Variables

| Variable                | Description                     |
| ----------------------- | ------------------------------- |
| `linear_client_id`      | OAuth Application Client ID     |
| `linear_client_secret`  | OAuth Application Client Secret |
| `linear_webhook_secret` | Webhook Signing Secret          |

The old `linear_api_key` variable is optional and retained only for backward compatibility. It is
not included in the tfvars example and is not used for normal Agent API delivery.
