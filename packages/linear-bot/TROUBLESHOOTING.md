# Linear Bot Troubleshooting

End-to-end checklist for when the Linear bot is not responding to @mentions or assignments.

## 1. Webhook not reaching the worker

**Symptom:** No logs for `/webhook`; Linear shows no delivery or retries.

- **Linear app configuration**
  - In [Linear → Settings → API → Applications](https://linear.app/settings/api/applications), open
    your Open-Inspect application.
  - **Webhooks:** Enabled.
  - **Webhook URL:** `https://<your-linear-bot-worker>/webhook` (must match the deployed worker URL;
    see Terraform `workers-linear.tf` / `WORKER_URL`).
  - **Webhook events:** Ensure **Agent session events** (and optionally **Issues**, **Comments**)
    are selected.
- **Network:** Worker must be publicly reachable. If you use a custom domain, DNS must point to the
  worker.

## 2. Webhook rejected with 401 Invalid signature

**Symptom:** Logs show `reject_reason: "invalid_signature"` and HTTP 401.

- **`LINEAR_WEBHOOK_SECRET`** must exactly match the **Webhook signing secret** in Linear (same app
  → Webhooks section). If you rotated the secret in Linear, update the secret in Terraform /
  `wrangler secret put LINEAR_WEBHOOK_SECRET`.
- The worker verifies the **raw request body** with HMAC-SHA256. Do not modify the body before
  verification (e.g. no middleware that parses JSON before the handler).
- Header used: `linear-signature` (hex-encoded HMAC-SHA256 of the body).

## 3. Webhook returns 200 but no session / no agent activity

The worker returns `200` immediately and processes the event in the background. If nothing happens
in Linear (no “Thinking…”, no session link), work through the following.

### 3.1 OAuth not installed for the workspace

**Symptom:** Logs show `agent_session.no_oauth_token` for your `organizationId`.

- The agent runs **per Linear workspace**. Each workspace must install the app once via OAuth.
- **Fix:** Have an admin open `https://<your-linear-bot-worker>/oauth/authorize` in the browser and
  complete the flow. After that, the worker stores a token in KV for that `organizationId` and can
  emit activities and create sessions.
- **Check:** If you have access to KV, look for a key like `oauth:token:<organizationId>` (value =
  JSON with `access_token`, `refresh_token`, `expires_at`).

### 3.2 Control plane auth (INTERNAL_CALLBACK_SECRET)

**Symptom:** Session creation or integration settings fail with 401 from the control plane; logs may
show `control_plane.create_session` or similar with `http_status: 401`.

- The linear bot calls the control plane with an HMAC bearer token generated from
  **`INTERNAL_CALLBACK_SECRET`**.
- **Same secret everywhere:** The **exact same** value must be set for:
  - **Linear bot:** Terraform `internal_callback_secret` (or
    `wrangler secret put INTERNAL_CALLBACK_SECRET`).
  - **Control plane:** Terraform `internal_callback_secret` (or equivalent secret name).
- If one side was rotated and the other was not, all internal calls (session create, prompt,
  integration settings, callbacks) will return 401.

### 3.3 Service binding to control plane

**Symptom:** Worker errors or timeouts when calling the control plane (e.g. “failed to fetch” or no
response).

- The linear bot uses a **service binding** named `CONTROL_PLANE` to the control plane worker.
  Requests are sent to `https://internal/sessions` etc.; the hostname is irrelevant for the binding.
- **Terraform:** In `workers-linear.tf`, `service_bindings` must point to the correct control plane
  worker name, and **`enable_service_bindings`** must be `true` in the module (and in your Terraform
  variables). If service bindings are disabled, `env.CONTROL_PLANE.fetch` may be missing or not
  wired.
- **Local dev:** With `wrangler dev`, service bindings may not resolve; use the control plane’s
  public URL and ensure the worker can reach it (and that `INTERNAL_CALLBACK_SECRET` matches).

### 3.4 Repo not resolved or not enabled

**Symptom:** Logs show `agent_session.classification_uncertain`,
`agent_session.repo_resolution_failed`, or `agent_session.repo_not_enabled`.

- **Repo resolution:** The bot resolves the GitHub repo by (in order) project→repo mapping,
  team→repo mapping, Linear’s repo suggestions, then an LLM classifier. If no mapping is set and the
  classifier is unsure, the agent will ask for clarification in Linear (elicitation).
- **Fix:** Configure a **project→repo** or **team→repo** mapping via the bot’s
  `/config/project-repos` or `/config/team-repos` endpoints (requires
  `Authorization: Bearer <internal token>`).
- **Enabled repos:** In the Open-Inspect web app, **Settings → Integrations → Linear** can restrict
  which repos the agent is allowed to use. If the resolved repo is not in the allowlist, the bot
  emits “Linear integration is not enabled for `owner/repo`”. Set enabled repos (or “all”) as
  needed.

### 3.5 Repository not installed for the GitHub App

**Symptom:** Control plane returns 404 or an error like “Repository is not installed for the GitHub
App” when creating the session.

- The **control plane** creates sessions only for repos that are installed for the same deployment’s
  GitHub App.
- **Fix:** Install the Open-Inspect GitHub App on the target repository (or org). The linear bot
  only forwards the repo; the control plane performs the install check.

### 3.6 Linear API 400 on repo suggestions

**Symptom:** Logs show `Linear API error: 400` (or `linear.repo_suggestions_failed`) from
`getRepoSuggestions` during `handleNewSession`.

- The bot calls Linear’s `issueRepositorySuggestions` GraphQL query with the list of candidate
  repos. A 400 usually means the request shape or variables are invalid for the current Linear API.
- **Check the full error message:** As of the latest version, the thrown error includes Linear’s
  response body (e.g. GraphQL `errors[].message`). Inspect logs for the exact validation message.
- The flow continues anyway: on error the bot returns no suggestions and falls back to project/team
  mapping or LLM classification. If sessions still fail, the cause is likely elsewhere (e.g. no
  mapping and classifier uncertain).
- If Linear changed the `RepositorySuggestionInput` shape or query, update `getRepoSuggestions` in
  `packages/linear-bot/src/utils/linear-client.ts` to match the
  [Linear API schema](https://studio.apollographql.com/public/Linear-API/variant/current/schema) and
  [agent docs](https://linear.app/developers/agent-interaction#repository-suggestions).

### 3.7 Other control plane errors

- **500 from control plane:** Check control plane logs and D1/DO health. Session creation can fail
  for many reasons (DB, missing env, etc.).
- **Prompt or callbacks fail:** Same auth and binding checks apply to `POST /sessions/:id/prompt`
  and to the callback URLs the control plane uses to notify the linear bot.

## 4. Quick verification

1. **Health:** `GET https://<your-linear-bot-worker>/health` →
   `{ "status": "healthy", "service": "open-inspect-linear-bot" }`.
2. **Webhook + signature:** Send a minimal `AgentSessionEvent` POST to `/webhook` with a valid
   `linear-signature` (see integration tests for how the signature is computed). Expect 200 and then
   inspect logs to see if `handleAgentSessionEvent` ran and whether it hit “no_oauth_token”, 401
   from control plane, or repo/config issues.
3. **Config (with auth):** `GET https://<your-linear-bot-worker>/config/team-repos` with
   `Authorization: Bearer <internal token>` to confirm the worker is up and auth works.

## 5. Logging

- Set **`LOG_LEVEL`** (e.g. `debug`) on the linear bot worker to see more detail (e.g.
  `webhook.skipped`, `agent_session.*`).
- In Cloudflare dashboard: Workers & Pages → your linear bot worker → Logs (Real-time or Tail) to
  inspect `trace_id` and errors.

## Summary checklist

| Check                      | What to verify                                                                       |
| -------------------------- | ------------------------------------------------------------------------------------ |
| Linear webhook URL         | Points to `https://<worker>/webhook`                                                 |
| Linear webhook events      | Agent session events enabled                                                         |
| `LINEAR_WEBHOOK_SECRET`    | Matches Linear’s webhook signing secret                                              |
| OAuth installed            | Admin completed `/oauth/authorize` for the workspace                                 |
| `INTERNAL_CALLBACK_SECRET` | Same value on linear bot and control plane                                           |
| Service binding            | `CONTROL_PLANE` bound and `enable_service_bindings` true                             |
| Repo mapping / enabled     | Project or team mapping or classifier resolves; repo in Linear integration allowlist |
| GitHub App                 | Target repo has the Open-Inspect GitHub App installed                                |
