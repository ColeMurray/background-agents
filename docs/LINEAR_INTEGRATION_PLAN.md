# Linear Integration: Critique, Improvements & Implementation Plan

This document reviews the proposed Linear integration strategy, suggests improvements, and outlines
a phased implementation plan aligned with the existing codebase.

**Phase 1 implemented**: Control plane (Linear client, schema, routes, DO), Modal (optional linear
context in session config), web app (task linking, create issue with **team required in UI**),
Terraform `linear_api_key` (optional). Set `LINEAR_API_KEY` via Terraform `linear_api_key` in tfvars
to enable; omit or leave empty to disable Linear (API returns 503).

---

## Testing the Linear integration

### 1. Get a Linear API key

1. In Linear: **Settings → API** (or **Security & access → Personal API keys**).
2. Create a personal API key and copy it.

### 2. Configure the control plane

**Terraform (same as your other secrets):**

- Add to your `terraform.tfvars` (in `terraform/environments/production/` or your env):
  ```hcl
  linear_api_key = "lin_api_..."
  ```
- Run `terraform apply`. Terraform passes `LINEAR_API_KEY` to the control-plane worker; no need to
  set it in the Cloudflare dashboard or wrangler.

**Only if you run the control plane locally** (e.g. `wrangler dev` without Terraform): use
`.dev.vars` or your local env so the worker has `LINEAR_API_KEY`. For normal deployed setups,
Terraform is enough.

### 3. Run the web app

- Start the web app (e.g. `npm run dev` in `packages/web`).
- Ensure `.env` has:
  - `CONTROL_PLANE_URL` = your control plane base URL (e.g.
    `https://open-inspect-control-plane.xxx.workers.dev` or `http://localhost:8787` for local).
  - `INTERNAL_CALLBACK_SECRET` = same value as on the control plane.
  - `NEXT_PUBLIC_WS_URL` = same host as control plane, with `wss://` (or `ws://` for local).

### 4. Test in the UI

1. **Create a session** (repo, then start session).
2. **Link session to an existing Linear issue** (optional, no agent required):
   - In the right sidebar under **Metadata**, click **Link to Linear**.
   - Choose a **Team**, then pick an **Issue** and click **Link**. The sidebar shows “Linked to
     Linear” and the link updates live (no refresh needed). Use **Change** to pick a different issue
     or **Unlink** to clear.
   - When a session has a linked issue and you spawn a sandbox, the control plane passes that
     issue’s context into the sandbox so the agent can see it.
3. **Task-level linking** (after the agent emits TodoWrite):
   - Send a prompt that leads to tasks (e.g. “Break this into a short task list and do the first
     one”). Wait until the agent emits at least one **TodoWrite** so the right sidebar shows a
     **Tasks** section.
   - Under a task, click **Link to Linear** → choose **Team** and an issue → **Link**; or **Create
     issue** → choose **Team**, optionally edit title/description → **Create**.
   - **Refresh the page** so the task shows the Linear badge/link (task-level links are reflected
     after refresh).
4. **Session-level link + sandbox context**
   - If a session has a linked Linear issue and you spawn a sandbox, the control plane fetches the
     issue and passes optional `linear` context into the Modal session config so the agent can see
     the issue (e.g. title/description).

### Troubleshooting

- **“Linear integration not configured”** or **503** on Linear routes: control plane has no
  `LINEAR_API_KEY` or it’s empty. Set it as above.
- **Teams or issues don’t load**: Check browser Network tab for `/api/linear/teams` or
  `/api/linear/issues`; if 401, auth (NextAuth session) is missing; if 503, control plane Linear
  config is missing or Linear API key is invalid.
- **Link/Create succeeds but badge doesn’t show**: State is updated on the server; **refresh the
  page** to refetch session state and see the new link.
- **Tasks section never appears (no TodoWrite tasks)**:
  1. **Check Modal logs** so the bridge can be debugged:
     ```bash
     cd packages/modal-infra && modal app logs open-inspect
     ```
     (Use your app name if different.) Reproduce the run (send a prompt that should trigger
     TodoWrite), then look for:
     - `[bridge] Tool part: tool=...` — confirms the bridge saw a tool part; check `has_todos=True`
       for TodoWrite.
     - `[bridge] Skipping tool_call (no input yet): part_keys=..., state_keys=...` — part arrived
       without args; if you see this for `todo_write`/`TodoWrite`, OpenCode may be sending args in a
       different shape (share `part_keys`/`state_keys` to adjust the bridge).
     - `[bridge] Sent event: tool_call` — bridge did send a tool_call; if tasks still don’t show,
       the issue is downstream (control plane or web app).
  2. Ensure the agent actually uses the TodoWrite tool (e.g. “Break this into a short task list and
     do the first one” and confirm in the agent UI that a todo_write/TodoWrite call appears).
  3. Refresh the session page after the run so the client gets the latest events from the control
     plane.

