# TESTING.md — how to run the Pi harness, and what passing looks like

This is the runbook for the two layers: the **core** stack (`feat/do-harness-core`) and the
**overlay** (`compound/pi-overlay`). Every flag below is **off by default**; a deployment that turns
one on is choosing that capability, and the canary says whether it works.

Nothing here is deployed, and nothing here is pushed. The commands run against a local checkout.

---

## 1. The layers, and where each flag lives

| Layer       | Branch                 | What it adds                                                                                                                                                                                                                                                                                                                                                                                  |
| ----------- | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Core**    | `feat/do-harness-core` | The harness-neutral Durable Object harness, and Pi as its first harness. The seam (`packages/control-plane/src/harness/`), the Pi adapter (`packages/control-plane/src/pi/`), the Code Mode Worker (`packages/pi-codemode-sandbox/`), and the capabilities core owns: memory, browser, skills, repository editing, code mode, sandbox execution, pricing, archive/export, diffs, attachments. |
| **Overlay** | `compound/pi-overlay`  | Three capabilities Open-Inspect does not have: personal MCP connections with OAuth, the external-action approval ledger, cross-session messaging. Additive, flagged off, documented in `DEVIATIONS.md`.                                                                                                                                                                                       |

The core must build and pass with the overlay absent. That is a test, not a promise:
`git checkout feat/do-harness-core && npm run build && npm test`.

---

## 2. The flags

Every Pi flag resolves to `off` when it is unset, when it is misspelled, or when it is anything but
`read_only` or `enabled`. **A typo fails closed.**

### 2.1 The deployment gate

| Flag                                     | Values       | What it does                                                                                                                                                                                                                                                          |
| ---------------------------------------- | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PI_DURABLE_ENABLED`                     | `true` / `1` | The Pi Durable Object runtime exists. Without it, a Pi session is **refused at admission** with `harness_runtime_unavailable` — it does not fall back to the OpenCode sandbox.                                                                                        |
| `pi_durable_binding_enabled` (Terraform) | `true`       | The `PI_SESSION` Durable Object binding is declared. **This is a two-phase deploy**: the class and its migration land first (`enable_durable_object_bindings = false`), and only then is the binding enabled. A new Durable Object class needs a fresh migration tag. |

### 2.2 The core capabilities

| Flag                               | Values                          | What it admits                                                                                                                                                                                                                                                                                            |
| ---------------------------------- | ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PI_SCRATCH_WORKSPACE_MODE`        | `off` / `read_only` / `enabled` | The session's own Computer VFS. It is **not** the Open-Inspect workspace, and **not** the execution sandbox's `/workspace`; the three are named distinctly so no screen or API makes them look alike. `read_only` admits the reads alone. `PI_WORKSPACE_MODE` is the deprecated spelling and still works. |
| `PI_REPOSITORY_EDITING_MODE`       | `off` / `read_only` / `enabled` | The repository overlay: the session's own repositories, as a writable layer over the pinned ones.                                                                                                                                                                                                         |
| `PI_CODE_MODE`                     | `off` / `read_only` / `enabled` | The Code Mode script lane. The script runs in a **separately deployed Worker** with no control-plane bindings, in QuickJS-in-WASM: no `fetch`, no `require`, no `process`, no timers, no modules.                                                                                                         |
| `PI_SANDBOX_EXECUTION_MODE`        | `off` / `read_only` / `enabled` | Execution escalation to a real sandbox. The sandbox is credential-free, repo-less, and pinned to a package-install egress profile.                                                                                                                                                                        |
| `PI_SANDBOX_EXECUTION_ATTESTATION` | provider evidence               | The generation and artifact provider canary's evidence, before the execution capability is admitted.                                                                                                                                                                                                      |
| `PI_BROWSER_MODE`                  | `off` / `read_only` / `enabled` | The browser gateway. The agent proposes a page; the **session** authorizes it against a deployment-configured host allowlist, and the browser runs a fresh session with no cookie jar and no credential.                                                                                                  |
| `PI_BROWSER_ALLOWED_DOMAINS`       | comma-separated hosts           | The hosts the browser may reach. Empty means **nothing** is reachable.                                                                                                                                                                                                                                    |
| `PI_MEMORY_MODE`                   | `off` / `read_only` / `enabled` | The memory tools. `read_only` withholds the write. The write goes through upstream's `SessionMemoryService` and `SessionMemoryAccessPolicy`; the model never names its own partition.                                                                                                                     |

### 2.3 The overlay's flags

