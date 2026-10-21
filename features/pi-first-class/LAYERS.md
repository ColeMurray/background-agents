# LAYERS.md — the two layers, and the rules that keep them apart

**Status:** Phase 0 (ground) recorded. Phase 2 (the split) in progress. **Branch:**
`feat/pi-go-live-integration-v2` @ `221cef41` — the oracle. It is not restructured.

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

| File today                                                                                                   | Core name                                          | §7 row        | Why it is core                                                                                                                                                                                                                                                                                           |
| ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------- | ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/shared/src/pi-tool-effects.ts`                                                                     | `shared/src/tool-effects.ts`                       | **C1**        | The registry that makes `callers` explicit and `replay` deliberate is harness-neutral by construction: it names tools and effect kinds, not Pi.                                                                                                                                                          |
| `packages/shared/src/pi-feature-capabilities.ts` (the mode machinery only)                                   | `shared/src/capability-modes.ts`                   | **C3**        | `off / read_only / enabled`, "unknown configuration resolves to off", is the gate contract every DO harness needs. The **Pi feature list** stays in the adapter.                                                                                                                                         |
| `packages/shared/src/pi-migration-reservations.ts`                                                           | `shared/src/migration-reservations.ts`             | **G-1 / G-2** | A reservation registry is not Pi-specific; the `pi_do` _store_ is, and stays as one entry in it.                                                                                                                                                                                                         |
| `packages/control-plane/src/pi/tool-policy-extension.ts`                                                     | `control-plane/src/harness/tool-policy.ts`         | **B-6 / D-6** | The default-deny `beforeTool` hook, the emergency policy and the per-call delegate chain are the _authorization_ replacement for the sandbox. It must be callable by any DO harness.                                                                                                                     |
| `packages/control-plane/src/pi/deployment-emergency-policy.ts`                                               | `control-plane/src/harness/emergency-policy.ts`    | **C3**        | The kill switch that re-derives current capability before new risky work is a deployment control, not a Pi one.                                                                                                                                                                                          |
| `packages/control-plane/src/pi/extension-assembler.ts`                                                       | `control-plane/src/harness/extension-assembler.ts` | **C1**        | Slot ordering, duplicate detection, and the rule _"a mutation tool with no owner is refused"_ are the assembly contract any DO harness needs.                                                                                                                                                            |
| `packages/control-plane/src/pi/pricing.ts`                                                                   | `control-plane/src/harness/pricing.ts`             | **H-2**       | **Server-computed** cost from a CP-held price table is the replacement for upstream's trust in runtime-reported cost. It improves every harness, including the sandbox ones.                                                                                                                             |
| `packages/control-plane/src/pi/accounting.ts`                                                                | `control-plane/src/harness/accounting.ts`          | **H-1 / H-2** | Usage → cost → budget, computed on the server.                                                                                                                                                                                                                                                           |
| `packages/control-plane/src/pi/capability-authority.ts` + `capability-authority-client.ts`                   | `control-plane/src/harness/execution-principal.ts` | **B-4**       | §7 B-4 asks for _a harness-neutral, in-process, session-scoped execution principal (capability object)_. Today the property is held implicitly (the DO binding plus an immutable stored session identity); core must hold it **explicitly**, as a named contract.                                        |
| `packages/control-plane/src/session/sandbox-command-repository.ts` + `sandbox-events/command.handler.ts`     | stays                                              | **C5**        | The harness-neutral command-target port: stop hook, `mayDispatch`, typing no-op. Already neutral; this is the upstream's shape.                                                                                                                                                                          |
| `packages/control-plane/src/sandbox/execution-capability.ts` + `execution-isolation.ts`                      | stays                                              | **C10 / D-3** | Escalation to a real sandbox, with the per-turn deadline and the credential lifetime. Already neutral.                                                                                                                                                                                                   |
| `packages/control-plane/src/session/http/handlers/browser-gateway.handler.ts`                                | stays                                              | **D-5**       | The browser gateway: deployment-configured host allowlist, scheme check, no credential on the request. The transport sends **no** credential (`browser-rendering-transport.ts:63` sends only `Accept`).                                                                                                  |
| `packages/control-plane/src/session/diffs/assembler.ts`                                                      | stays                                              | **G-5**       | The export projection.                                                                                                                                                                                                                                                                                   |
| `packages/control-plane/src/db/slack-ingress.ts` + `routes/slack-ingress.ts` + `shared/src/slack-ingress.ts` | stays                                              | **F-4**       | The Slack bot (`packages/slack-bot/src/ingress-authority.ts:68`) already calls it. It is an **ingress** path, not a harness path: durable, idempotent Slack → session. Any harness needs it. **Own PR, own flag** — it changes the Slack path for existing harnesses, so it must not ride the Pi series. |
| `packages/shared/src/memory-tools.ts`                                                                        | stays                                              | **I-1**       | Memory is an Open-Inspect feature (`0084_memories.sql`, `control-plane/src/memory/`); the tool names are the shared contract.                                                                                                                                                                            |

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

| Capability                                                | Files                                                                                                                                                                                                                                                                                                                               | §7 row  | The deviation it buys                                                                                                   |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------- |
| **Personal MCP with OAuth/PKCE/DCR** (C6)                 | `control-plane/src/mcp/**`, `db/mcp-connections.ts`, `db/mcp-session-pins.ts`, `db/mcp-server-reviews.ts`, `db/mcp-read-audit.ts`, `routes/mcp-connections.ts`, `routes/mcp-session-pins.ts`, `session/mcp-shared-client.ts`, `session/http/handlers/mcp-session.handler.ts`, `shared/src/types/mcp-read.ts`, `pi/mcp-extension.ts` | **E-7** | Per-user external credentials, which cut against Open-Inspect's single-tenant grain (§6 of the ledger).                 |
| **MCP OAuth owner flow** (authorize / reconnect / status) | the same MCP set, plus the web client                                                                                                                                                                                                                                                                                               | **E-7** | The owner's half of the credential lifecycle.                                                                           |
| **External actions + approval ledger** (C4)               | `session/external-action-*.ts`, `session/external-action-providers/**`, `routes/session-external-actions.ts`, `routes/automation-external-action-grants.ts`, `db/external-action-audit.ts`, `db/automation-external-action-grants.ts`, `shared/src/types/external-actions.ts`, `pi/external-action-policy-extension.ts`             | **D-6** | A human approval step. Upstream has **no** approval primitive anywhere; unattended runs must decline deterministically. |
| **Cross-session messaging + receipts** (C5)               | `session/cross-session-authority.ts`, `session/http/handlers/cross-session.handler.ts`, `db/cross-session-receipts.ts`, `shared/src/types/cross-session.ts`, `pi/cross-session-extension.ts`                                                                                                                                        | **F-6** | Sessions talking to each other. Upstream has only parent→child, depth ≤ 2.                                              |

**NOT NOW.**

| Item                  | Why                                                                                                                                           |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| **MCP prompts**       | Do not build. An external server would be writing the model's instructions, which breaks **F-5** (untrusted text never becomes instructions). |
| **MCP resources**     | Not now. It replaces a human-reviewed catalogue with server-chosen URIs; it would need re-review and re-pinning.                              |
| **MCP elicitation**   | Not now. It needs the approval primitive (D-6), and both MCP lanes cap a call at 30 s, so a human wait is impossible. Unattended ⇒ decline.   |
| **Mid-turn steering** | Upstream is FIFO, one message at a time. Adding steering would change C2.                                                                     |
| **Pi subagents**      | Unreleased upstream in Pi. Do not build on an unreleased primitive.                                                                           |
| **Virtual models**    | The acting model is extension-controlled, which breaks provider pinning (E-1).                                                                |

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
2. **Delete semantics.** Pi cannot delete a conversation; Open-Inspect's delete is a D1 index row
   and the DO is orphaned (G-4). The decision taken autonomously was to document the orphaning
   rather than purge.
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