---

## 1. Critique of the Original Plan

### What works well

- **Layering**: Control plane as the single place that talks to Linear (web + Slack go through it)
  is correct and matches the existing repo/GitHub pattern.
- **Session-centric**: Linking at session level and optionally at task level fits how the app is
  used.
- **Scenarios**: Link existing issue, create from task, and “assign work via Linear” are the right
  user stories.

### Gaps and issues

1. **Task identity**  
   Tasks in this codebase are **not first-class entities**. They are derived at runtime from the
   **latest `TodoWrite` tool_call** in events (see `packages/web/src/lib/tasks.ts`). There is no
   stable task ID in the DB.
   - Storing `linear_issue_id` on the **events** table is wrong: one `TodoWrite` event carries
     **multiple** tasks (a `todos` array).
   - We need a clear way to refer to “this specific task” when linking or creating a Linear issue.
     That implies a **task-level link table** keyed by something stable (e.g. `message_id` +
     `event_id` + task index).

2. **Auth ambiguity**  
   The plan mentions both “Linear API key per workspace/team” and “POST /linear/auth - OAuth
   callback”.
   - **API key**: org-level, good for single-tenant / automation (e.g. one key in Terraform).
   - **OAuth**: needed if each user connects “their” Linear workspace or we act on their behalf.
   - Control plane has no global “user” table; it has **participants per session**. So “user’s
     Linear token” must live either in the **web app** (NextAuth/session) and be sent per request,
     or in **KV keyed by userId** (encrypted).  
     Recommendation: **Phase 1 = single API key** (simplest, matches single-tenant). **Phase 2 =
     OAuth** with token in KV per userId if you need per-user Linear.

3. **Where to store Linear credentials**
   - **Org-level API key**: Terraform secret → Worker env (e.g. `LINEAR_API_KEY`), no DO/KV needed.
   - **Per-user OAuth**: Store encrypted token in **KV** (e.g. `linear:user:{userId}`), not in the
     session DO, so it’s reusable across sessions.

4. **“Assign agent work in Linear” (Linear → Open-Inspect)**  
   Detecting “issue tagged with @open-inspect” via webhook/polling and auto-creating a session is a
   **separate, larger feature** (Linear webhooks, queue, mapping issue → repo/branch). Better as
   **Phase 2 or 3**; Phase 1 should focus on **Open-Inspect → Linear** (link, create, update).

5. **Modal sandbox**  
   No need for a **new** Modal secret for Linear. The control plane already has the API key (or user
   token); the sandbox only needs **metadata** (e.g. linked issue id/title/url) passed in session
   config so the agent can reference it. Session config is already passed when the sandbox starts;
   extend that payload with optional Linear context.

6. **Naming**  
   Align route names with existing style:
   - Prefer **kebab-case** and consistency with `/repos`, `/sessions/:id/...`:
     - `GET /linear/issues`, `POST /linear/link-task`, `POST /linear/create-issue`,
       `PATCH /linear/issues/:id`
   - “link-task” should be **session-scoped** and include which task (message_id + event_id +
     task_index).

7. **Rate limits**  
   Linear has rate limits (e.g. 500 req/h OAuth, 1500 req/h API key). The control plane should:
   - Use a small in-memory or KV-backed throttle for Linear calls, and
   - Return clear errors when rate limited so the UI can show “try again later”.

---

## 2. Improved Design Choices

### 2.1 Task–Linear linking model

- **Session-level (optional)**
  - `session.linear_issue_id` (and optionally `linear_team_id` for default team when creating
    issues).
  - Meaning: “this session is about this Linear issue” (e.g. one issue per session).

