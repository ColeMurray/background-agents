# Sandbox Provider Models: Modal vs Daytona vs E2B

How each sandbox backend **injects per-session environment** and **manages the sandbox lifecycle**,
with the findings from bringing up the E2B backend.

> The same `packages/sandbox-runtime` supervisor (`python -m sandbox_runtime.entrypoint`) runs
> inside the sandbox on **all three** backends. It reads its per-session config from environment
> variables (`SANDBOX_ID`, `CONTROL_PLANE_URL`, `SANDBOX_AUTH_TOKEN`, `REPO_OWNER`/`REPO_NAME`,
> `SESSION_CONFIG`, user secrets), clones the repo, runs `.openinspect/{setup,start}.sh`, starts
> OpenCode (`:4096`) and the optional code-server/ttyd sidecars, then starts the **bridge** that
> dials out to the control plane over WebSocket. Every provider builds the **same env map** (each
> provider's `buildEnvVars`); they differ only in _how that map is delivered_ and _how the
> entrypoint comes to run_.
>
> Git auth is **not** in that env map: no provider injects a clone token. The supervisor's git
> credential helper mints fresh credentials per-request from the control plane
> (`POST /sessions/:id/scm-credentials`), so long-running and resumed sessions never break on an
> expired GitHub App installation token.

## TL;DR

|                                     | **Modal**                    | **Daytona**                             | **E2B**                                |
| ----------------------------------- | ---------------------------- | --------------------------------------- | -------------------------------------- |
| Env delivery                        | `env=` in `Sandbox.create()` | `env` in `POST /sandbox`                | **file via envd `/files`** (see below) |
| Entrypoint runs                     | per create (fresh spawn)     | per sandbox start (snapshot entrypoint) | **build-time, snapshotted & resumed**  |
| Per-session env reaches entrypoint? | ✅ direct                    | ✅ direct                               | ❌ → workaround required               |
| Resume model                        | snapshot → **new** sandbox   | stop/start **same** sandbox             | pause/connect **same** sandbox         |
| `supportsSnapshots`                 | ✅                           | ❌                                      | ❌                                     |
| `supportsRestore`                   | ✅                           | ❌                                      | ❌                                     |
| `supportsWarm` (pool)               | ✅                           | ❌                                      | ❌                                     |
| `supportsPersistentResume`          | ❌                           | ✅                                      | ✅                                     |
| `supportsExplicitStop`              | ❌                           | ✅                                      | ✅                                     |
| Repo-image prebuild                 | ✅ (Modal-only)              | ❌                                      | ❌                                     |
| Idle handling                       | snapshot + shutdown          | provider stop                           | **pause** (not kill)                   |

The capability flags are declared in each provider's `capabilities` object
(`packages/control-plane/src/sandbox/providers/*.ts`).

---

## Modal

**Env injection.** `modal-provider.ts` forwards `userEnvVars` to `ModalClient` (`client.ts`), which
POSTs `user_env_vars` to the Modal data plane. `modal-infra` (`manager.py`) builds the final env
dict (user vars first, system vars override) and passes it **together with the entrypoint command in
one create call**:

```python
# packages/modal-infra/src/sandbox/manager.py
sandbox = await modal.Sandbox.create.aio(
    "python", "-m", "sandbox_runtime.entrypoint",   # entrypoint
    image=image, app=app, secrets=[llm_secrets],
    timeout=config.timeout_seconds, workdir="/workspace",
    env=env_vars,                                    # per-session env
)
```

**Lifecycle.** Every session is a **fresh container spawn**. There is no persistent resume: instead
Modal supports **filesystem snapshots** — `take_snapshot()` calls
`modal_sandbox.snapshot_filesystem()` → an immutable `Image`; `restore_from_snapshot()` creates a
**new** sandbox from that image (sets `RESTORED_FROM_SNAPSHOT=true` so the supervisor skips the
clone). Idle/heartbeat-stale → `triggerSnapshot()` + WebSocket `shutdown`.

**Extras (Modal-only).** A **warm pool** (`warm_sandbox`/`maintain_warm_pool`) pre-spawns sandboxes
per repo, and **repo-image prebuild** bakes a repo's deps into an `Image`
(`repoImageId`/`repoImageSha` → `modal.Image.from_id(...)`, `FROM_REPO_IMAGE=true`). Both are gated
to Modal — the repo-image routes return HTTP 501 for other backends.

---

## Daytona

**Env injection.** `daytona-provider.ts` builds the env map and passes it as the `env` field of
`POST /sandbox`. The base **snapshot** declares the entrypoint, which Daytona runs **on every
sandbox start** with that env in the process environment:

```python
# packages/daytona-infra/src/toolchain.py
daytona.snapshot.create(CreateSnapshotParams(
    name=snapshot_name, image=image,
    entrypoint=["python", "-m", "sandbox_runtime.entrypoint"],
))
```

**Lifecycle (persistent resume).** One long-lived sandbox per session, paused/resumed in place:

| Op      | Daytona REST                 | Notes                                 |
| ------- | ---------------------------- | ------------------------------------- |
| create  | `POST /sandbox`              | from `baseSnapshot`, with `env`       |
| resume  | `POST /sandbox/{id}/start`   | covers stopped/archived               |
| recover | `POST /sandbox/{id}/recover` | error/build_failed when `recoverable` |
| stop    | `POST /sandbox/{id}/stop`    | pause (state preserved)               |
| get     | `GET /sandbox/{id}`          | reads `state` + `recoverable`         |

Idle/heartbeat-stale → `stopSandbox` (a pause, since Daytona preserves state).

---

## E2B — and why it's the odd one out

**The constraint.** E2B's template **start command runs once at the end of the template _build_, is
snapshotted with the process already running, and is _resumed_ on each create — it never re-executes
per sandbox, and create-time env vars are NOT visible to it.** (E2B docs, _Start & ready commands_;
verified by boot tests this session.) So a supervisor-as-start-command can never see
`CONTROL_PLANE_URL` / `SESSION_CONFIG` / the auth token — they're per-session.

**Why E2B's "global" env doesn't rescue it.** E2B has three env mechanisms (`Sandbox.create({envs})`
"global", `run_code({envs})`, `commands.run({envs})`) — and all three inject env **at the moment
envd spawns a new process**. None mutate an already-running process (a hard Linux rule: environ is
fixed at `exec`). The start command is the one process envd does _not_ spawn after create (it's
thawed from the build snapshot), so it's the only process none of them reach. Proven directly: with
create-time globals set, the supervisor's `/proc/<pid>/environ` contained **only** what our launcher
fed it — not the globals.

**Two valid shapes** (both proven end-to-end from a plain `fetch`, i.e. Worker-compatible):

- **A — file-drop + launcher (current / shipped).** The control plane writes the session env as a
  JSON file via envd's **documented** REST filesystem API
  (`POST https://49983-{id}.e2b.app/files?path=/tmp/oi-session.env&username=user`, multipart). A
  baked-in launcher (`packages/e2b-infra/oi-launch.py`, the template start command) polls for that
  file, loads it, and `exec`s the supervisor with the merged env.
- **B — `commands.run` after create (alternative).** Template start command is a no-op; the control
  plane spawns the supervisor via envd's **internal Connect RPC** (`POST /process.Process/Start`,
  `application/connect+json`, a 5-byte length-prefixed JSON frame
  `{process:{cmd,args,envs},stdin}`). The supervisor, being envd-spawned, inherits the create-time
  global env — so env injection reads exactly like Modal/Daytona.

