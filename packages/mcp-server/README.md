# @open-inspect/mcp-server

MCP server over the Open-Inspect control plane. Runs locally over stdio so an MCP client — Claude
Code, an IDE — can inspect sessions, create and run automations, and manage skills, without the web
UI.

## Security model

Requests authenticate with a **personal access token** you issue to yourself in the web UI. Three
properties make this safe to keep on a laptop:

- **It is yours, and it says so.** The control plane resolves the token to your canonical user id,
  so every request it makes is attributable to a person rather than to an anonymous service. Routes
  that scope their answers to a viewer scope them to you, and the token carries exactly your role's
  permissions — no more, and no less than your browser session would.
- **It reads anywhere your role allows, and writes only where a route invites it.** An access-token
  principal is refused every method but `GET`/`HEAD` unless the route declares `accessTokenWrites`
  in its own policy, whatever else that route allows (`principalMayUseMethod` in control-plane
  `auth/principal.ts`). Six routes declare it — skill import and re-import plus their previews,
  automation create, and manual automation trigger — so the tools below can create and update
  skills, and create and run automations. Every one of the six is additive: it adds a skill
  revision, an automation, or a run. A leaked token still cannot issue a `DELETE /sessions/:id`, a
  `PUT /secrets`, a `DELETE /skills/:id`, or a `DELETE /automations/:id`, and cannot rewrite, pause,
  or resume an automation that already exists.

  Safe methods are the default rather than a route allowlist because every mutating route is already
  a non-GET, while an allowlist would fail open for each read route added later. The exceptions are
  declared one route at a time and enumerated by a test in `router.policy.test.ts`, so adding a
  seventh is a visible change rather than a quiet one.

- **You can revoke it yourself, immediately.** Settings → Access Tokens → Revoke. No deploy, no
  Terraform apply. A token also cannot mint another token: `/access-tokens` is a human-only route,
  so a leaked credential cannot issue itself a successor to survive its own revocation.

Importing a skill needs `skills.manage`, which is an administrator or owner grant. A token whose
owner holds a lesser role reads fine and is refused the import with `permission_required`. Creating
an automation needs `automations.create`, and triggering one `automations.trigger` — scoped, so a
token reaches the automations its owner may run and no others. An automation targeting repositories
or environments faces the same `repositories.use` and `environments.use` checks its owner would.

The control plane stores only a SHA-256 hash of the token, so a database read cannot recover a
working credential.

Two limits worth knowing. Human-only routes — `GET /sessions/:id` and `sandbox-access`, the latter
of which mints credentials — are deliberately out of reach; a token that could reach them would be a
larger credential than the one it replaces. And the token sits in plaintext in your MCP client
config, like any local API key. That is the reason its writes are confined to six declared routes,
its reads and writes alike are bounded by your role, and it is revocable in one click.

One consequence worth weighing before you issue a token to a machine you do not control: an
automation is instructions that run later, in a sandbox, as you. A token that can create and trigger
one can therefore schedule work in your name — bounded by your role and your targets, visible in the
dashboard, and stoppable by deleting the automation, which the token itself cannot do.

## Setup

Issue a token in the web UI: **Settings → Access Tokens → New Token**. Name it after the machine it
will live on, pick an expiry, and copy the value — it is shown once and never again.

Build the server:

```bash
npm run build -w @open-inspect/shared
npm run build -w @open-inspect/mcp-server
```

Register it with your MCP client, from the repository root:

```bash
claude mcp add open-inspect \
  --env OPEN_INSPECT_CONTROL_PLANE_URL=https://<your-control-plane> \
  --env OPEN_INSPECT_TOKEN=oi_pat_... \
  -- node /absolute/path/to/packages/mcp-server/dist/index.js
```

| Variable                         | Purpose                               |
| -------------------------------- | ------------------------------------- |
| `OPEN_INSPECT_CONTROL_PLANE_URL` | Control plane worker URL (`https://`) |
| `OPEN_INSPECT_TOKEN`             | Personal access token (`oi_pat_…`)    |

Both are required; the process exits with a message on stderr if either is missing. The URL must be
`https://`, because the token travels in an `Authorization` header on every request; plain `http://`
is accepted only for a loopback host (`localhost`, `127.0.0.1`, `[::1]`), where the request never
leaves the machine. Anything else is refused at startup rather than on the first call. A `401` from
any tool means the token was rejected — mistyped, revoked, or expired. Issue a new one and update
the client config.

Note that `claude mcp add` does not validate that `--env` values are non-empty. If you populate them
from a command, check that the command actually printed something first.

## Tools