- **Task-level (for multiple tasks per session)**
  - New table **`task_linear_links`** in the session DO’s SQLite:

    ```sql
    CREATE TABLE task_linear_links (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL,
      event_id TEXT NOT NULL,
      task_index INTEGER NOT NULL,
      linear_issue_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE(message_id, event_id, task_index)
    );
    ```

  - **Stable task reference**: `(message_id, event_id, task_index)`.
    - `event_id` = the `events.id` of the **TodoWrite** tool_call that contains this task.
    - `task_index` = index in that event’s `todos` array (0-based).
  - Frontend gets `event_id` from the events list (e.g. latest TodoWrite) and task index from the
    task list; when linking or creating a Linear issue, it sends these so the control plane can
    store or resolve the link.

- **No `linear_issue_id` on `events`**
  - One event = one TodoWrite = many tasks; so a single column on `events` is insufficient. The link
    table above is the single source of truth.

### 2.2 Auth strategy (recommended)

| Phase            | Auth                                                | Use case                                                                                                                           |
| ---------------- | --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| **1**            | Single **LINEAR_API_KEY** in Terraform → Worker env | Single-tenant; all Linear actions use one workspace.                                                                               |
| **2** (optional) | **OAuth** + encrypted token in KV keyed by `userId` | Each user connects their own Linear; control plane uses token per request (web sends `userId`, control plane loads token from KV). |

- **Phase 1**: No `/linear/auth` callback; no token storage in DO. Just `LINEAR_API_KEY` and
  optionally a **default team id** (env or session-level) for “create issue”.

### 2.3 API surface (control plane)

- **List issues** (for picker): `GET /linear/issues?team=...&query=...&cursor=...`
  - Uses API key (or user token in Phase 2). Return normalized list (id, title, state, url, team).

- **Link task to existing issue**: `POST /sessions/:id/linear/link-task`
  - Body: `{ messageId, eventId, taskIndex, linearIssueId }`.
  - Validates session, optional check that issue exists in Linear, then inserts into
    `task_linear_links` in the session DO.

- **Create Linear issue from task**: `POST /sessions/:id/linear/create-issue`
  - Body: `{ messageId, eventId, taskIndex, teamId, title?, description? }`.
  - Creates issue in Linear (title/description from task or overrides), then inserts same row into
    `task_linear_links`. Returns created issue + link.

- **Update Linear issue**: `PATCH /linear/issues/:id`
  - Body: `{ state?, assignee?, ... }`.
  - Used e.g. to move issue to “Done” when task is completed. Can be called by web or by control
    plane when processing completion (optional automation).

- **Session-level link**: Optional.
  - e.g. `PATCH /sessions/:id` or `PUT /sessions/:id/linear` with `{ linearIssueId }` to set
    `session.linear_issue_id`.
  - Useful for “this whole session is for Linear issue X”.

### 2.4 Modal sandbox

- **No new secret.**
- **Session config**: When the control plane starts a sandbox, it already sends repo, branch, etc.
  Add optional:

  ```ts
  linear?: {
    issueId: string;
    title: string;
    url: string;
    description?: string;  // optional, for context
  }
  ```

  So the agent (and UI) can show “Linked to Linear: TASK-123” and use title/description in context.

- **Optional**: When a **message** is linked to a Linear issue (session-level or task-level for the
  “current” task), include that in the prompt or system context so the agent knows the issue.

### 2.5 Web app

- **Tasks section**:
  - For each task, show a **Linear badge** (and link) when a row exists in `task_linear_links` for
    `(messageId, eventId, taskIndex)`.
  - “Link to Linear” → issue picker (call `GET /linear/issues`), then `POST .../link-task`.
  - “Create Linear issue” → optional team/title/description, then `POST .../create-issue`.

- **Session header/sidebar**:
  - If `session.linear_issue_id` is set, show “Session linked to LINEAR-123” with link.

- **Sync status**:
  - Phase 1: “Sync” can mean “we have a link”; optional “Refresh” to refetch issue state from Linear
    and show it (e.g. state, assignee). No need for real-time webhooks in Phase 1.

### 2.6 Database (schema migrations in session DO)

- **Session table**:
  - `linear_issue_id TEXT`
  - `linear_team_id TEXT` (optional default team for create-issue)

- **New table**: `task_linear_links` (see above).

- **No change to `events` table** for Linear; links live in `task_linear_links`.

---

## 3. Implementation Plan

### Phase 1: Foundation (Link + Create + List)

**Goal**: Users can link a session/task to an existing Linear issue, create a Linear issue from a
task, and list issues (picker). Single API key.

1. **Secrets and env**
   - Add `LINEAR_API_KEY` to Terraform (and Worker env).
   - Optionally `LINEAR_DEFAULT_TEAM_ID` for “create issue” default.