**Why A is shipped.** Both work. A rides a **documented, stable REST** surface; B rides an
**undocumented codegen'd RPC** (we'd hardcode the proto message shape, which could drift on an
`envd` upgrade). A's cost is one extra artifact (the launcher); B's cost is the fragile dependency.
The `e2b` JS SDK is **not** an option in the control-plane Worker (it pulls
`undici`/`tar`/`glob`/`fs`). If E2B ships a Workers-compatible SDK or documents the process API,
switching A→B is small: drop the launcher, no-op the start command, move `writeSessionEnv` → create
`envVars` + one `commands.run`.

**Lifecycle.** Pause/connect on one long-lived sandbox:

| Op        | E2B REST                         | Notes                                             |
| --------- | -------------------------------- | ------------------------------------------------- |
| create    | `POST /sandboxes`                | `autoPause:false`; then `writeSessionEnv`         |
| resume    | `POST /sandboxes/{id}/connect`   | resumes a paused sandbox; `/resume` is deprecated |
| set TTL   | `POST /sandboxes/{id}/timeout`   | re-assert TTL on a running sandbox                |
| keepalive | `POST /sandboxes/{id}/refreshes` | TTL refresh, **max 3600s**                        |
| pause     | `POST /sandboxes/{id}/pause`     | idle/heartbeat-stale → pause (state preserved)    |
| kill      | `DELETE /sandboxes/{id}`         | connecting-timeout / operator stop                |
| get       | `GET /sandboxes/{id}`            | reads `state` (running/paused/killed)             |

