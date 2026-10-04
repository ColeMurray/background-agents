# Authenticated local preview

Run the changed Next application, its real BFF, and the real Node control plane without OAuth,
production credentials, Docker, or a model/provider sandbox. Authentication, authorization, Teams
enforcement, SQLite migrations, session commands, event persistence and client WebSockets are real.
Only GitHub and the sandbox protocol peer are fixtures. The launcher lives in `packages/preview`.

## Start

Use the Node version in `.nvmrc` and run `npm ci` once. For interactive agent use, install the
`agent-browser` version pinned in `packages/sandbox-images/toolchain.json` and Chrome. The
OpenInspect image already provides them. The preview does not install or upgrade tools. Cold
dependency/font/browser setup needs network access; this is not an offline installation guarantee.

```bash
npm run preview -- --scenario populated --persona member --browser agent-browser
```

Keep this foreground command alive. In an agent terminal, use its persistent-execution/session
handle so the shell returns control while the process runs. Subsequent browser commands run in
separate tool calls. In a conventional terminal, leave it open and use a second terminal. Stop with
Ctrl-C, or SIGTERM to the `pid` in the `ready` line; do not kill processes by port or terminate all
browsers.

The final JSON `ready` line on stdout contains the URLs, run directory, user IDs, scenario aliases,
the Teams mode, [sign-in links](#sign-in-from-any-browser) and the named `browserSession` the
launcher opened. Do not interpret an intermediate `stage` line or a screenshot as successful
verification. The default persona is **member**, not owner.

```bash
# No launcher-owned browser; sign in from your own browser or a Playwright client instead.
npm run preview -- --scenario empty --browser none

# Continue using the session printed by the launcher.
agent-browser --session oi-preview-RUN-member snapshot -i
agent-browser --session oi-preview-RUN-member screenshot /absolute/path/preview.png

# Another persona gets its own named session, opened at that persona's sign-in link.
agent-browser --session oi-preview-RUN-viewer open "<signInLinks.viewer from the ready line>"
```

The launcher closes only the session it opened; close any session you open yourself. Cookies are
host-scoped, not port-scoped: each run/persona needs a distinct browser context. Keep the original
environment for the existing screenshot/video uploader; the nested application's environment
intentionally excludes outer-session upload credentials.

## Scenarios, personas and Teams

- `empty`: one selectable repository (`preview-org/preview-app`), `main` and `feature/preview`
  branches, current model defaults, and no completed conversation. Selecting a target can warm a
  real draft.
- `populated` (default): additionally creates a completed conversation through real commands and
  scripted sandbox events. `aliases.completedSession` and `aliases.completedMessage` identify it.
- `member`, `owner`, `viewer`: active canonical users with the named role.
- `suspended`: identifiable member whose protected operations are denied.
- `expired`: expired credential; `anonymous`: no credential.
- `--teams on|shadow|off` (default `on`) sets `TEAMS_ENFORCEMENT`. `on` is what fresh deployments
  run; use `shadow` to reproduce a deployment that is still rolling Teams out. The scenarios seed no
  teams, so sessions are teamless and workspace-visible; create teams through the UI to verify
  team-owned behavior.

The sandbox peer emits cumulative text updates followed by completion. It does not execute the
prompt. Ordinary inactivity uses the real preservation policy, stops the peer, and restores a new
generation on the next prompt. Unsupported upstream requests fail visibly; there is no live
GitHub/provider fallback. Model-account lists are intentionally empty.

Sessions refuse OpenAI and xAI models without a credential, so both scenarios store inert
`OPENAI_API_KEY` and `XAI_API_KEY` global secrets through the real secrets API; Anthropic's inert
key is deployment config. Every model in the picker can therefore start a turn. To see the
missing-credential error instead, delete those secrets under Settings → Secrets.

## Sign in from any browser

The launcher prints one sign-in link per persona to stderr; the `ready` line carries the same links
as `signInLinks`:

```text
Sign in from any browser on this machine until this preview stops:
  member     http://127.0.0.1:52363/as/member?k=…
  owner      http://127.0.0.1:52363/as/owner?k=…
  …
```

Opening a link sets that persona's login cookie and redirects to the app, so an everyday browser,
Playwright, agent-browser or any other browser tool signs in the same way. Open another link to
switch persona; `expired` and `anonymous` sign the browser out. Each open mints a fresh session, so
a link also signs a browser back in after sign-out; a browser that signs out stays signed out until
it opens a link again.

The links are served by a small loopback server that the launcher owns, not by the web app or the
control plane; production builds contain none of it. Every link carries a random per-run key, the
server answers only its own `Host` header, and it stops with the preview. A link can only sign in to
that run's throwaway database with that run's random secret, so it is worthless anywhere else.
Still, treat the links as credentials while the run is alive.

The login cookie is set for `127.0.0.1` and, like any cookie, reaches every port on that host. Each
preview has its own database and secret, so two previews never share a valid login; they share one
cookie slot, and signing in to one signs the browser out of the other. Use a separate browser
profile or context per preview; the same applies to another app on `127.0.0.1` that uses this cookie
name. `localhost` keeps separate cookies.

## Verify a change

1. Open as member; check that repository/model controls work.
2. Submit through the UI, observe streaming and completion, then reload and check persisted history.
3. Edit frontend source normally and verify Next hot reload reflects it.
4. Open viewer separately and verify both read-only presentation and server-side mutation denial.
5. Use the actual sign-out menu. The home page shows its sign-in link and protected APIs return 401.
6. Capture evidence, recording scenario/persona, Teams mode, source revision, interaction and
   result.

```bash
# Install the pinned test browser once, then run every preview check: the contract tests (fixtures,
# auth, ownership, the real idle/resume regression), then the real-stack browser regressions.
npx playwright install chromium
npm run test:preview
```

The browser suite runs the real launcher once, as a subprocess, and drives it through its `ready`
line and the fake Modal peer's `/__smoke/hold`, `/__smoke/release` and `/__smoke/state` endpoints.
It uses one worker, no retries and no mocked first-party APIs; each test signs fresh browser
contexts in through sign-in links. Its last test presses Ctrl-C twice and requires a clean exit, so
a fixture failure anywhere in the run fails the suite. The idle regression in the contract tests
uses a short inactivity configuration but retains the real scheduler's minimum recheck interval, so
it takes roughly half a minute.

## Ownership, reset and errors

Only one preview may own a checkout. Use separate git worktrees for concurrent tasks. The launcher
owns its Next child, host, fixture peers, temporary SQLite files, the agent-browser session it
opened and the sign-in link server. It never edits `.env.local`, resets tracked source or attaches
to an existing server. Next would load `packages/web`'s development `.env` files into its server, so
the launcher blanks every key those files name, following symbolic links as Next does, and then sets
only the preview's own values. Runtime credentials are independently generated and expire after four
hours; the launcher also exits at that bound. Stop and rerun to reset everything.

The run directory is private (0700) and removed when the run stops. Treat its raw logs as sensitive;
do not commit or upload it. The CI job uploads only failure screenshots for three days, not traces,
databases, raw logs or cookies.

On failure, the launcher retains a bounded diagnostic at `.preview/last-failure.log` (0600),
including the original error, cleanup causes and the tail of the Next log. Known fixture secrets are
redacted; review it before sharing, since application changes may log other sensitive data.
Temporary databases and raw logs are still removed. The next failure overwrites this diagnostic.

- **Preflight:** run `npm ci`, use the supported Node/browser version, or select `--browser none`.
- **Checkout lock:** `.preview/lock.json` records the owning launcher's PID. A lock whose process
  has exited (for example after SIGKILL) is taken over automatically; one whose process still runs
  stops the start. Stop that preview first.
- **Next:** if another `next dev` already serves `packages/web`, Next refuses to start and the
  launcher reports its exit with the log tail. Stop the other server.
- **Port collision:** the launcher picks free ports just before use. If another process takes one in
  between, startup fails; rerun it.
- **Auth/web:** check the reported stage. The BFF must resolve the expected canonical member; do not
  add a bypass or copy production cookies.
- **Fixture:** add only the concrete upstream contract required by the UI being verified. An
  unexpected request is a failure even if application background code catches it.
- **Shutdown:** an abandoned task is reported as a failure, not silently marked clean. After orderly
  cleanup finishes, a five-second deadline exits unsuccessfully if application handles still keep
  the process alive.

## What this proves—and does not

This is local browser/BFF/auth/RBAC/Teams/persistence/WebSocket evidence for the working tree. It
does **not** verify OAuth, account linking, a real model, sandbox execution, provider snapshot
semantics, S3/R2, Workers runtime parity, deployment origins or production readiness. Keep the
existing Workers, production build and Compose suites. A real-provider canary is a separate
workflow. Do not present local evidence as remote sandbox verification.