| Flag                              | Values                          | What it admits                                                                                                                                                                                  |
| --------------------------------- | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PI_EXTERNAL_ACTIONS_MODE`        | `off` / `read_only` / `enabled` | The approval ledger. An effect that changes something outside the model is _prepared_; a human decides. An unattended session needs an owner-scoped automation grant, or the effect is refused. |
| `PI_EXTERNAL_ACTION_PROVIDERS`    | comma-separated                 | The providers this deployment may publish through.                                                                                                                                              |
| `PI_MCP_MODE`                     | `off` / `read_only` / `enabled` | The **personal** MCP lane: one person's OAuth credential against a reviewed, remote-only server.                                                                                                |
| `MCP_CONNECTIONS_ENABLED`         | `true`                          | The personal MCP connection feature itself.                                                                                                                                                     |
| `PI_CROSS_SESSION_MESSAGING_MODE` | `off` / `read_only` / `enabled` | A session handing a message to another session. Bounded by depth, fan-out and size.                                                                                                             |

### 2.4 The environment for a local run

```bash
# The Pi runtime, and nothing else.
PI_DURABLE_ENABLED=true

# One capability.
PI_SCRATCH_WORKSPACE_MODE=enabled
PI_MEMORY_MODE=read_only

# The Code Mode Worker is a separate deployment.
#   packages/pi-codemode-sandbox/wrangler.jsonc declares no bindings at all.

# The overlay's flags, only on the overlay branch.
PI_EXTERNAL_ACTIONS_MODE=enabled
PI_MCP_MODE=read_only
MCP_CONNECTIONS_ENABLED=true
```

---

## 3. The local test run

Everything below runs from the repository root, against a local checkout. Nothing is deployed.

### 3.1 The lanes

```bash
npm install                                     # node 24 / npm 11; no --legacy-peer-deps

npm run build -w @open-inspect/shared           # shared first: everything depends on it
npm run typecheck                               # every workspace
npm run lint
npm run format:check

npm test -w @open-inspect/shared
npm test -w @open-inspect/control-plane        # the unit lane
npm test -w @open-inspect/web
npm test -w @open-inspect/docs
npm test -w @open-inspect/github-bot
npm test -w @open-inspect/slack-bot
npm test -w @open-inspect/linear-bot

cd packages/control-plane
npx vitest run --config vitest.integration.config.ts     # the workerd lane

npm run lint:sql-portability
node scripts/terraform-workflow-contract.test.mjs
cd terraform/environments/production && terraform test
```

**What passing looks like.** Every lane green, no skipped test that was not skipped on `main`, and
`terraform test` reporting `Success!`. The workerd lane is the one that matters most: it runs
against real Durable Objects.

**Known environment artefacts** (they fail on an untouched `main` too, so they are not the Pi work's
fault): the web suite has 5-second timeouts under load that pass in isolation, and
`worker-build.test.ts` asserts a literal `node_modules` path that fails under a symlinked install.

### 3.2 The migrations, on a clean local D1

The migration runner is `scripts/d1-migrate.sh`. Its semantics matter, so they are stated here
exactly, and they are the reason the overlay's numbers are frozen:

- every file must begin with digits; a file without a numeric prefix is a **hard error**;
- two files sharing a numeric prefix is a **hard error** — the prefix is the ledger key, so one
  would be skipped forever;
- a version already recorded under a **different filename** is a **hard error**, not a skip. This is
  why a renumbering is one-way: it stops the deployment;
- unapplied versions are applied in **lexicographic file order**, and a version above an unapplied
  one is applied first.

```bash
# A clean local D1.
npx wrangler d1 execute oi-local --local --command "SELECT name FROM sqlite_master LIMIT 1"
bash scripts/d1-migrate.sh oi-local

# What it applied.
npx wrangler d1 execute oi-local --local \
  --command "SELECT version, name FROM _schema_migrations ORDER BY version"