**E2B-specific lifecycle wiring** (optional `SandboxProvider` hooks, no-ops for Modal/Daytona):

- `onUserActivity` → TTL refresh on activity (awaited through the activity path so workerd doesn't
  GC it). Hobby TTL ≤ 3600s, so refresh uses `/refreshes`.
- `pauseSandbox` → idle/heartbeat-stale **pause instead of kill** (the manager's
  `pauseOrStopProviderSandbox` prefers it; connecting-timeout/operator-stop still kill).
- `shouldResetRuntime` → E2B caps **continuous** runtime (≈1h on Hobby) and TTL refresh **cannot**
  extend past it; the alarm handler pause/resume-cycles the sandbox to reset the counter.
  **Required** on Hobby for sessions > ~55 min.

**Key E2B runtime gotchas (from boot-testing).** E2B runs the start command via a login shell **as
non-root `user`** (HOME=`/home/user`), and **does not propagate Docker `ENV`**. So the
template/launcher must: set `PYTHONPATH=/app`, `NODE_PATH`, and **`HOME=/home/user`** (else
opencode/code-server hit `EACCES` on `/root/.local`); `chmod 1777 /workspace` `/tmp/opencode`;
install bun to `/usr/local` (not `/root/.bun`). Resume survival is confirmed: a live supervisor +
opencode survive `pause → connect` intact.

### Repo-image prebuilds on E2B (designed, not yet wired)

E2B can support repo-image prebuilds (Modal/Vercel feature) via **template builds**, not
snapshot-forks. Direct vendor guidance (call, 2026-06-04): templates are the optimized path —
creates are "dramatically faster" and snapshots have ~10x the storage footprint ("try not to use
snapshots"); the last build step + start command are memory-snapshotted, so the `oi-launch` poller
is baked in already armed.

**Verified live via REST with the runtime `E2B_API_KEY`** (2026-06-04; client methods in
`e2b-rest-client.ts`, all unit-tested):

1. `POST /v3/templates {name: "oi-repo-{owner}-{repo}"}` → `{templateID, buildID}` — POSTing an
   existing name re-targets that template (atomic image replacement).
2. `POST /v2/templates/{tid}/builds/{bid}` with `fromTemplate: <base template>` (base layer is
   **cached** — incremental), `steps: [RUN clone, RUN setup, RUN scrub-credentials]`, and the same
   `startCmd`/`readyCmd` as the base (must be re-declared per build).
3. Poll `GET /templates/{tid}/builds/{bid}/status` until `ready` (probe build: 32s for a trivial
   delta). No callback exists — the Worker's `scheduled()` cron handler is the natural poll driver
   (sweep `repo_images` rows in `building` for the e2b backend).
4. Pre-warm: spawn + kill one sandbox (first-spawn-slow bug; `build-template.py` does this for the
   base template already).
5. Sessions then pass the template name as `repoImageId` → `POST /sandboxes` — the probe confirmed a
   session env drop starts the supervisor on such a template within seconds.

**Build runs on E2B's remote builder — no control-plane secrets ever enter a sandbox** (unlike the
Vercel flow, which injects its API token + callback secret into the build sandbox's env). The only
secret in the build is the clone token inside a `RUN` step.

**Known caveats / open questions:**

- `RUN` step args (incl. any clone token) are echoed **verbatim into build logs**, retrievable later
  via the API. Mitigation: GitHub App installation tokens expire in 1h and logs are team-private —
  same trust model as Modal's builder. Scrub the token from `.git/config` in a final `RUN` step
  regardless.
- Same-name rebuild re-targets the template (same `templateID`, new `buildID` — verified), but
  whether in-flight sandbox creates resolve the **old** build until the new one is `ready` is
  unverified. Check before shipping.
- Whether `startCmd`/`readyCmd` are inherited when omitted from a `fromTemplate` build is unverified
  — we always re-declare them, which is deterministic either way.
- Route wiring (`repo-images.ts`) is deliberately deferred: upstream PR #700 restructures it from
  modal-only to per-backend dispatch (`requireRepoImages`/`getRepoImageBackend`); the e2b arm should
  be added on top of that after rebase.

---

## Pre-existing bug noticed (all backends)

`packages/sandbox-runtime/src/sandbox_runtime/log_config.py` — `_report_fatal_error` calls
`log.error("supervisor.fatal", message=...)`, and `message` collides with `LogRecord`'s reserved
field → `KeyError: "Attempt to overwrite 'message' in LogRecord"`. Not E2B-specific; it masks
fatal-error reporting on every backend. Worth a separate fix.