2. **Control plane – Linear client**
   - New module `packages/control-plane/src/linear/client.ts`:
     - `listIssues(env, opts)`, `createIssue(env, body)`, `updateIssue(env, id, body)`,
       `getIssue(env, id)` using Linear GraphQL API and `LINEAR_API_KEY`.
   - Keep requests minimal; add simple retry/backoff and respect rate limits (return 429-style
     errors).

3. **Control plane – Schema**
   - In `session/schema.ts`:
     - Migration: `ALTER TABLE session ADD COLUMN linear_issue_id TEXT`,
       `ADD COLUMN linear_team_id TEXT`.
     - Migration: create `task_linear_links` table (see above).
   - In `session/durable-object.ts`:
     - On init, run new migrations.
     - Add internal handlers: `internal/linear/link-task`, `internal/linear/create-issue`, read
       `session.linear_issue_id` / `linear_team_id` and `task_linear_links` for state.

4. **Control plane – Routes**
   - `GET /linear/issues` → uses Linear client, returns list (for picker).
   - `POST /sessions/:id/linear/link-task` → body `messageId, eventId, taskIndex, linearIssueId` →
     call DO `internal/linear/link-task`.
   - `POST /sessions/:id/linear/create-issue` → body
     `messageId, eventId, taskIndex, teamId?, title?, description?` → create in Linear, then DO
     `internal/linear/link-task`.
   - `PATCH /linear/issues/:id` → proxy to Linear client (update state/assignee/etc.).
   - Optional: `PUT /sessions/:id/linear` or extend `PATCH /sessions/:id` to set
     `session.linear_issue_id` and `linear_team_id`.

5. **Control plane – Session state**
   - Include in `internal/state` (and thus in GET session): `linearIssueId`, `linearTeamId`, and
     either full `taskLinearLinks` or a summary so the web app can render badges.

6. **Web app – Types and API**
   - Extend session type with `linearIssueId?`, `linearTeamId?`, and
     `taskLinearLinks?: { messageId, eventId, taskIndex, linearIssueId }[]`.
   - In `lib/control-plane.ts` (or a small `linear.ts`): `listLinearIssues()`,
     `linkTaskToLinear(sessionId, payload)`, `createLinearIssueFromTask(sessionId, payload)`,
     `updateLinearIssue(id, body)`.

