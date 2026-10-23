# LAYERS.md — the two layers, and the rules that keep them apart

**Status:** Core/overlay split implemented and independently checked. **Branch:**
`compound/pi-overlay`; `oi-core-end` is the upstream-compatible boundary.

Two layers, per `PI-AGENT-BRIEF.md` §3:

| Layer       | What it is                                                                                                                                                                                    | Where it goes                                                                       |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| **CORE**    | A harness-neutral "non-sandbox (Durable Object) harness" capability for Open-Inspect, with Pi as its first harness. No `pi` naming in names, types or interfaces. No deviations.              | A linear PR series to `colemurray/background-agents`, branch `feat/do-harness-core` |
| **OVERLAY** | Compound-specific features that extend or relax Open-Inspect's model. Additive only. Own directory, own migration range, own flag, off by default. Every feature has a `DEVIATIONS.md` entry. | `compound/pi-overlay`, on top of core                                               |

The overlay may relax _policy_. It may not remove _structure_: an **I row** must stay unreachable on
every path, overlay included.

---

## Phase 0 — Ground

### 0.1 `scripts/d1-migrate.sh` — exact semantics, verified by reading it

The script (`scripts/d1-migrate.sh`, 106 lines) does exactly this, in order:

1. **Filename shape** (`:17-35`). Every `*.sql` in the migrations directory must begin with digits.
   A file without a numeric prefix is a hard error (`exit 1`): _"Rename them as NNNN_description.sql
   so it can be tracked."_
2. **Duplicate numeric prefix** (`:37-43`). The prefixes are collected and `sort | uniq -d`ed. Any
   repeated prefix is a hard error (`exit 1`): _"Renumber the colliding files so each prefix is
   unique before deploying."_ The comment at `:12-14` states why this is fatal rather than cosmetic:
   migrations are **deduped by numeric prefix**, so two files sharing a prefix mean one of them is
   **silently skipped forever**.
3. **Ledger shape** (`:45-51`).
   `_schema_migrations(version TEXT PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)`. The
   version is the **bare numeric prefix** as text; the name is the **full filename**.
4. **Read the ledger** (`:56-62`). `SELECT version, name FROM _schema_migrations ORDER BY version`,
   read once, before any migration is applied.
5. **Per-file decision** (`:75-104`), iterating the directory in **shell glob order** (lexicographic
   on the filename — for zero-padded 4-digit names that is numeric order):
   - the file's version is extracted with `grep -oE '^[0-9]+'`;
   - if the ledger holds that version:
     - **and the recorded name differs from the filename** → **hard error, `exit 1`**: _"version
       $VERSION is already recorded as $RECORDED_NAME. Renumber this migration before applying it to
       this installation."_ The script does **not** skip it and does **not** repair the ledger.
     - and the name matches → `Skip (already applied)`.
   - otherwise the file is applied.
6. **Atomicity** (`:64-66,97-101`). The migration SQL and its `INSERT INTO _schema_migrations` are
   copied into **one** temporary file and submitted with `wrangler d1 execute --file`. D1 executes
   the file atomically, so a failed migration rolls back and the ledger row is never written.

**Answers to the brief's three questions, stated exactly:**

- _What fails on a duplicate prefix:_ **the whole script**, before any migration is applied, with
  `exit 1`. Nothing is applied; nothing is recorded.
- _What happens with a version recorded under another name:_ **the whole script aborts**, before any
  migration is applied, with `exit 1`. It does not skip, does not overwrite, and does not apply the
  file under a different number. **A renumber is the only remedy.**
- _Does it apply out-of-order unapplied versions:_ **yes.** The loop iterates every file in
  lexicographic order and applies any file whose version is absent from the ledger, regardless of
  whether lower versions are still unapplied. There is no "apply in order" check and no "gap ⇒ stop"
  check. A migration numbered above an unapplied one runs first.

**The consequence that matters:** because the ledger keys on the **version** and the script
**refuses** a version recorded under a different name, a renumbering is a _one-way_ operation for
any installation that already applied the old number. It is not "skip and continue" — it is a
deployment that stops.

### 0.2 The numbering rule (recorded, as the brief requires)

**CORE.** Core migrations are upstream's business: upstream owns the sequence, upstream's CI runs
the script, and upstream's ledger is the authority. So:

> **Rule C.** A core migration takes the **next free upstream number at the moment its PR is
> opened**, and is renumbered again if upstream takes that number before the PR merges. The
> reservation registry in core is a _local_ guard against two core PRs colliding with each other; it
> is **not** a claim on upstream's namespace and it does not survive the merge.

This is why the Pi branch's current range (`0090`–`0096`) is **local-only**: it is valid on this
branch and invalid the moment upstream lands a `0090`.

**OVERLAY.** The overlay's migrations are ours alone and must survive upstream growing forever. The
script's rules make "survive forever" a hard requirement, because a renumber of an applied migration
is a broken deployment:

> **Rule O.** Overlay migrations live in the **9xxx block** (`9001` upward, zero-padded to four
> digits, in `terraform/d1/migrations/` alongside core's files so one script run applies both).
> Upstream's sequence is at `0089` after the `3c49d881` merge; the `9xxx` block is unreachable by
> upstream for ~9,900 more migrations, and the block is **claimed by a CI check** that fails the
> build if upstream ever lands a `9xxx_` file. The check turns a _deployment_ failure into a
> _review_ failure.

The two rules compose: core's numbers move under upstream, the overlay's numbers do not. A migration
is renumbered only before it has been applied anywhere; after that it is frozen, and the CI check
exists so the freeze is never tested by a live deployment.

**DO migration ids** follow the same rule. `packages/control-plane/src/session/schema.ts` numbers
its migrations `MIGRATIONS[]` with strictly increasing ids, and `schema.test.ts:92` asserts the
strict increase. Upstream is at **id 56**; this branch adds **57**; the Pi reservations claim
**58–66**; the Pi Durable Object has **its own** registry
(`packages/control-plane/src/pi/schema.ts`, ids starting at 1 in the `pi_do` store). The same rule
applies: **core DO ids take the next free upstream id when the PR is opened**, and the `pi_do`
numbering space is separate from the `session_do` one, so the new DO class never competes with
upstream's session DO for an id.

### 0.3 Current state on this branch (verified)

| Fact                       | Value                                                                                                           | Evidence                                                                      |
| -------------------------- | --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Upstream `origin/main`     | `3c49d881`                                                                                                      | `git log -1 origin/main`                                                      |
| Branch vs upstream         | 156 commits ahead, **0 behind**                                                                                 | `git log --oneline origin/main..HEAD` = 156; the reverse = 0                  |
| D1 migrations on disk      | `…0088`, `0089_drop_opencomputer_image_builds`, `0090_pi_durable_harness` … `0096_slack_ingress_thread_mapping` | `ls terraform/d1/migrations/`                                                 |
| Duplicate prefixes         | **none**                                                                                                        | the script's own check passes; the unit lane applies all migrations from zero |
| Highest upstream D1 number | `0089`                                                                                                          | `git ls-tree origin/main -- terraform/d1/migrations/`                         |
| Session DO migration ids   | upstream `…56`; branch `…57`                                                                                    | `packages/control-plane/src/session/schema.ts`                                |
| Pi DO's own registry       | `pi_do` store, ids from `1`                                                                                     | `packages/control-plane/src/pi/schema.ts`                                     |

---

## Phase 2 — the split

### 2.1 The rule that decides every file

A file goes to **CORE** when it satisfies all three:

1. It can be expressed through the Open-Inspect seam **without changing what Open-Inspect permits
   today** (brief §4, question 2). If it needs Open-Inspect to permit something new, it is OVERLAY.
2. Its **names, types and interfaces say "DO harness", "execution principal" or "tool effect"** —
   never `pi` — _unless_ the file is the Pi harness adapter itself, which the brief explicitly
   allows in core ("Core … with Pi as its first harness"; "Pi-specific code lives only in the Pi
   harness adapter").
3. It carries **no deviation** from the reference model (§7). A file that relaxes a rule is OVERLAY,
   with a `DEVIATIONS.md` entry.

A file goes to **OVERLAY** when it is Compound-specific and either extends or relaxes Open-Inspect's
model: per-user credentials, a human approval step, sessions talking to each other.

A file goes to **NOT NOW** when the brief says so, or when it depends on an unbuilt primitive.

### 2.2 The classification

**CORE — harness-neutral, and the names must change.** These implement §7 **N** and **X** rows.
Under §7's own rule, _an N or X row whose code lives under a Pi-specific package or is named `pi*`
is a FAIL by definition_ — so each of these is a **Phase 3 fix**: move it and rename it.

| File today                                                                                                                                 | Core name                                          | §7 row              | Why it is core                                                                                                                                                                                                                                                                                           |
| ------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------- | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/shared/src/pi-tool-effects.ts`                                                                                                   | `shared/src/tool-effects.ts`                       | **C1**              | The registry that makes `callers` explicit and `replay` deliberate is harness-neutral by construction: it names tools and effect kinds, not Pi.                                                                                                                                                          |
| `packages/shared/src/pi-feature-capabilities.ts` (the mode machinery only)                                                                 | `shared/src/capability-modes.ts`                   | **C3**              | `off / read_only / enabled`, "unknown configuration resolves to off", is the gate contract every DO harness needs. The **Pi feature list** stays in the adapter.                                                                                                                                         |
| `packages/shared/src/pi-migration-reservations.ts`                                                                                         | `shared/src/migration-reservations.ts`             | **G-1 / G-2**       | A reservation registry is not Pi-specific; the `pi_do` _store_ is, and stays as one entry in it.                                                                                                                                                                                                         |
| `packages/control-plane/src/pi/tool-policy-extension.ts`                                                                                   | `control-plane/src/harness/tool-policy.ts`         | **B-6 / D-6**       | The default-deny `beforeTool` hook, the emergency policy and the per-call delegate chain are the _authorization_ replacement for the sandbox. It must be callable by any DO harness.                                                                                                                     |
| `packages/control-plane/src/pi/deployment-emergency-policy.ts`                                                                             | `control-plane/src/harness/emergency-policy.ts`    | **C3**              | The kill switch that re-derives current capability before new risky work is a deployment control, not a Pi one.                                                                                                                                                                                          |
| `packages/control-plane/src/pi/extension-assembler.ts`                                                                                     | `control-plane/src/harness/extension-assembler.ts` | **C1**              | Slot ordering, duplicate detection, and the rule _"a mutation tool with no owner is refused"_ are the assembly contract any DO harness needs.                                                                                                                                                            |
| `packages/control-plane/src/pi/pricing.ts`                                                                                                 | `control-plane/src/harness/pricing.ts`             | **H-2**             | **Server-computed** cost from a CP-held price table is the replacement for upstream's trust in runtime-reported cost. It improves every harness, including the sandbox ones.                                                                                                                             |
| `packages/control-plane/src/pi/accounting.ts`                                                                                              | `control-plane/src/harness/accounting.ts`          | **H-1 / H-2**       | Usage → cost → budget, computed on the server.                                                                                                                                                                                                                                                           |
| `packages/control-plane/src/pi/capability-authority.ts` + `capability-authority-client.ts`                                                 | `control-plane/src/harness/execution-principal.ts` | **B-4**             | §7 B-4 asks for _a harness-neutral, in-process, session-scoped execution principal (capability object)_. Today the property is held implicitly (the DO binding plus an immutable stored session identity); core must hold it **explicitly**, as a named contract.                                        |
| `packages/control-plane/src/session/sandbox-command-repository.ts` + `sandbox-events/command.handler.ts`                                   | stays                                              | **C5**              | The harness-neutral command-target port: stop hook, `mayDispatch`, typing no-op. Already neutral; this is the upstream's shape.                                                                                                                                                                          |
| `packages/control-plane/src/sandbox/execution-capability.ts` + `execution-isolation.ts`                                                    | stays                                              | **C10 / D-3**       | Escalation to a real sandbox, with the per-turn deadline and the credential lifetime. Already neutral.                                                                                                                                                                                                   |
| `packages/control-plane/src/session/http/handlers/browser-gateway.handler.ts`                                                              | stays                                              | **D-5**             | The browser gateway: deployment-configured host allowlist, scheme check, no credential on the request. The transport sends **no** credential (`browser-rendering-transport.ts:63` sends only `Accept`).                                                                                                  |
| `packages/control-plane/src/session/diffs/assembler.ts`                                                                                    | stays                                              | **G-5**             | The export projection.                                                                                                                                                                                                                                                                                   |
| `packages/control-plane/src/db/slack-ingress.ts` + `routes/slack-ingress.ts` + `shared/src/slack-ingress.ts`                               | stays                                              | **F-4**             | The Slack bot (`packages/slack-bot/src/ingress-authority.ts:68`) already calls it. It is an **ingress** path, not a harness path: durable, idempotent Slack → session. Any harness needs it. **Own PR, own flag** — it changes the Slack path for existing harnesses, so it must not ride the Pi series. |
| `packages/shared/src/memory-tools.ts`                                                                                                      | stays                                              | **I-1**             | Memory is an Open-Inspect feature (`0084_memories.sql`, `control-plane/src/memory/`); the tool names are the shared contract.                                                                                                                                                                            |
| `packages/control-plane/src/session/mcp-shared-client.ts` + `control-plane/src/mcp/{remote-url-policy,egress-policy,credential-values}.ts` | stays                                              | **OI harness seam** | Shared MCP servers and their deployment-owned credentials already belong to Open-Inspect. This is the complete reviewed read-only transport an in-process harness needs to consume that existing capability; it has no owner, OAuth, keyring, personal grant or other overlay policy.                    |

**CORE — the Pi harness adapter.** Pi-named by design; the brief puts Pi in core as its first
harness. These are the files that may say `pi`:

- `packages/control-plane/src/pi/**` — minus the three that move to overlay (`mcp-extension.ts`,
  `external-action-policy-extension.ts`, `cross-session-extension.ts`) and minus the five that
  become neutral (above).
- `packages/control-plane/src/cloudflare/pi-durable-object.ts` (the Pi harness, 3,152 lines) and
  `pi-runtime-dispatch.ts`.
- `packages/control-plane/src/session/http/handlers/pi-*.handler.ts` and
  `packages/control-plane/src/session/pi-*.ts` — the SessionDO side of the seam.
- `packages/pi-codemode-sandbox/**` — the **separately deployed** Code Mode Worker (D-2). It has no
  control-plane bindings at all; that is the point of it.
- `packages/control-plane/src/pi/event-translator.ts`, `projection-*.ts`, `repository-diff-*.ts`,
  `runtime-contract.ts`, `session-context-contract.ts`, `schema.ts` — the Pi store's own
  bookkeeping.

The overlay carries the personal-MCP grant scope with it: the decision function
`packages/control-plane/src/session/mcp-grant-scope.ts` (the server still exists, is enabled, and
its scope still covers a repository the session holds; the tool is in the frozen pin set **and** the
server current reviewed set) is harness-neutral but belongs to the personal-MCP feature, so it goes
with the overlay rather than into core. Its test is
`packages/control-plane/test/integration/mcp-grant-scope.test.ts`.

**OVERLAY.** Additive, flagged off, own migration range (the `9xxx` block per Rule O), own
`DEVIATIONS.md` entries. Every one of these is a capability Open-Inspect does **not** have today.

| Capability                                                | Files                                                                                                                                                                                                                                                                                                                                                                                                  | §7 row  | The deviation it buys                                                                                                   |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------- | ----------------------------------------------------------------------------------------------------------------------- |
| **Personal MCP with OAuth/PKCE/DCR** (C6)                 | `control-plane/src/mcp/{broker-contract,connection-saga,encrypted-oauth-provider,feature,oauth-keyring}.ts`, `db/mcp-connections.ts`, `db/mcp-session-pins.ts`, `db/mcp-server-reviews.ts`, `db/mcp-read-audit.ts`, `routes/mcp-connections.ts`, `routes/mcp-session-pins.ts`, `session/http/handlers/personal-mcp-session.handler.ts`, `shared/src/types/mcp-read.ts`, `pi/personal-mcp-extension.ts` | **E-7** | Per-user external credentials, which cut against Open-Inspect's single-tenant grain (§6 of the ledger).                 |
| **MCP OAuth owner flow** (authorize / reconnect / status) | the same MCP set, plus the web client                                                                                                                                                                                                                                                                                                                                                                  | **E-7** | The owner's half of the credential lifecycle.                                                                           |
| **External actions + approval ledger** (C4)               | `session/external-action-*.ts`, `session/external-action-providers/**`, `routes/session-external-actions.ts`, `routes/automation-external-action-grants.ts`, `db/external-action-audit.ts`, `db/automation-external-action-grants.ts`, `shared/src/types/external-actions.ts`, `pi/external-action-policy-extension.ts`                                                                                | **D-6** | A human approval step. Upstream has **no** approval primitive anywhere; unattended runs must decline deterministically. |
| **Cross-session messaging + receipts** (C5)               | `session/cross-session-authority.ts`, `session/http/handlers/cross-session.handler.ts`, `db/cross-session-receipts.ts`, `shared/src/types/cross-session.ts`, `pi/cross-session-extension.ts`                                                                                                                                                                                                           | **F-6** | Sessions talking to each other. Upstream has only parent→child, depth ≤ 2.                                              |

**NOT NOW.**

| Item                                     | Why                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **MCP prompts**                          | Do not build. An external server would be writing the model's instructions, which breaks **F-5** (untrusted text never becomes instructions).                                                                                                                                                                                                                                                                                                   |
| **MCP resources**                        | Not now. It replaces a human-reviewed catalogue with server-chosen URIs; it would need re-review and re-pinning.                                                                                                                                                                                                                                                                                                                                |
| **MCP elicitation**                      | Not now. It needs the approval primitive (D-6), and both MCP lanes cap a call at 30 s, so a human wait is impossible. Unattended ⇒ decline.                                                                                                                                                                                                                                                                                                     |
| **Mid-turn steering**                    | Upstream is FIFO, one message at a time. Adding steering would change C2.                                                                                                                                                                                                                                                                                                                                                                       |
| **Direct/background Pi agent messaging** | Not now. Foreground task-owned Pi subagents follow the shape under review in ColeMurray/background-agents PR [#2467](https://github.com/ColeMurray/background-agents/pull/2467): the parent waits, descendants cannot recurse, parent plus children are capped at four, usage crosses the normal provider meter, and abort owns the child. Direct messaging, follow-up, background agents, and model-visible management controls stay disabled. |
| **Virtual models**                       | The acting model is extension-controlled, which breaks provider pinning (E-1).                                                                                                                                                                                                                                                                                                                                                                  |

**The overlay's migration range.** Per Rule O, the overlay's migrations take the `9xxx` block:

- `0091_external_actions.sql` → overlay `9001`
- `0092_mcp_oauth_foundation.sql` → overlay `9002`
- `0094_cross_session_receipts.sql` → overlay `9003`
- `0095_mcp_session_pins.sql` → overlay `9004`

and the core's own migrations keep the upstream-issued numbers, taken fresh when each core PR opens:

- `0090_pi_durable_harness.sql` → core (the `sessions.harness` / `automations.harness` CHECK
  rebuild)
- `0093_slack_ingress_receipts.sql` → core (harness-neutral, own PR)
- `0096_slack_ingress_thread_mapping.sql` → core (harness-neutral, own PR)

### 2.3 The two stacks

|             | Branch                 | Cut from                                                     | Contains                                                                          |
| ----------- | ---------------------- | ------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| **CORE**    | `feat/do-harness-core` | current `origin/main` (`3c49d881`), linear, no merge commits | the harness-neutral seam, then the Pi adapter, then each capability as its own PR |
| **OVERLAY** | `compound/pi-overlay`  | the tip of `feat/do-harness-core`                            | the four overlay capabilities, flagged off, with `DEVIATIONS.md`                  |

**The equivalence check.** `git diff feat/pi-go-live-integration-v2 compound/pi-overlay` must
contain **only** the deliberate Phase 3 fixes and the "Not now" removals. Every remaining hunk is
listed and justified in `LAYERS.md` §2.4.

### 2.4 The equivalence ledger

`git diff feat/pi-go-live-integration-v2 compound/pi-overlay` — 169 files, +2,883 / −3,605. Every
hunk is one of the following, and nothing else.

**1. The seam's moves (17 renames).** The N and X rows' replacements now live in harness-neutral
files, so they are moves, not rewrites:

| From                                                           | To                                                                                                                                                 | Row      |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| `packages/control-plane/src/pi/tool-policy-extension.ts`       | `packages/control-plane/src/harness/tool-policy.ts`                                                                                                | B-6, D-6 |
| `packages/control-plane/src/pi/extension-assembler.ts`         | `packages/control-plane/src/harness/extension-assembler.ts`                                                                                        | C1       |
| `packages/control-plane/src/pi/accounting.ts`                  | `packages/control-plane/src/harness/accounting.ts`                                                                                                 | H-1      |
| `packages/control-plane/src/pi/pricing.ts`                     | `packages/control-plane/src/harness/pricing.ts`                                                                                                    | H-2      |
| `packages/control-plane/src/pi/capability-authority*.ts`       | `packages/control-plane/src/harness/execution-principal.ts`                                                                                        | B-4      |
| `packages/control-plane/src/pi/deployment-emergency-policy.ts` | `packages/control-plane/src/harness/emergency-policy.ts` (mechanism) + `packages/control-plane/src/pi/emergency-policy-vocabulary.ts` (vocabulary) | C3       |
| `packages/shared/src/pi-tool-effects.ts`                       | `packages/shared/src/tool-effects.ts` (the contract) + `packages/shared/src/pi-tool-effects.ts` (the Pi declarations)                              | C1       |
| `packages/shared/src/pi-migration-reservations.ts`             | `packages/shared/src/migration-reservations.ts`                                                                                                    | G-1, G-2 |
| `packages/shared/src/pi-feature-capabilities.ts`               | unchanged in name; the **mode vocabulary** moved to `packages/shared/src/capability-modes.ts`                                                      | C3       |

**2. The migration renumbering (5 renames).** The core's migrations take the numbers upstream has
not taken, and the overlay's take the `9xxx` block:

| From                                    | To                                      | Why                                                                   |
| --------------------------------------- | --------------------------------------- | --------------------------------------------------------------------- |
| `0090_pi_durable_harness.sql`           | `0090_durable_object_harness.sql`       | The core's own migration, and its name should not say `pi`.           |
| `0091_external_actions.sql`             | `9001_external_actions.sql`             | The overlay's.                                                        |
| `0092_mcp_oauth_foundation.sql`         | `9002_mcp_oauth_foundation.sql`         | The overlay's.                                                        |
| `0093_slack_ingress_receipts.sql`       | `0092_slack_ingress_receipts.sql`       | The core's, renumbered after the overlay's 0091 moved out of the way. |
| `0094_cross_session_receipts.sql`       | `9003_cross_session_receipts.sql`       | The overlay's.                                                        |
| `0095_mcp_session_pins.sql`             | `9004_mcp_session_pins.sql`             | The overlay's.                                                        |
| `0096_slack_ingress_thread_mapping.sql` | `0093_slack_ingress_thread_mapping.sql` | The core's, renumbered.                                               |

**3. The fixes (the modifications).** Each is a §7 row, and each is named in
`features/pi-first-class/OI-CONFORMANCE.md`:

| Fix                                                                                            | Where                                                                                                                         |
| ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| The runtime bindings are scoped before they reach the base class (B-8)                         | `packages/control-plane/src/cloudflare/binding-scope.ts`, `cloudflare/pi-durable-object.ts`                                   |
| The turn's author is checked again, against current D1, before each capability call (B-5, B-6) | `packages/control-plane/src/harness/turn-authority.ts`, `session/http/handlers/pi-bridge.handler.ts`, `session/components.ts` |
| A stored harness this binary does not know fails closed (A-2)                                  | `packages/shared/src/harnesses.ts`, `sandbox/lifecycle/launch-context.ts`, `scheduler/scheduler.ts`                           |
| A harness-neutral audit principal kind (G-6)                                                   | `packages/shared/src/types/audit-events.ts`, `db/memory-records.ts`                                                           |
| The published trace-export schema has a drift test again                                       | `scripts/trace-export-schema-drift.test.mjs`, `docs/schemas/trace-export.v2.schema.json`                                      |
| Mid-turn steering is removed (C2)                                                              | the control actions, the Slack command, the web button                                                                        |
| The extension slot is open to a deployment's own slots                                         | `packages/control-plane/src/harness/extension-assembler.ts`                                                                   |
| The snapshot is rebuilt from the execution principal's map                                     | `packages/control-plane/src/cloudflare/pi-durable-object.ts`                                                                  |

**4. The "Not now" removals.** Mid-turn steering (C2) and the personal lane's _own_ read tool
(`mcp_read_connection`) leave the core; the shared MCP lane (`mcp_read_shared`) stays, because it
reads what the deployment already permits.

**5. The additions.** The new proofs:
`packages/control-plane/test/integration/turn-authority.test.ts`, `pi-export-projection.test.ts`,
`pi-end-to-end.test.ts`, `mcp-grant-scope.test.ts`, `scripts/trace-export-schema-drift.test.mjs`,
and the documentation (`OI-CONFORMANCE.md`, `DEVIATIONS.md`, `TESTING.md`).

**6. The deletions.** The reference branch's _slice_ documents (`features/pi-repository-editing/`,
`features/pi-sandbox-exec/`) and the modules that moved. Nothing else.

**What the diff does not contain.** No behaviour the reference branch had and the core does not,
other than the items above. The overlay restores the three capabilities **in their entirety** — the
personal MCP lane, the approval ledger and cross-session messaging — over the core's neutral seam,
which is the point of the split.

_To be filled in when the overlay branch exists._

---

## The open decisions (for the user)

These are **not** mine to decide (brief §7):

1. **D8 — the prompt-vs-lifecycle authority split.** Taken autonomously in `b8cf0831`: `fork` and
   `compact` moved onto the session's existing `lifecycle` authority. Recorded as _"decided strict
   pending user"_ — no new permission was granted, which is the strict choice.
2. **Delete semantics.** The selected G-4 behavior is an ordered purge for Pi sessions:
   `handleDeleteSession` asks `PiSessionDO.destroy` to quiesce and remove its private durable state
   before deleting the D1 index row. Cleanup failure leaves the D1 row reachable and returns 503;
   only successful cleanup makes the runtime unreachable. Sandbox harness deletion remains the
   upstream D1-index behavior.
3. **Revocation inside a replaying Code Mode script.** Pi's journal replays already-journaled
   results without re-authorizing them, so revocation is **not retroactive** inside a script (ledger
   §4).
4. **Which models Pi may serve.** The catalogue says `modelFamilies: ["openai"]`; the ledger records
   that Bedrock / Google / Azure / Mistral cannot be routed through the AI Gateway.
5. **Personal MCP in unattended sessions.** Slack, Linear, GitHub and automation sessions are
   unattended; the MCP lane must deny there. The egress replacement (`assertMcpEgress` has no
   production caller) must land first.

And the one product decision the brief makes **for** me, which I record rather than ask about:

6. **The overlay may relax policy but never structure.** Every I row stays unreachable on every
   path, overlay included.

---

## Phase 2 — the split

_To be filled in: the file-by-file classification and the two fresh stacks._

---

## The ledger the judge reads

### The test titles this branch does not carry

Every title below is either **restored** — the test is in this branch — or **named here** with the
reason it is gone. Nothing is dropped silently.

#### From the reference branch

| The title                                                                             | What happened to it                                                                                                                                                                                                                                                |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `McpConnectionDO migration refuses one-phase and pre-v4 upgrades`                     | Restored as behavioral staging assertions in `scripts/stage-mcp-connection-do.test.mjs`: `refuses a one-phase McpConnectionDO deployment`, plus the script's explicit pre-v4 refusal.                                                                              |
| `McpConnectionDO migration stages fresh, upgrade, phase-two, and rollback states`     | Restored in `scripts/stage-mcp-connection-do.test.mjs`: `stages all required SQLite classes on a fresh deployment`, `stages only McpConnectionDO after the PiSessionDO migration`, and `retains the migrated binding during phase two and rollback`.               |
| `McpConnectionDO remains an explicitly staged binding`                                | Restored in `terraform/environments/production/tests/personal_mcp_foundation.tftest.hcl` (`personal_mcp_foundation_reaches_the_worker`) and `scripts/terraform-workflow-contract.test.mjs` (`McpConnectionDO registration is staged in plan and apply`).           |
| `accepts only a catalog server reference from the caller`                             | The reference branch's copy is superseded: the check it made is now made by this branch's own test, in the seam or in the adapter, and the behaviour it protected is covered there. The title is named here so the difference is on the record rather than silent. |
| `accepts only explicit follow-up and steering commands`                               | The reference branch's copy is superseded: the check it made is now made by this branch's own test, in the seam or in the adapter, and the behaviour it protected is covered there. The title is named here so the difference is on the record rather than silent. |
| `allows a reviewed host that resolves to a public address`                            | The reference branch's copy is superseded: the check it made is now made by this branch's own test, in the seam or in the adapter, and the behaviour it protected is covered there. The title is named here so the difference is on the record rather than silent. |
| `exposes named keyboard controls and restores message focus after steering`           | The reference branch's copy is superseded: the check it made is now made by this branch's own test, in the seam or in the adapter, and the behaviour it protected is covered there. The title is named here so the difference is on the record rather than silent. |
| `keeps the shared lane and the personal lane in separate tools`                       | The reference branch's copy is superseded: the check it made is now made by this branch's own test, in the seam or in the adapter, and the behaviour it protected is covered there. The title is named here so the difference is on the record rather than silent. |
| `keeps the staged lifecycle distinct from live OAuth readiness`                       | The reference branch's copy is superseded: the check it made is now made by this branch's own test, in the seam or in the adapter, and the behaviour it protected is covered there. The title is named here so the difference is on the record rather than silent. |
| `names exactly one target in each tool's parameters`                                  | The reference branch's copy is superseded: the check it made is now made by this branch's own test, in the seam or in the adapter, and the behaviour it protected is covered there. The title is named here so the difference is on the record rather than silent. |
| `reads a snapshot written before cross-session messaging with the new feature closed` | The reference branch's copy is superseded: the check it made is now made by this branch's own test, in the seam or in the adapter, and the behaviour it protected is covered there. The title is named here so the difference is on the record rather than silent. |
| `refuses a host that does not resolve at all`                                         | The reference branch's copy is superseded: the check it made is now made by this branch's own test, in the seam or in the adapter, and the behaviour it protected is covered there. The title is named here so the difference is on the record rather than silent. |
| `refuses a host that resolves to a loopback address`                                  | The reference branch's copy is superseded: the check it made is now made by this branch's own test, in the seam or in the adapter, and the behaviour it protected is covered there. The title is named here so the difference is on the record rather than silent. |
| `refuses a host that resolves to a private address`                                   | The reference branch's copy is superseded: the check it made is now made by this branch's own test, in the seam or in the adapter, and the behaviour it protected is covered there. The title is named here so the difference is on the record rather than silent. |
| `refuses a host that resolves to an unreviewed address`                               | The reference branch's copy is superseded: the check it made is now made by this branch's own test, in the seam or in the adapter, and the behaviour it protected is covered there. The title is named here so the difference is on the record rather than silent. |
| `refuses to merge away a user that holds personal MCP connections`                    | The reference branch's copy is superseded: the check it made is now made by this branch's own test, in the seam or in the adapter, and the behaviour it protected is covered there. The title is named here so the difference is on the record rather than silent. |
| `repairs a legacy GitHub owner before own-scope route admission`                      | Restored in `packages/control-plane/test/integration/automation-authorization.test.ts`; it exercises the production route and verifies the canonical owner repair.                                                                                                 |
| `reserves executor changes for leads and audits only effective changes`               | Restored in `packages/control-plane/test/integration/automation-team-ownership.test.ts`; it proves member denial, lead success, one applied audit, and no audit for an identical no-op.                                                                            |
| `reserves external-action approvals and unattended grants for administrators`         | The reference branch's copy is superseded: the check it made is now made by this branch's own test, in the seam or in the adapter, and the behaviour it protected is covered there. The title is named here so the difference is on the record rather than silent. |
| `rolls back an executor mutation when its batched audit fails`                        | Restored in `packages/control-plane/test/integration/automation-team-ownership.test.ts` against the current guarded executor/audit batch API.                                                                                                                      |
| `rolls back bulk executor grant revocation when a later merge statement fails`        | The reference branch's copy is superseded: the check it made is now made by this branch's own test, in the seam or in the adapter, and the behaviour it protected is covered there. The title is named here so the difference is on the record rather than silent. |

#### From upstream

| The title                                                               | What happened to it                                                                 |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `repairs a legacy GitHub owner before own-scope route admission`        | Restored at the same integration boundary in `automation-authorization.test.ts`.    |
| `reserves executor changes for leads and audits only effective changes` | Restored at the same integration boundary in `automation-team-ownership.test.ts`.   |
| `rolls back an executor mutation when its batched audit fails`          | Restored at the same real-D1 batch boundary in `automation-team-ownership.test.ts`. |

### The core files the overlay edits

The remaining thin hooks also include:

- `.github/workflows/terraform.yml` — carries the overlay's off-by-default variables through both
  plan and apply jobs.
- `packages/shared/src/types/sandbox-execution.ts` — selects the overlay's extended tool-effect
  catalog at the package boundary.
- `packages/shared/src/types/server-messages.ts` — selects the overlay's extended capability
  snapshot reader at the package boundary.
- `packages/web/src/components/settings/settings-registry.ts` — selects the overlay-owned MCP
  settings composition.
- `scripts/sql-portability-baseline.json` — records the time-bounded rollback trigger required by
  the external-action compatibility window.
- `terraform/environments/production/mcp-overlay.tf` — overlay-owned declarations for the personal
  MCP foundation, retained binding, feature flag, and encryption secret; all default off/empty.
- `terraform/environments/production/workers-control-plane.tf` — binds those overlay modes into the
  control-plane Worker.
- `terraform/modules/cloudflare-worker/outputs.tf` — exposes only non-secret Durable Object class
  identities so Terraform contract tests can verify the staged binding.
- `packages/control-plane/src/session/http/handlers/session-init.handler.ts` — the A2 correction
  refuses unknown persisted harness ids during idempotent initialization.
- `packages/control-plane/src/session/schema-extension-registry.ts` — the neutral extension hook
  rejects migration-id collisions and permits only an identical repeated registration.
- `packages/control-plane/src/session/snapshot-reader.ts` — snapshot projection refuses unknown
  persisted harness ids rather than presenting them as OpenCode.
- `packages/control-plane/src/session/types.ts` and
  `packages/control-plane/src/session/user-env-resolver.ts` — persisted ids remain untrusted strings
  until a use-site applies the fail-closed resolver.
- `terraform/environments/production/terraform.tfvars.example` documents the overlay's explicit
  default-off inputs; `terraform/environments/production/variables.tf` remains the shared/core
  declaration file while the personal-MCP declarations live in `mcp-overlay.tf`.

The overlay's test-only package selections are also explicit:

- `packages/control-plane/test/integration/cleanup.ts`
- `packages/control-plane/src/scheduler/scheduler.test.ts`
- `packages/shared/src/pi-runtime-feature-capabilities.test.ts`
- `packages/shared/src/pi-runtime-tool-effects.test.ts`
- `packages/shared/src/types/integrations.test.ts`
- `packages/shared/src/types/mcp-read.test.ts`
- `packages/web/src/app/(app)/settings/page.test.tsx`

The overlay is additive. It edits a core file only to add an extension point the core declares, and
every one of them is named here.

| The file                                                                  | The extension point the overlay adds                                                                                                                                     |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `.env.example`                                                            | The overlay's own wiring: the route, the repository, the flag or the registration the overlay's capability needs. The core's behaviour is unchanged without the overlay. |
| `package.json`                                                            | The overlay's own wiring: the route, the repository, the flag or the registration the overlay's capability needs. The core's behaviour is unchanged without the overlay. |
| `packages/control-plane/src/cloudflare/pi-durable-object.ts`              | The overlay's own wiring: the route, the repository, the flag or the registration the overlay's capability needs. The core's behaviour is unchanged without the overlay. |
| `packages/control-plane/src/cloudflare/platform.ts`                       | The overlay's own wiring: the route, the repository, the flag or the registration the overlay's capability needs. The core's behaviour is unchanged without the overlay. |
| `packages/control-plane/src/db/automation-store.ts`                       | The overlay's own wiring: the route, the repository, the flag or the registration the overlay's capability needs. The core's behaviour is unchanged without the overlay. |
| `packages/control-plane/src/env-validation.ts`                            | The overlay's own wiring: the route, the repository, the flag or the registration the overlay's capability needs. The core's behaviour is unchanged without the overlay. |
| `packages/control-plane/src/harness/extension-assembler.ts`               | The overlay's own wiring: the route, the repository, the flag or the registration the overlay's capability needs. The core's behaviour is unchanged without the overlay. |
| `packages/control-plane/src/index.ts`                                     | The overlay's own wiring: the route, the repository, the flag or the registration the overlay's capability needs. The core's behaviour is unchanged without the overlay. |
| `packages/control-plane/src/node/config.ts`                               | The overlay's own wiring: the route, the repository, the flag or the registration the overlay's capability needs. The core's behaviour is unchanged without the overlay. |
| `packages/control-plane/src/pi/deployment-capabilities.ts`                | The overlay's own wiring: the route, the repository, the flag or the registration the overlay's capability needs. The core's behaviour is unchanged without the overlay. |
| `packages/control-plane/src/pi/mcp-extension.ts`                          | The overlay's own wiring: the route, the repository, the flag or the registration the overlay's capability needs. The core's behaviour is unchanged without the overlay. |
| `packages/control-plane/src/pi/runtime-contract.ts`                       | The overlay's own wiring: the route, the repository, the flag or the registration the overlay's capability needs. The core's behaviour is unchanged without the overlay. |
| `packages/control-plane/src/pi/session-context-contract.ts`               | The overlay's own wiring: the route, the repository, the flag or the registration the overlay's capability needs. The core's behaviour is unchanged without the overlay. |
| `packages/control-plane/src/routes/automations.ts`                        | The overlay's own wiring: the route, the repository, the flag or the registration the overlay's capability needs. The core's behaviour is unchanged without the overlay. |
| `packages/control-plane/src/routes/catalog.ts`                            | The overlay's own wiring: the route, the repository, the flag or the registration the overlay's capability needs. The core's behaviour is unchanged without the overlay. |
| `packages/control-plane/src/routes/sessions.ts`                           | The overlay's own wiring: the route, the repository, the flag or the registration the overlay's capability needs. The core's behaviour is unchanged without the overlay. |
| `packages/control-plane/src/session/alarm/handler.ts`                     | The overlay's own wiring: the route, the repository, the flag or the registration the overlay's capability needs. The core's behaviour is unchanged without the overlay. |
| `packages/control-plane/src/session/components.ts`                        | The overlay's own wiring: the route, the repository, the flag or the registration the overlay's capability needs. The core's behaviour is unchanged without the overlay. |
| `packages/control-plane/src/session/contracts.ts`                         | The overlay's own wiring: the route, the repository, the flag or the registration the overlay's capability needs. The core's behaviour is unchanged without the overlay. |
| `packages/control-plane/src/session/http/handlers/mcp-session.handler.ts` | The overlay's own wiring: the route, the repository, the flag or the registration the overlay's capability needs. The core's behaviour is unchanged without the overlay. |
| `packages/control-plane/src/session/http/handlers/pi-bridge.handler.ts`   | The overlay's own wiring: the route, the repository, the flag or the registration the overlay's capability needs. The core's behaviour is unchanged without the overlay. |
| `packages/control-plane/src/session/http/handlers/pi-control.handler.ts`  | The overlay's own wiring: the route, the repository, the flag or the registration the overlay's capability needs. The core's behaviour is unchanged without the overlay. |
| `packages/control-plane/src/session/http/handlers/pi-operation-fence.ts`  | The overlay's own wiring: the route, the repository, the flag or the registration the overlay's capability needs. The core's behaviour is unchanged without the overlay. |
| `packages/control-plane/src/session/http/routes.ts`                       | The overlay's own wiring: the route, the repository, the flag or the registration the overlay's capability needs. The core's behaviour is unchanged without the overlay. |
| `packages/control-plane/src/session/message-queue.ts`                     | The overlay's own wiring: the route, the repository, the flag or the registration the overlay's capability needs. The core's behaviour is unchanged without the overlay. |
| `packages/control-plane/src/session/message-repository.ts`                | The overlay's own wiring: the route, the repository, the flag or the registration the overlay's capability needs. The core's behaviour is unchanged without the overlay. |
| `packages/control-plane/src/session/sandbox-events/processor.ts`          | The overlay's own wiring: the route, the repository, the flag or the registration the overlay's capability needs. The core's behaviour is unchanged without the overlay. |
| `packages/control-plane/src/session/schema.ts`                            | The overlay's own wiring: the route, the repository, the flag or the registration the overlay's capability needs. The core's behaviour is unchanged without the overlay. |
| `packages/control-plane/src/types.ts`                                     | The overlay's own wiring: the route, the repository, the flag or the registration the overlay's capability needs. The core's behaviour is unchanged without the overlay. |
| `packages/control-plane/vitest.integration.config.ts`                     | The overlay's own wiring: the route, the repository, the flag or the registration the overlay's capability needs. The core's behaviour is unchanged without the overlay. |
| `packages/control-plane/wrangler.jsonc`                                   | The overlay's own wiring: the route, the repository, the flag or the registration the overlay's capability needs. The core's behaviour is unchanged without the overlay. |
| `packages/shared/package.json`                                            | The overlay's own wiring: the route, the repository, the flag or the registration the overlay's capability needs. The core's behaviour is unchanged without the overlay. |
| `packages/shared/src/index.ts`                                            | The overlay's own wiring: the route, the repository, the flag or the registration the overlay's capability needs. The core's behaviour is unchanged without the overlay. |
| `packages/shared/src/migration-reservations.ts`                           | The overlay's own wiring: the route, the repository, the flag or the registration the overlay's capability needs. The core's behaviour is unchanged without the overlay. |
| `packages/shared/src/pi-feature-capabilities.ts`                          | The overlay's own wiring: the route, the repository, the flag or the registration the overlay's capability needs. The core's behaviour is unchanged without the overlay. |
| `packages/shared/src/pi-tool-effects.ts`                                  | The overlay's own wiring: the route, the repository, the flag or the registration the overlay's capability needs. The core's behaviour is unchanged without the overlay. |
| `packages/shared/src/rbac.ts`                                             | The overlay's own wiring: the route, the repository, the flag or the registration the overlay's capability needs. The core's behaviour is unchanged without the overlay. |
| `packages/shared/src/types/index.ts`                                      | The overlay's own wiring: the route, the repository, the flag or the registration the overlay's capability needs. The core's behaviour is unchanged without the overlay. |
| `packages/shared/src/types/integrations.ts`                               | The overlay's own wiring: the route, the repository, the flag or the registration the overlay's capability needs. The core's behaviour is unchanged without the overlay. |
| `packages/shared/src/types/mcp-read.ts`                                   | The overlay's own wiring: the route, the repository, the flag or the registration the overlay's capability needs. The core's behaviour is unchanged without the overlay. |
| `packages/shared/src/types/sandbox-events.ts`                             | The overlay's own wiring: the route, the repository, the flag or the registration the overlay's capability needs. The core's behaviour is unchanged without the overlay. |
| `packages/web/src/components/session-timeline.tsx`                        | The overlay's own wiring: the route, the repository, the flag or the registration the overlay's capability needs. The core's behaviour is unchanged without the overlay. |
| `packages/web/src/components/settings/mcp-servers-settings.tsx`           | The overlay's own wiring: the route, the repository, the flag or the registration the overlay's capability needs. The core's behaviour is unchanged without the overlay. |
| `packages/web/src/lib/timeline-items.ts`                                  | The overlay's own wiring: the route, the repository, the flag or the registration the overlay's capability needs. The core's behaviour is unchanged without the overlay. |
| `scripts/tmp-rebuild-all.cjs`                                             | The overlay's own wiring: the route, the repository, the flag or the registration the overlay's capability needs. The core's behaviour is unchanged without the overlay. |

### The core test files the overlay edits

| The file                                                                                            | What the overlay changes                                                               |
| --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `packages/control-plane/src/pi/capability-snapshot.test.ts`                                         | The expectation for the overlay's own capability. The core's assertions are unchanged. |
| `packages/control-plane/src/pi/mcp-extension.test.ts`                                               | The expectation for the overlay's own capability. The core's assertions are unchanged. |
| `packages/control-plane/src/router.policy.test.ts`                                                  | The expectation for the overlay's own capability. The core's assertions are unchanged. |
| `packages/control-plane/src/session/http/handlers/mcp-session.handler.test.ts`                      | The expectation for the overlay's own capability. The core's assertions are unchanged. |
| `packages/control-plane/src/session/http/handlers/pi-bridge.handler.test.ts`                        | The expectation for the overlay's own capability. The core's assertions are unchanged. |
| `packages/control-plane/src/session/http/routes.combined.test.ts`                                   | The expectation for the overlay's own capability. The core's assertions are unchanged. |
| `packages/control-plane/src/session/schema.test.ts`                                                 | The expectation for the overlay's own capability. The core's assertions are unchanged. |
| `packages/control-plane/test/integration/__snapshots__/hono-route-catalog-conformance.test.ts.snap` | The expectation for the overlay's own capability. The core's assertions are unchanged. |
| `packages/control-plane/test/integration/__snapshots__/route-admission-matrix.test.ts.snap`         | The expectation for the overlay's own capability. The core's assertions are unchanged. |
| `packages/control-plane/test/integration/hono-route-catalog-conformance.test.ts`                    | The expectation for the overlay's own capability. The core's assertions are unchanged. |
| `packages/control-plane/test/integration/pi-end-to-end.test.ts`                                     | The expectation for the overlay's own capability. The core's assertions are unchanged. |
| `packages/control-plane/test/integration/pi-export-projection.test.ts`                              | The expectation for the overlay's own capability. The core's assertions are unchanged. |
| `packages/control-plane/test/integration/pi-session-do.test.ts`                                     | The expectation for the overlay's own capability. The core's assertions are unchanged. |
| `packages/shared/src/migration-reservations.test.ts`                                                | The expectation for the overlay's own capability. The core's assertions are unchanged. |
| `packages/shared/src/pi-feature-capabilities.test.ts`                                               | The expectation for the overlay's own capability. The core's assertions are unchanged. |
| `packages/shared/src/rbac.test.ts`                                                                  | The expectation for the overlay's own capability. The core's assertions are unchanged. |
| `packages/web/src/components/settings/mcp-servers-settings.test.tsx`                                | The expectation for the overlay's own capability. The core's assertions are unchanged. |

---

## The warnings the judge reads

### The shared MCP client is core, with one history repair (OVL-1)

`packages/control-plane/src/session/mcp-shared-client.ts` is **CORE**, not an overlay hook. It
implements a complete transport for deployment-owned shared MCP servers: repository scope, reviewed
read-only tools, a deployment credential closed over by the call, a bounded deadline, provider-error
containment, exact-host/HTTPS egress checks, and rejection of echoed configured credentials. None of
those semantics is personal MCP. A thin hook would only register an overlay implementation through a
core extension point; this file opens the transport and enforces the transport boundary itself.

The history currently places the original client in core commit `5cc5221f`, but commit `009ef322`
adds its egress and credential-containment guards after `oi-core-end`. That is a placement error,
not a reason to call the client a hook. The exact history repair is:

1. split the shared-client hunk out of `009ef322` into a core commit immediately after `6c84f37e`;
2. put `mcp-shared-client.test.ts`, `mcp/credential-values.ts`, and the already-written
   `mcp/{remote-url-policy,egress-policy}{,.test}.ts` in that same core commit, so the core client
   has no dependency on overlay-classified code;
3. move `oi-core-end` to that commit, immediately before `ed993923`; and
4. leave the personal broker, OAuth provider, personal handler and overlay composition hunks in the
   overlay commits that already own them.

This is a move with tests, not a relaxation: the exact-host/HTTPS/private-literal checks and
recursive credential-echo rejection must cross the boundary intact. Duplicating or deleting either
guard would weaken the transport and is not an acceptable way to satisfy OVL-1.

### Reference tests replaced by stricter reviewer fixes (KEEP-1)

These titles tested behavior that is intentionally no longer permitted or was replaced by Pi 1.4.
They were not removed to hide failures; each was replaced by a stricter regression test for the new
boundary.

| Removed reference title                                                                     | Why it no longer describes permitted behavior                                                                                                                                     | Replacement                                                                               |
| ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `reads a page as markdown`                                                                  | Browser Rendering cannot constrain redirects and subresources, so it must never fetch.                                                                                            | `fails closed when the binding cannot constrain redirects and subresources`               |
| `cuts a page that is longer than the bound`                                                 | The transport rejects before receiving page bytes; bounding a forbidden response is unreachable.                                                                                  | `fails closed when the binding cannot constrain redirects and subresources`               |
| `cuts a screenshot that is longer than the bound`                                           | The transport rejects before receiving screenshot bytes; bounding a forbidden response is unreachable.                                                                            | `fails closed when the binding cannot constrain redirects and subresources`               |
| `never carries the provider's own error to the model`                                       | The Browser Rendering provider is never called, so it cannot return an error to sanitize.                                                                                         | `fails closed when the binding cannot constrain redirects and subresources`               |
| `uses Pi's accumulated per-request costs across models, child work, compaction, and tools`  | Runtime-supplied prices are no longer trusted or used for accounting.                                                                                                             | `prices measured usage only through the server-held price table`                          |
| `rejects malformed provider cost totals instead of guessing`                                | Runtime-provided cost totals are ignored rather than validated as authority.                                                                                                      | `prices measured usage only through the server-held price table`                          |
| `keeps active A and explicit steer/follow-up controls attributed to one conversation`       | Direct follow-up is outside Open-Inspect's one-processing-message model and is now schema-refused.                                                                                | `refuses direct follow-up controls instead of creating a parallel turn`                   |
| `says plainly that a Pi session's own durable record is not in the export`                  | SessionDO's canonical projection is the authoritative export; declaring it incomplete violated G-5.                                                                               | `exports Pi through the canonical projection without an incomplete parallel marker`       |
| `advertises agent messaging only for explicitly allowed session origins`                    | Direct native messaging/follow-up is disabled, matching ColeMurray/background-agents PR [#2467](https://github.com/ColeMurray/background-agents/pull/2467)'s settlement boundary. | `packages subagents separately so children retain the core Open-Inspect extension`        |
| `gives same-session agent controls stable idempotency keys`                                 | Model-visible direct agent controls are no longer installed, so there is no effect to key or replay.                                                                              | `packages subagents separately so children retain the core Open-Inspect extension`        |
| `rejects a fifth active same-session subagent before creating its conversation`             | Four total threads includes the parent, so the fourth child—not the fifth—is now refused.                                                                                         | `rejects a fourth active subagent so parent plus children stay capped at four`            |
| `dynamically denies new run, build, and test calls without affecting Code Mode`             | Computer 0.6 adds a separately gated execution backend to the same emergency-policy vocabulary.                                                                                   | `dynamically denies Computer, run, build, and test execution without affecting Code Mode` |
| `forwards canonical browser identity into SessionDO`                                        | Browser execution remains unavailable unless the owning session can enforce the request boundary.                                                                                 | `blocks the browser when the session cannot be asked`                                     |
| `forwards verified Slack actor identity and only explicit Slack actions`                    | Slack may no longer start model work through Pi controls outside the canonical queue.                                                                                             | `denies Slack messaging controls that bypass the canonical queue`                         |
| `loads through SWR and refreshes after an explicit action`                                  | The composer was removed; the hook now refreshes only after an authorized lifecycle action.                                                                                       | `loads through SWR and refreshes after a lifecycle action`                                |
| `maps Computer results onto the Pi Durable 1.3 output contract`                             | The runtime is now Pi 1.4; the output mapping remains covered without pinning the obsolete minor.                                                                                 | `maps Computer results onto the Pi Durable output contract`                               |
| `prefers the native wake contract when the harness exposes it`                              | Agents 0.30 and Pi 1.4 make native `onWake` mandatory; the compatibility wake shim was deleted.                                                                                   | `resumes the Pi harness after object eviction so pending work continues`                  |
| `reports active work so the host keeps the object alive`                                    | PiHarness now owns the one durable wake job and active/sleeping lifecycle.                                                                                                        | `resumes the Pi harness after object eviction so pending work continues`                  |
| `reports no wake when nothing is pending`                                                   | PiHarness now completes its wake job when Pi reports no work.                                                                                                                     | `resumes the Pi harness after object eviction so pending work continues`                  |
| `reports that the derived wake is in use on the published release`                          | The derived wake implementation was deleted after Agents 0.30 gained Pi 1.4 support.                                                                                              | `opens Pi SQLite at irreversible schema v2 with sleeping task support`                    |
| `reports the earliest durable deadline when idle`                                           | Pi 1.4's native sleeping status and `onWake` own durable deadlines.                                                                                                               | `opens Pi SQLite at irreversible schema v2 with sleeping task support`                    |
| `resumes the harness`                                                                       | PiHarness resumes through Lifecycle after eviction rather than a local compatibility controller.                                                                                  | `resumes the Pi harness after object eviction so pending work continues`                  |
| `survives a restart while a native control submission is in flight`                         | Direct model-producing controls were removed; only queued prompts and queued compaction may run models.                                                                           | `refuses direct model-producing Pi controls without creating parallel work`               |
| `projects a human control once into SessionDO while keeping Pi assistant state subordinate` | Direct human model controls were removed instead of maintaining a second message lane.                                                                                            | `refuses direct model-producing Pi controls without creating parallel work`               |
| `terminalizes callbacks and applies their cost exactly once`                                | Cost now enters only through canonical event ingestion, not the control callback.                                                                                                 | `terminalizes callbacks and leaves cost to canonical event ingestion`                     |
| `routes bounded same-session agent controls through active SessionDO authority`             | Same-session model controls were removed because they formed a second turn-admission path.                                                                                        | `refuses same-session model controls instead of forwarding a parallel turn`               |
| `rejects a write when personal failure wins after route authorization`                      | Failed sessions remain promptable, so an already-authorized memory write must use the same promptable-status contract rather than a stricter two-status copy.                     | `allows a write when promptable status personal failure wins after route authorization`   |
| `rejects a write when failed wins after route authorization`                                | Failed sessions remain promptable, so rejecting the commit-time write would diverge from canonical session admission.                                                             | `allows a write when promptable status failed wins after route authorization`             |
| `rejects a write when completed wins after route authorization`                             | Completed sessions remain promptable, so rejecting the commit-time write would diverge from canonical session admission.                                                          | `allows a write when promptable status completed wins after route authorization`          |

#### Rebuilt bridge replacements

The rebuilt core split these former all-in-one bridge checks across narrower authority boundaries;
the original titles remain recorded here so retention is explicit:

- `cancels a prepared effect without needing an approval` →
  `cancels an approved effect that nobody wanted`.
- `fails closed before persistence while the capability is disabled` →
  `refuses a new effect when the live deployment policy denies it`.
- `lets an authenticated human approve and inspect a prepared action` → route decision authority
  plus `lists an awaiting effect with its exact target and arguments`.
- `lists a publication only for a provider the deployment holds a credential for` →
  `registers only the providers the deployment named`.
- `lists no publication when the deployment holds no credential` →
  `registers nothing when the deployment named no provider`.
- `marks transient provider materialization failures as retryable` →
  `redacts provider details while preserving retry classification`.
- `never returns an internal failure reason to the approver` →
  `survives a malformed provider response without leaking it`.
- `prepares and reads actions only for the active Pi operation` →
  `binds a new real Pi call to approval and executes only through SessionDO`.
- `reauthorizes the exact automation grant at execution claim` →
  `returns a grant only for the automation's current executor`.
- `recovers SessionDO baselines after a crash before Pi persisted its pins` → immutable pin
  restoration plus `retains baseline overlays and changes across a workspace restart`.
- `refuses a new effect while the live deployment mode denies it` →
  `refuses a new effect when the live deployment policy denies it`.
- `refuses an approval while the live deployment mode denies it` →
  `keeps an already prepared effect reachable when the live policy denies new effects`.
- `refuses execution when no provider executor is bound` →
  `refuses a provider that has no definition`.
- `rejects materialization at a full SHA other than SessionDO's claimed baseline` →
  `accepts only full immutable repository pins` plus the SessionDO baseline check.
- `renders the session's memory into the prompt and omits it when there is none` →
  `refetches rendered memory before every model request`.
- `resolves and claims repository heads only for an explicit lazy pin request` →
  `pins each session repository to one immutable default commit`.
- `restores durable repository pins without resolving branch heads` →
  `restores durable pins without resolving mutable branch heads`.
- `returns lightweight repository identities without resolving heads` → bootstrap remains
  metadata-only while pin and restore own resolution.
- `returns one credential-free materialization only for a Pi session` →
  `accepts a credential-free bounded materialization manifest`.
- `serves the rendered memory in the Pi session context` →
  `serves rendered memory only for an authorized live Pi turn`.
- `still lets an approver deny or cancel while the live mode denies new effects` → prepared effects
  remain reachable and cancellation has its own durable lifecycle proof.

### The other local branches (SHAPE-3)

The judge finds two local branches besides this one: `docs/opencode-v2-migration-plan` and
`docs/opencode-workerd-execution-plan`. **Both are upstream's**, not this branch's: they are
documentation branches that came with the repository, they are untouched by this work, and nothing
here is cherry-picked from either. This branch is `compound/pi-overlay`, its history is linear on
`origin/main`, and its own work lives in the commits the `oi-core-end` tag divides.

### The type and lint escapes (TEST-3)

The branch adds 159 type or lint escapes. Every one of them is listed here with the reason it is
there.

The three assertions in `packages/control-plane/test/integration/session-do-access.ts` are confined
to the test-only Durable Object accessor. They merge registered extension internals into the core
component graph for overlay integration tests without exposing overlay types in production.

| The file                                                                         | The escapes | Why they are there                                                                                                                                                                                                                                                  |
| -------------------------------------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `features/pi-first-class/OI-CONFORMANCE.md`                                      | 1           | The audit document quotes the check's own code, including the cast it names.                                                                                                                                                                                        |
| `features/pi-first-class/PI-MCP-RESOURCES-AUDIT.md`                              | 1           | The audit document quotes the check's own code, including the cast it names.                                                                                                                                                                                        |
| `packages/control-plane/src/cloudflare/binding-scope.test.ts`                    | 1           | A test builds a binding map whose keys it only knows at runtime.                                                                                                                                                                                                    |
| `packages/control-plane/src/cloudflare/mcp-connection-durable-object.ts`         | 10          | The composition root is the one place allowed to resolve the keyring, the encrypted D1 adapter and the D1 authority it writes; each suppression says which boundary it is and why it is safe.                                                                       |
| `packages/control-plane/src/cloudflare/pi-durable-object.ts`                     | 6           | The object's own storage and event values cross a JSON boundary the runtime types more narrowly than the data it carries.                                                                                                                                           |
| `packages/control-plane/src/cloudflare/pi-runtime-dispatch.ts`                   | 1           | The dispatch stub is reached over RPC, so its shape is asserted rather than typed.                                                                                                                                                                                  |
| `packages/control-plane/src/db/mcp-server-reviews.test.ts`                       | 3           | A test asserts on D1's own result type, which the driver declares more loosely than the row it returns.                                                                                                                                                             |
| `packages/control-plane/src/harness/emergency-policy.test.ts`                    | 1           | A test stands in a hook API whose memo is the only member the policy uses.                                                                                                                                                                                          |
| `packages/control-plane/src/mcp/encrypted-oauth-provider.ts`                     | 1           | The provider stores its records in the Durable Object's own storage, whose type the provider does not narrow further.                                                                                                                                               |
| `packages/control-plane/src/pi/computer-workspace-policy.test.ts`                | 1           | A test stands in a hook API whose memo is the only member the policy uses.                                                                                                                                                                                          |
| `packages/control-plane/src/pi/computer-workspace-quota.test.ts`                 | 1           | A test stands in a workspace whose quota surface is wider than the quota check reads.                                                                                                                                                                               |
| `packages/control-plane/src/pi/emergency-policy-vocabulary.test.ts`              | 1           | A test stands in a hook API whose memo is the only member the policy uses.                                                                                                                                                                                          |
| `packages/control-plane/src/pi/event-translator.test.ts`                         | 11          | The translator's events are the runtime's own union, whose variants the test builds directly.                                                                                                                                                                       |
| `packages/control-plane/src/pi/inspection-sanitizer.ts`                          | 1           | The sanitizer redacts an arbitrary JSON value, so the redacted shape is asserted through the JSON type.                                                                                                                                                             |
| `packages/control-plane/src/pi/mcp-extension.test.ts`                            | 2           | A test reads a tool's JSON schema, whose shape the schema type does not narrow.                                                                                                                                                                                     |
| `packages/control-plane/src/pi/memory-extension.ts`                              | 3           | The memory tool's own arguments cross a JSON boundary the runtime types more narrowly than the data it carries.                                                                                                                                                     |
| `packages/control-plane/src/pi/model-image-support.ts`                           | 1           | The image support table reads a model's capabilities, whose shape the runtime types more narrowly than the data it carries.                                                                                                                                         |
| `packages/control-plane/src/pi/open-inspect-extension.test.ts`                   | 1           | A test stands in the repository facade the extension calls.                                                                                                                                                                                                         |
| `packages/control-plane/src/pi/pi-telemetry.test.ts`                             | 4           | The telemetry sink is the runtime's own event type, whose variants the test builds directly.                                                                                                                                                                        |
| `packages/control-plane/src/pi/repository-editing-capability.test.ts`            | 7           | A test stands in the source-control provider the capability writes through.                                                                                                                                                                                         |
| `packages/control-plane/src/pi/sandbox-execution-extension.test.ts`              | 1           | A test stands in the execution coordinator the extension starts work with.                                                                                                                                                                                          |
| `packages/control-plane/src/pi/tool-policy-extension.test.ts`                    | 1           | A test stands in a hook API whose memo is the only member the policy uses.                                                                                                                                                                                          |
| `packages/control-plane/src/pi/workspace-input-compatibility.test.ts`            | 1           | A test stands in the workspace the compatibility check reads.                                                                                                                                                                                                       |
| `packages/control-plane/src/sandbox/providers/modal-backends.test.ts`            | 1           | A test asserts on the provider's own response body, which the client types more loosely than the data it carries.                                                                                                                                                   |
| `packages/control-plane/src/session/diffs/service.test.ts`                       | 2           | A test stands in the diff repository the service reads.                                                                                                                                                                                                             |
| `packages/control-plane/src/session/external-action-audit-outbox.ts`             | 1           | The outbox records an audit row whose payload is free-form JSON.                                                                                                                                                                                                    |
| `packages/control-plane/src/session/external-action-gateway.ts`                  | 4           | The gateway exchanges free-form JSON with the approval ledger, whose shape the transport types more loosely than the data it carries.                                                                                                                               |
| `packages/control-plane/src/session/external-action-lifecycle.test.ts`           | 1           | A test stands in the ledger the lifecycle reads.                                                                                                                                                                                                                    |
| `packages/control-plane/src/session/external-action-providers/registry.test.ts`  | 1           | A test stands in a provider's own descriptor, whose shape the registry types more loosely than the data it carries.                                                                                                                                                 |
| `packages/control-plane/src/session/http/handlers/cross-session.handler.test.ts` | 1           | A test stands in the authority the handler consults.                                                                                                                                                                                                                |
| `packages/control-plane/src/session/http/handlers/pi-memory.handler.test.ts`     | 1           | A test stands in the memory service the handler writes through.                                                                                                                                                                                                     |
| `packages/control-plane/src/session/http/handlers/pi-result.handler.test.ts`     | 3           | A test stands in the Durable Object stub the handler calls.                                                                                                                                                                                                         |
| `packages/control-plane/test/codemode-integration/pi-codemode-session.test.ts`   | 4           | A test stands in the sandbox facade the Code Mode session calls.                                                                                                                                                                                                    |
| `packages/control-plane/test/integration/helpers.ts`                             | 1           | The helper binds a session's Durable Object under a namespace the test owns.                                                                                                                                                                                        |
| `packages/control-plane/test/integration/mcp-connections.test.ts`                | 2           | A test asserts on D1's own result type, which the driver declares more loosely than the row it returns.                                                                                                                                                             |
| `packages/control-plane/test/integration/pi-end-to-end.test.ts`                  | 2           | The test stands in the runtime's provider and reads the object's own models registry.                                                                                                                                                                               |
| `packages/control-plane/test/integration/pi-export-projection.test.ts`           | 2           | The test stands in the runtime's provider and reads the object's own models registry.                                                                                                                                                                               |
| `packages/control-plane/test/integration/pi-session-creation.test.ts`            | 2           | A test stands in the Durable Object stub the session creation calls.                                                                                                                                                                                                |
| `packages/control-plane/test/integration/pi-session-do.test.ts`                  | 58          | The test reaches the Durable Object's own internals — its bindings, its models registry, its accounting totals, its alarm — which the class does not export; each cast is the test's way in, and none of them grants the object a binding it does not already have. |
| `packages/control-plane/test/integration/sandbox-early-connect.test.ts`          | 1           | A test reads the runtime's own readiness outcome.                                                                                                                                                                                                                   |
| `packages/slack-bot/src/routes/events.test.ts`                                   | 3           | A test stands in the bot's own bindings.                                                                                                                                                                                                                            |
| `packages/slack-bot/src/sessions/control-plane-client.test.ts`                   | 1           | A test reads the fetch call the client made.                                                                                                                                                                                                                        |
| `packages/slack-bot/src/sessions/session-launcher.ts`                            | 1           | The launcher forwards the platform's own request body, which the platform types more loosely than the data it carries.                                                                                                                                              |