| Tool                    | Route                              | Use                                             |
| ----------------------- | ---------------------------------- | ----------------------------------------------- |
| `list_sessions`         | `GET /sessions`                    | find a session id                               |
| `get_session_events`    | `GET /sessions/:id/events`         | what a session did, and where it went wrong     |
| `get_session_messages`  | `GET /sessions/:id/messages`       | prompts and responses without tool detail       |
| `get_session_diff`      | `GET /sessions/:id/diff`           | the changes a session produced                  |
| `list_automation_runs`  | `GET /automations/:id/invocations` | did a scheduled automation fire, skip, or fail  |
| `get_automation_run`    | `GET /automations/:id/runs/:runId` | one run and the sessions it launched            |
| `create_automation`     | `POST /automations`                | schedule or wire up new recurring work          |
| `trigger_automation`    | `POST /automations/:id/trigger`    | run one now, outside its schedule               |
| `list_skills`           | `GET /skills`                      | find a skill id, and where it was imported from |
| `import_skill_from_git` | `POST /skills/import`              | create a skill from a repository                |
| `update_skill_from_git` | `POST /skills/:id/reimport`        | re-import a skill from its recorded source      |

`get_session_events`, `get_session_messages` and `list_skills` are paged — pass the cursor from a
response back to continue.

There is no `list_automations`: `GET /automations` is a read this credential may make, but no tool
wraps it yet, so an automation id comes from `create_automation` or from the dashboard.

### The two automation writes

- `create_automation` takes a name, instructions, and a trigger. The default trigger is `schedule`,
  which wants a `schedule_cron` and the `schedule_tz` it is read in — the timezone defaults to UTC,
  which is rarely the hour anyone means, so pass your own. Event-driven triggers (`github_event`,
  `linear_event`, `slack_event`, `sentry`, `webhook`) want an `event_type` and usually a
  `trigger_config` of conditions; that argument reuses the control plane's own condition schema, so
  the client shows the real shape. A `sentry` trigger additionally needs `sentry_client_secret` —
  Sentry's own secret for the webhook it will call — and is refused without one. A `webhook`
  automation returns the key that calls it, shown this once and never again.

  The automation is created **enabled**, so a schedule starts firing at the next occurrence of its
  cron. This credential cannot edit or pause one afterwards, so create it with the schedule it
  should keep; a mistake is corrected in the web UI, or by creating a replacement.

- `trigger_automation` runs one now, outside its schedule, and returns the invocation id and the
  sessions it launched — follow those with `get_automation_run` or `get_session_events`. It leaves
  the schedule alone: a manual run is an extra run, not a replacement for the next one. It fails
  with 409 while a run of that automation is already active, and does not queue behind it.

### The two skill writes

Both run the control plane's preview-then-confirm handshake inside one tool call. The preview
resolves the ref to a commit and digests what it read; the confirmation sends those digests back,
and the control plane refuses to store anything that no longer matches.

**That handshake covers the source moving between the two requests, and nothing else — it is not the
web UI's preview screen.** Your MCP client asks for approval before the tool runs, so what it shows
you is the repository and ref being requested, never the content that comes back. Skill content
already sitting at the ref you approve is stored without anyone having read it, and a managed skill
is loaded into later sessions. Approve a ref the way you would approve running code from it; where
you want to read the content first, import it through the web UI instead.

- `import_skill_from_git` takes a repository, an optional `ref` and `subdirectory`, and optional
  `assignments` — omit those and the skill is stored but no session loads it. It refuses a name that
  already exists rather than writing, and points you at the update tool.
- `update_skill_from_git` takes a skill id and an optional `ref`. The repository and subdirectory
  come from the skill's recorded provenance, so only the ref may move. It pins the write to the
  revision it read with `If-Match`, so a concurrent edit fails the re-import rather than being
  overwritten, and reports `revisionCreated: false` when the source had not changed. A skill
  authored in the editor has no recorded source and is refused. Because it reads the skill before
  writing it, this tool needs `skills.read` as well as `skills.manage` — the built-in administrator
  and owner roles carry both, but a custom role granting `skills.manage` alone is refused at that
  read.

Both report the skill's provenance **as stored**, which is not always what was previewed: when a ref
has advanced but the generated revision bytes are identical, the re-import keeps the revision it had
along with the commit that revision was recorded at, and reports `revisionCreated: false`.

Neither tool deletes anything: a re-import adds a revision, and the previous content stays in the
skill's history.

The read routes already carried a policy that accepts this credential. The routes this package's
writes required a policy change for are the four skill imports (`SKILLS_IMPORT` in control-plane
`routes/skills.ts`), `POST /automations` in `routes/automation-crud.ts`, and
`POST /automations/:id/trigger` in `routes/automation-lifecycle.ts`.

## Development

```bash
npm test -w @open-inspect/mcp-server
npm run typecheck -w @open-inspect/mcp-server
```

Control-plane coverage for the credential itself lives in
`packages/control-plane/test/integration/access-tokens.test.ts`, which exercises the real D1 path:
read-only enforcement, the scoped import exception and the roles that may use it, expiry,
revocation, and the human-only guard on `/access-tokens`.
