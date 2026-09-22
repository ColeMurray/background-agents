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

The final JSON `ready` line contains the URL, private manifest path, named browser session and
scenario IDs. Do not interpret an intermediate startup stage or a screenshot as successful
verification. The default persona is **member**, not owner.

```bash
# No interactive browser; useful for local Playwright clients.
npm run preview -- --scenario empty --browser none

# Open a separate read-only context in an existing run.
npm run preview:open -- --run /absolute/path/from-ready/run.json --persona viewer

# Continue using the exact session printed by the launcher; do not re-import cookies.
agent-browser --session oi-preview-RUN-member snapshot -i
agent-browser --session oi-preview-RUN-member screenshot /absolute/path/preview.png
```

The first open imports that persona's auth state once. Later opens do **not** log it back in after
logout or expiry. A failed initial import stays explicitly unverified; stop and restart the preview
before retrying. Do not use `--restore`, a human profile, the default agent session, or an outer
session's CDP browser. Cookies are host-scoped, not port-scoped: each run/persona needs a distinct
browser context. Keep the original environment for the existing screenshot/video uploader; the
nested application's environment intentionally excludes outer-session upload credentials.

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
The launcher owns its Next child, host, fixture peers, temporary SQLite files, auth state, and named
browser contexts. It never edits `.env.local`, resets tracked source or attaches to an existing
server. Runtime credentials are independently generated and expire after four hours; the coordinator
also exits at that bound. Stop and rerun to reset everything.

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

Verified on branch `authenticated-preview`, based on `fab55fea1`, with the working-tree changes:

- Control-plane unit/contracts: **5,084 passed**, including **44** focused preview/auth/Node-host
  contracts. Web unit tests: **1,805 passed**.
- Workers integration: **1,320 passed, 1 skipped**. An initial concurrent run had one timeout; the
  affected file passed separately, then the full suite passed with `--maxWorkers=2`.
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
- Independent testing/simplicity review led to three focused fixes: pending-versus-verified browser
  handoff, bounded exit after cleanup, and surviving sanitized diagnostics. Each has a regression
  test; no additional framework was introduced.

Docker Compose smoke subsequently **passed** after the local Docker daemon became available: 79
migrations, authenticated session/WebSocket round-trip, exact prompt delivery, streamed reply and
completion, scheduler tick, Litestream replication, clean SIGTERM drain, and rejection of a missing
required key. It used a separate Compose project and ports; its containers, network and volumes were
removed, the prior local image tag was restored, and the existing development stack remained
healthy. OAuth and real-provider behavior remain outside this evidence.
