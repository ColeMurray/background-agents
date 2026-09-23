# Authenticated local preview

Run the changed Next application, its real BFF, and the real Node control plane without OAuth,
production credentials, Docker, or a model/provider sandbox. Authentication, authorization, SQLite
migrations, session commands, event persistence and client WebSockets are real. Only GitHub and the
sandbox protocol peer are fixtures.

## Start

Use Node >=22.13.0 and run `npm ci` once. For interactive agent use, install the `agent-browser`
version pinned in `packages/sandbox-images/toolchain.json` (currently `0.37.0`) and Chrome. The
OpenInspect image already provides them. Local installation instructions are in the
[pinned agent-browser README](https://github.com/vercel-labs/agent-browser/blob/v0.37.0/README.md).
The preview does not install or upgrade tools. Cold dependency/font/browser setup needs network
access; this is not an offline installation guarantee.

```bash
npm run preview -- --scenario populated --persona member --browser agent-browser
```

Keep this foreground command alive. In an agent terminal, use its persistent-execution/session
handle so the shell returns control while the process runs. Subsequent browser commands run in
separate tool calls. In a conventional terminal, leave it open and use a second terminal. Stop with
Ctrl-C, or SIGTERM to the coordinator PID recorded in `run.json`; do not kill processes by port or
terminate all browsers.

The final JSON `ready` line contains the URL, private manifest path, named browser session, scenario
IDs and [sign-in links](#sign-in-from-any-browser). Do not interpret an intermediate startup stage
or a screenshot as successful verification. The default persona is **member**, not owner.

```bash
# No launcher-owned browser; sign in from your own browser or a Playwright client instead.
npm run preview -- --scenario empty --browser none

# Open a separate read-only context in an existing run.
npm run preview:open -- --run /absolute/path/from-ready/run.json --persona viewer

# Continue using the exact session printed by the launcher; do not re-import cookies.
agent-browser --session oi-preview-RUN-member snapshot -i
agent-browser --session oi-preview-RUN-member screenshot /absolute/path/preview.png
```

The first open imports that persona's auth state once. Later opens do **not** log it back in after
logout or expiry. A failed initial import stays explicitly unverified; stop and restart the preview
before retrying. Do not load persona state files into `--restore`, a human profile, the default
agent session, or an outer session's CDP browser; other browsers use a sign-in link instead. Cookies
are host-scoped, not port-scoped: each run/persona needs a distinct browser context. Keep the
original environment for the existing screenshot/video uploader; the nested application's
environment intentionally excludes outer-session upload credentials.

## Scenarios and personas

- `empty`: one selectable repository (`preview-org/preview-app`), `main` and `feature/preview`
  branches, current model defaults, and no completed conversation. Selecting a target can warm a
  real draft.
- `populated` (default): additionally creates a completed conversation through real commands and
  scripted sandbox events. `aliases.completedSession` and `aliases.completedMessage` identify it.
- `member`, `owner`, `viewer`: active canonical users with the named role.
- `suspended`: identifiable member whose protected operations are denied.
- `expired`: expired credential; `anonymous`: no credential.

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
Playwright or any other browser tool can use the preview without state files. Open another link to
switch persona; `expired` and `anonymous` sign the browser out. Each open mints a fresh session, so
a link also signs a browser back in after sign-out. When a check needs sign-out to stay signed out,
use the named session instead.

The links are served by a small loopback server that the launcher owns, not by the web app or the
control plane; production builds contain none of it. Every link carries a random per-run key, the
server answers only its own `Host` header, and it stops with the preview. A link can only sign in to
that run's throwaway database with that run's random secret, so it is worthless anywhere else.
Still, treat the links as credentials while the run is alive.

The login cookie is set for `127.0.0.1` and, like any cookie, reaches every port on that host. Two
previews open in one browser therefore share a login, as does another app on `127.0.0.1` that uses
the same cookie name. `localhost` keeps separate cookies.

## Verify a change

1. Open as member; check that repository/model controls work.
2. Submit through the UI, observe streaming and completion, then reload and check persisted history.
3. Edit frontend source normally and verify Next hot reload reflects it.
4. Open viewer separately and verify both read-only presentation and server-side mutation denial.
5. Use the actual sign-out menu. The home page shows its sign-in link and protected APIs return 401.
6. Capture evidence, recording scenario/persona, source revision/dirty state, interaction and
   result.

```bash
# Install the pinned test browser once, then run the real-stack browser regressions.
npx playwright install chromium
npm run test:preview

# Fast fixture/auth/ownership contracts plus the real idle/resume regression.
npm run build -w @open-inspect/shared
npm test -w @open-inspect/control-plane -- test/preview test/support
```

Browser tests use one worker, no retries, no mocked first-party APIs, and fresh state for each test.
The streaming test explicitly holds/releases the external peer; it does not race a fixed sleep. The
idle regression uses a short inactivity configuration but retains the real scheduler's minimum
recheck interval, so it takes roughly half a minute. Shutdown uses the normal Node drain budget:
recent client-auth timeout tasks can take several seconds to finish even after sockets close.

## Ownership, reset and errors

Only one Next/preview process may own a checkout. Use separate git worktrees for concurrent tasks.
The launcher owns its Next child, host, fixture peers, temporary SQLite files, auth state, named
browser contexts and sign-in link server. It never edits `.env.local`, resets tracked source or
attaches to an existing server. Next would load `packages/web/.env*` files into its server, so the
launcher blanks every key those files name and then sets only the preview's own values. Runtime
credentials are independently generated and expire after four hours; the coordinator also exits at
that bound. Stop and rerun to reset everything.

`run.json` and cookie state live in a private temporary directory (0700; state files 0600). The
manifest contains paths, IDs and timings, not bearer tokens. Treat raw logs and state as sensitive.
Do not commit or upload the run directory. The CI job uploads only failure screenshots for three
days, not traces, databases, raw logs or auth state.

On failure, the launcher retains a bounded diagnostic at `.preview/last-failure.log` (0600),
including the original error, cleanup causes and the tail of the Next log. Known fixture secrets are
redacted; review it before sharing, since application changes may log other sensitive data.
Temporary databases, cookies and raw logs are still removed. The next failure overwrites this
diagnostic.

- **Preflight:** run `npm ci`, use the supported Node/browser version, or select `--browser none`.
- **Checkout/Next lock:** stop the owning process first. Inspect `.preview/lock.json` and the named
  PID. A stale lock is not permission to kill another process. Remove only a lock whose owner you
  have verified is gone; Next owns its own `.next` locks.
- **Port collision:** startup retries a bounded number of times with new origins and state. It never
  reuses the process that won the port.
- **Auth/web:** check the reported stage. The BFF must resolve the expected canonical member; do not
  add a bypass or copy production cookies. Startup validates even when opening an anonymous or
  expired browser persona.
- **Fixture:** add only the concrete upstream contract required by the UI being verified. An
  unexpected request is a failure even if application background code catches it.
- **Shutdown:** an abandoned task is reported as a failure, not silently marked clean. After orderly
  cleanup finishes, a CLI-only five-second deadline exits unsuccessfully if application handles
  still keep the process alive.

## What this proves—and does not

This is local browser/BFF/auth/RBAC/persistence/WebSocket evidence for the working tree. It does
**not** verify OAuth, account linking, a real model, sandbox execution, provider snapshot semantics,
S3/R2, Workers runtime parity, deployment origins or production readiness. Keep the existing
Workers, production build and Compose suites. A real-provider canary is a separate workflow.

The implementation was exercised locally; a remote OpenInspect-sandbox smoke is not required for
this delivery, per the implementation scope decision. Do not present local evidence as remote
sandbox verification.

### Implementation verification — 2026-09-22

Verified on branch `authenticated-preview`, rebased onto `232bb74c5` before opening the PR:

- Control-plane unit/contracts: **5,092 passed**. Focused reruns also passed: **21**
  preview/auth-helper checks and **10** Node-host checks. Web unit tests: **1,805 passed**.
- Workers integration: **1,354 passed, 1 skipped**, with `--maxWorkers=2`. An earlier concurrent run
  on the original base had one timeout; its file and the full suite passed on rerun.
- Real-stack Playwright: **2 passed**, no retries. Deliberately breaking the BFF service secret
  produced an auth-stage 401 failure; breaking the WebSocket URL failed the connected-state
  assertion. Both faults were reverted and the clean journeys passed again.
- Hands-on `agent-browser`: canonical member, separate viewer and its real 403, prompt/completion,
  persisted reload, temporary source edit reflected by hot reload, and actual sign-out followed by
  reopening without reauthentication. The temporary source edit was restored.
- CLI stop removed its private run directory and checkout lock, closed the browser context, and
  released its application ports. Observed warm backend/web readiness was about **1.7 seconds**;
  this excludes dependency setup and browser handoff and is not a performance guarantee.
- Root typecheck, lint, formatting, and Node/Worker/web production builds passed. Node and Worker
  build metadata contained no preview/support/smoke fixture modules.
- Independent testing/simplicity review led to focused fixes: pending-versus-verified browser
  handoff, bounded exit after cleanup, and surviving sanitized diagnostics. Each has a regression
  test; no additional framework was introduced.
- A fresh pre-PR review added stop signals and request deadlines during both data seeding and web
  startup checks. Real stalled HTTP requests verify cleanup of owned servers, child processes,
  ports, run directories and locks. The GitHub fixture forwards the original request signal to
  preserve Node 22 timeout behavior. The browser logout check now proves the separate viewer's
  identity and access remain intact, rather than accepting a 200 response with no session. The
  reviewer rechecked these fixes and approved.

Docker Compose smoke **passed again on the rebased branch**: 79 migrations, authenticated
session/WebSocket round-trip, exact prompt delivery, streamed reply and completion, scheduler tick,
Litestream replication, clean SIGTERM drain, and rejection of a missing required key. It used a
separate Compose project and ports; its containers, network and volumes were removed, the prior
local image tag was restored, and the existing development stack remained healthy. OAuth and
real-provider behavior remain outside this evidence.

### Sign-in links verification — 2026-09-22

- Preview and browser-session unit tests, including the new link server and real-backend re-sign-in
  after sign-out; workerd integration files that seed browser sessions (**37 passed**).
- Real-stack Playwright: **3 passed**, no retries; the new journey signs a fresh browser context in
  as owner, signs out, signs back in, switches to viewer (real 403 on writes) and signs out as
  anonymous (401).
- Deliberately removing the `Host` check and reusing the seeded cookie instead of minting both
  failed the new tests; both changes were reverted.
- CLI with `--browser none`: links printed to stderr and `ready`, key absent from `run.json`; `curl`
  showed a 302 with the production cookie name, `HttpOnly`, `SameSite=Lax` and no `Domain`, 404 for
  a wrong key and 421 for a rebound `Host`. A fresh agent-browser session signed in, switched,
  signed out through the UI and back in. After SIGTERM the link refused connections.
- Worker and Node host production metafiles contain no `test/` modules.