```

**What passing looks like.** Every file in `terraform/d1/migrations/` appears in
`_schema_migrations` with the version and the name matching its filename, and the ledger is
contiguous from `0001`. The core's harness discriminator is `0090`; the overlay's migrations are in
the `9xxx` block.

### 3.3 The end-to-end Pi session

One session, end to end, against a real Durable Object in Miniflare:

```bash
cd packages/control-plane
npx vitest run --config vitest.integration.config.ts test/integration/pi-end-to-end.test.ts
```

The test does, in order: **create** the session, **prompt** it, run a **tool call**, observe the
**completion event**, **archive** the session, and read the **export**.

**What passing looks like.**

- the session's own events contain the `tool_call` **and** the `execution_complete` — the export
  reads exactly those rows, so this is the projection-completeness proof;
- after the archive, the session's status is `archived` and the Pi Durable Object still holds its
  record (an archive deletes nothing; only a delete purges);
- the export carries the session's messages and events, and the session line says plainly that the
  Pi Durable record itself is **not** in it (`harnessState: { included: false }`) — the export says
  so rather than looking complete while omitting it.

### 3.4 The projection proof, on its own

```bash
npx vitest run --config vitest.integration.config.ts test/integration/pi-export-projection.test.ts
```

**What passing looks like.** A Pi turn's tool call and its completion both appear in the SessionDO's
own `events` table. If a step ever stayed inside the Pi Durable Object, this test fails and the
export would silently lose it.

---

## 4. The canaries

The canaries are the _live_ checks: they run against a real deployment, with real credentials, and
they are the only evidence that a capability works outside the test harness. The templates are in
`docs/templates/`.

### 4.1 The Code Mode sandbox canary

`docs/templates/PI_CODEMODE_SANDBOX_CANARY.md`.

Turn on `PI_DURABLE_ENABLED=true` and `PI_CODE_MODE=enabled`, deploy the Code Mode Worker
(`packages/pi-codemode-sandbox/`, its own `wrangler.jsonc`, its own deploy workflow), and run a
session that asks the agent to run a script.

**What passing looks like.**

- the script runs in the **separate** Worker: the session's Durable Object shows no outbound request
  to the script, and the script's Worker shows no binding at all;
- the script cannot reach the network, the clock, or the filesystem — a script that tries fails
  cleanly;
- a script that calls a tool is authorized **per nested call**: an unauthorized nested call is
  refused, and the refusal names the tool;
- the turn's cost is reported from the server's price table, not from the script.

### 4.2 The execution isolation canary

`docs/templates/PI_EXECUTION_ISOLATION_CANARY.md`.

Turn on `PI_SANDBOX_EXECUTION_MODE=enabled` with the attestation evidence, and run a session that
asks for a command.

**What passing looks like.**

- the command runs in the **execution** sandbox, which has **no repository checkout, no harness, no
  MCP servers, no user environment**, and an egress profile limited to the package registry and the
  control plane;
- the model's credential never reaches it;
- the turn's deadline still applies: a command that outlives it is cancelled, and the session
  reports the stop rather than hanging.

### 4.3 The personal MCP canary (overlay only)

Turn on `MCP_CONNECTIONS_ENABLED=true` and `PI_MCP_MODE=enabled`, and connect a person to a reviewed
remote MCP server.

**What passing looks like.**

- the owner authorizes the connection, and the **owner alone** may use it;
- the tool is called with the **owner's** credential, and the model never sees it;
- the result is refused if it carries anything credential-shaped;
- **narrowing the server's repository scope, disabling the server, or withdrawing a tool from the
  review stops the call immediately** — the grant is re-evaluated at every call;
- a Slack, Linear, GitHub or automation session is **refused** the personal lane;
- the egress is structural: https only, no IP literal, no private host, the host must be the
  reviewed server's registered host, and a cross-host redirect is refused.

**If the egress guard is ever unwired, the personal-MCP flag goes with it.** That is the rule, and
it is why the canary is listed here rather than in a "nice to have" section.

### 4.4 The external-action approval canary (overlay only)

Turn on `PI_EXTERNAL_ACTIONS_MODE=enabled` and run a session that asks for a risky action.

**What passing looks like.**

- the action is **prepared**, not performed, and the tool call **fails immediately** — the turn
  never waits for a human;
- a human with the right permission approves it, and it then performs **exactly once**;
- an unattended session with no automation grant is **refused**;
- the audit records ids and state, and **never the content**.

### 4.5 The ten-minute personal canary

The end-to-end check on a real deployment: create a Pi session, prompt it, let it use a tool, watch
the completion reach the timeline, archive it, and export it.

**What passing looks like.** The export carries the turn; the session's timeline carries the tool
call and the completion; the archive leaves the session readable and quiet; and the deployment's
logs contain no credential and no tool argument body.

---

## 5. What "the overlay is off" looks like

With no overlay flag set, the overlay's capabilities are **absent, not merely disabled**:

- no personal MCP connection may be created;
- no external action may be prepared;
- no cross-session message may be sent;
- the core's tool surface is exactly the core's tools.

This is checked by the core's own lane: the core stack has no overlay module at all, so an overlay
capability cannot be reached by accident. The overlay's flags are the _second_ line of defence, not
the first.

---

## 6. The order to run things in

1. The **core** lanes (§3.1) — green before anything else is attempted.
2. The **migrations** on a clean local D1 (§3.2).
3. The **end-to-end session** (§3.3) and the **projection proof** (§3.4).
4. The **overlay** lanes on `compound/pi-overlay`, with the overlay's flags off, then one at a time.
5. The **canaries** (§4), one capability at a time, each with its flag off again afterwards.

Nothing is deployed, nothing is pushed, and no pull request is opened by any of it.