7. **Web app – Tasks section**
   - Extend task extraction so each task has a stable key: in `lib/tasks.ts`, have
     `extractLatestTasks` return tasks that include `messageId`, `eventId` (the TodoWrite event id),
     and `taskIndex` (index in that event's `todos` array). Extend the `Task` type in
     `types/session.ts` with optional `messageId?`, `eventId?`, `taskIndex?` so the UI can call
     link-task and create-issue with the correct payload. You’ll need to pass `messageId` and
     `eventId` into the task list (e.g. from the latest TodoWrite event).
   - If `taskLinearLinks` contains that key, show Linear badge + link.
   - Add “Link to Linear” (opens issue picker → `link-task`) and “Create Linear issue” (optional
     form → `create-issue`).

8. **Web app – Session header**
   - If `session.linearIssueId` is set, show “Linked to &lt;issue&gt;” with link.

9. **Modal**
   - When starting sandbox, if `session.linear_issue_id` is set (or a “primary” task link), fetch
     issue title/url (and optionally description) from Linear, add to session config as
     `linear: { issueId, title, url, description? }`.
   - No new secrets; no agent-side Linear API calls unless you later add a “Linear tool” for the
     agent.

10. **KV index**
    - If you store session list in KV, include `linearIssueId` in the session summary so the list
      view can show a Linear badge per session (optional).

### Phase 2: OAuth + Per-user Linear (optional)

- Register a Linear OAuth app; add `LINEAR_CLIENT_ID`, `LINEAR_CLIENT_SECRET`, and redirect URL.
- **Web**: “Connect Linear” → redirect to Linear OAuth; callback hits control plane (or web API
  route that then calls control plane) with code; exchange for token; store encrypted in KV
  `linear:user:{userId}`.
- **Control plane**: New route `GET /linear/me` or accept `Authorization: Bearer <userJwt>` and
  resolve userId; load token from KV; use it for `GET /linear/issues` and for create/update when
  “acting as user”.
- **Token refresh**: Linear supports refresh tokens; store both and refresh when needed (similar to
  GitHub token handling in the DO).

### Phase 3: Linear → Open-Inspect (“Assign work via Linear”)

- Linear **webhooks** or **polling** for issues with a specific label (e.g. `open-inspect`).
- When such an issue is created/updated, enqueue or directly create a session with `linear_issue_id`
  set and optional prompt from issue title/description.
- Requires: mapping from Linear workspace/team to repo (config or rules), and possibly a queue (e.g.
  Cloudflare Queue) so webhook handler is fast and session creation is async.

---

## 4. Multi-tenant: What Changes

When the app becomes **multi-tenant**, each customer (org/team) gets isolated data and their own
integrations. Below is what must change **app-wide** and **Linear-specific**, so the Linear work
stays compatible.

### 4.1 Tenant identity

- **Define a tenant**  
  A tenant is the unit of isolation (e.g. one company, one Linear workspace, one set of repos). You
  need a stable **tenant id** (e.g. `tenant_acme`, or a UUID).

- **How the control plane knows the tenant**  
  One of (or a combination of):

  | Approach         | How                                                                          | Use case                                                              |
  | ---------------- | ---------------------------------------------------------------------------- | --------------------------------------------------------------------- |
  | **Subdomain**    | `acme.open-inspect.example.com` → tenant = `acme`                            | One subdomain per customer; Worker reads `request.url` / hostname.    |
  | **Header**       | `X-Tenant-ID: acme` (or `Authorization: Bearer <JWT>` with tenant in claims) | Web/Slack send tenant after resolving it from the user’s session/org. |
  | **From session** | For routes that have `sessionId`, load session → read `tenant_id`            | No tenant in URL/header; session is already tenant-scoped.            |

  For **session-scoped routes** (e.g. `POST /sessions/:id/linear/link-task`): resolve tenant from
  the **session** (session row has `tenant_id`). That way the caller cannot switch tenants by
  changing a header.  
  For **session-less routes** (e.g. `GET /linear/issues`): tenant must come from **auth** (header or
  JWT). The web app must send the current org/tenant on every request.

### 4.2 App-wide schema and storage

- **Session**
  - Add **`tenant_id TEXT NOT NULL`** to the session table (and to the payload when creating a
    session).
  - Session creation must require `tenant_id` (from auth/header). All session access should enforce
    that the authenticated context matches `session.tenant_id`.

- **KV session index**
  - Today: key = `session:{sessionId}`.
  - Multi-tenant: key = **`tenant:{tenantId}:session:{sessionId}`** (or `session:{sessionId}` with
    `tenant_id` in the value).
  - Prefer the **prefix** form so “list sessions for tenant” is a single prefix list
    (`tenant:{tenantId}:session:`).

- **List sessions**
  - Require tenant (from auth). List only keys with prefix `tenant:{tenantId}:session:` (or filter
    by `tenant_id` if stored in value).

- **Repos / GitHub**
  - Multi-tenant usually means **one GitHub App installation per tenant** (each tenant installs the
    app on their org).
  - Control plane then needs **per-tenant GitHub App credentials** (e.g. in KV
    `github:tenant:{tenantId}` or env per tenant).
  - Repo list and repo metadata become tenant-scoped (e.g. KV keys
    `tenant:{tenantId}:repo:metadata:{key}` if metadata is per-tenant).

- **Auth**
  - HMAC (e.g. `INTERNAL_CALLBACK_SECRET`) is shared today. For multi-tenant you either keep one
    secret and **require tenant in every request**, or use **per-tenant secrets** / JWTs that encode
    tenant.
  - Web app: after login, “current org/tenant” is in the session; when calling the control plane,
    send tenant (header or JWT).

### 4.3 Linear-specific multi-tenant changes

- **Credentials per tenant**
  - No single **LINEAR_API_KEY** in env. Each tenant has its own Linear workspace and thus its own
    credentials.
  - Store in **KV**: e.g. **`linear:tenant:{tenantId}`** with value = encrypted API key or OAuth
    token (and refresh token if OAuth).
  - Resolve tenant on every Linear call (from session or from auth), then **load credentials for
    that tenant** and call the Linear API.

- **Resolving tenant for Linear routes**
  - **`GET /linear/issues`** (no session): tenant must come from **request** (header or JWT). Use it
    to load `linear:tenant:{tenantId}` and list issues.
  - **`POST /sessions/:id/linear/link-task`**, **`POST /sessions/:id/linear/create-issue`**: get
    session from DO; read **`session.tenant_id`**; use that to load Linear credentials. Do **not**
    trust a tenant header for mutation routes—always derive from the session so users cannot link to
    another tenant’s Linear.
  - **`PATCH /linear/issues/:id`**: either require session context (e.g. session id in body/query)
    to get tenant, or require tenant in auth (JWT/header) and validate that the issue belongs to
    that workspace (e.g. by fetching the issue and checking workspace).

- **OAuth per tenant**
  - “Connect Linear” is typically **one connection per tenant** (org admin connects the workspace).
  - Flow: redirect to Linear OAuth with state that includes **tenantId**; callback exchanges code
    and stores token in **`linear:tenant:{tenantId}`**.
  - No need for **per-user** Linear tokens unless you want “each user’s Linear” inside a tenant; for
    most B2B setups, **per-tenant** is enough.

- **Session and task_linear_links**
  - No schema change needed: `session.linear_issue_id`, `task_linear_links`, etc. stay as-is. They
    are already per-session; the only change is that **which Linear credentials we use** is
    determined by `session.tenant_id`.

### 4.4 Summary table (multi-tenant)

| Area                                 | Single-tenant (current plan) | Multi-tenant change                                                           |
| ------------------------------------ | ---------------------------- | ----------------------------------------------------------------------------- |
| **Tenant**                           | Implicit (one)               | Explicit `tenant_id`; from subdomain/header/JWT or from session.              |
| **Session**                          | No tenant column             | Add `tenant_id`; creation and list scoped by tenant.                          |
| **KV session index**                 | `session:{id}`               | `tenant:{tenantId}:session:{id}` (or value includes tenant_id).               |
| **Linear credentials**               | One `LINEAR_API_KEY` in env  | KV `linear:tenant:{tenantId}` (API key or OAuth token, encrypted).            |
| **Linear: list issues**              | Use env API key              | Resolve tenant from request → load KV → use that token.                       |
| **Linear: link-task / create-issue** | Use env API key              | Resolve tenant from **session** → load KV → use that token.                   |
| **Repos**                            | One GitHub App installation  | Per-tenant installation + per-tenant credentials (e.g. KV or env).            |
| **Auth**                             | One HMAC secret              | Same or per-tenant; every request must carry tenant (or derive from session). |

### 4.5 Implementation order

1. **Introduce tenant_id** in the app: session table, session creation, KV index key shape, list
   sessions filtered by tenant. Ensure every request that creates or lists sessions has a tenant
   (from subdomain/header/JWT).
2. **Linear**: switch from single `LINEAR_API_KEY` to **per-tenant credentials in KV**. For
   session-scoped Linear routes, resolve tenant from session; for `GET /linear/issues`, require
   tenant in auth and load from KV.
3. **GitHub/repos**: move to per-tenant GitHub App credentials and tenant-scoped repo list/metadata
   when you’re ready.
4. **OAuth**: if you want “Connect Linear” per tenant, add the OAuth flow and store the token in
   `linear:tenant:{tenantId}`.

Designing Phase 1 Linear with **tenant_id in mind** (e.g. session table and KV keys from day one)
avoids a second migration when you add multi-tenancy; you can still run with a single default tenant
until the full multi-tenant UX is in place.

---

## 5. Summary

- **Original plan** is directionally right; the main fixes are: (1) **task identity** via a
  dedicated `task_linear_links` table keyed by `(message_id, event_id, task_index)`, (2) **auth**
  clarified as API key first, OAuth later, (3) **no `linear_issue_id` on events**, (4) **Linear →
  Open-Inspect** deferred to a later phase, (5) **Modal** only gets optional Linear context in
  config, no new secret.
- **Phase 1** delivers: link session/task to Linear, create issue from task, list issues (picker),
  and optional session-level default issue + basic “sync” display. That is enough to validate the
  integration and iterate on UX (e.g. when to update Linear state on task completion) before adding
  OAuth and reverse flow (Linear → sessions).

- **Multi-tenant**: When you move to multi-tenancy, add `tenant_id` to sessions and KV index; store
  Linear credentials per tenant in KV (`linear:tenant:{tenantId}`); resolve tenant from session for
  session-scoped Linear routes and from auth (header/JWT) for session-less routes like
  `GET /linear/issues`. See §4 Multi-tenant: What Changes for the full checklist.
