# Slice 6A report: secure lazy execution isolation boundary

## Outcome

Built the dormant execution-sandbox security boundary without exposing a Pi model tool or admitting
a provider. SessionDO remains the only lifecycle/operation authority. A future Slice 6B tool may
submit through the existing internal command ledger only after a provider has passed the recorded
canary.

## Credential boundary

- Execution generations use the existing rotating sandbox token hash but are classified as
  `execution`, require hash-only constant-time validation, expire after two hours, and are revoked
  by the existing generation fence/rotation.
- The execution credential is accepted only by the execution WebSocket. Command events, heartbeats,
  generation handshakes, and preservation stay on that socket.
- Every HTTP sandbox route is explicitly agent-only. Execution credentials are rejected from SCM,
  OpenAI/xAI/provider-account credentials, diff upload/failure, push/PR/signing,
  child/skills/memory, tunnel/media, and all public/user routes. The sandbox-error fallback also
  rejects them.
- The Modal launch path removes the token from environment and argv. It sends one bounded newline-
  terminated token through stdin to the root supervisor, which keeps the execution bridge
  in-process.

## Process and filesystem boundary

- The supervisor remains root and disables dumpability. Commands run as fixed UID/GID 10001 with no
  supplementary groups and a small environment allowlist.
- Startup fails closed unless `/proc` has `hidepid=2`, Yama `ptrace_scope >= 2`, the runtime is
  root-owned/non-writable, and the command workspace is UID/GID-owned mode 0700.
- The command user cannot traverse the root-only runtime package, `/run/open-inspect`, process-group
  registry, credential caches, or supervisor process metadata. Known home/workspace credential
  caches are cleared before the bridge reports ready.
- No code server, VNC, ttyd, browser desktop, agent harness, Docker daemon, MCP, repository hooks,
  or repository checkout starts in execution mode.

## Clean artifact and network contract

- Runtime generation is `v78-execution-isolation-boundary`. A separate `execution-v1` manifest pins
  UID/GID, stdin credential delivery, process controls, and `package-install-v1`.
- The clean image skips the agent-tools phase, removes build-only websockify tooling, installs no
  agent/desktop services, and records a distinct immutable build hash/image ID.
- The only network profile is the current control-plane host plus `registry.npmjs.org`, `pypi.org`,
  and `files.pythonhosted.org`. Git/GitHub, apt, crates, arbitrary hosts, and general egress are
  absent.
- Modal SDK 1.4.3 cannot enforce domain allowlists; OpenComputer, Daytona, Vercel, and E2B also lack
  a reviewed sandbox-layer implementation in this repository. All five adapters (including Modal VM)
  therefore report `canary_blocked` and reject execution before contacting the provider.

## Deferred to Slice 6B

No `run_shell`, `run_build`, or `run_tests` Pi tool is registered. Dispatch/ack/retry/cancellation
migration work, quotas, result projection, and model-facing UX remain unimplemented. No live
provider request or deployment was made.

## Validation evidence

- TypeScript unit suites: control plane 5,159 passed / 1 skipped; web 2,540; shared 1,306; docs 44;
  GitHub bot 335; Slack bot 655; Linear bot 317; Code Mode contracts 7.
- Workerd integration: 2,471 passed / 1 skipped. The pool emitted its known teardown/global-state
  warnings but exited successfully.
- Python: sandbox runtime 1,667 passed / 36 skipped; Modal infrastructure 565; sandbox images 78.
- Production builds, workspace type checks, ESLint, Prettier, Ruff, complexity and SQL-portability
  checks, execution artifact/provider contracts, and sandbox boundary contracts passed.
- Terraform: production 95, Modal module 2, Cloudflare Worker module 6, and AWS control-plane module
  6 tests passed; recursive format and production validation passed.
- Python dependency audit reports no known vulnerabilities after raising `aiohttp` to 3.14.5. The
  npm audit still reports pre-existing transitive denial-of-service advisories, including
  `just-bash` and Tailwind's scanner; no dependency-only breaking downgrade was applied in 6A.
- Security review found and closed malformed verifier class confusion, repository-manifest reads in
  execution readiness, predictable `/tmp` supervisor state, and incomplete artifact hashing.
