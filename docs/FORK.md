# FORK.md

`mauricedesaxe/background-agents` is a **tracked fork** of
[`ColeMurray/background-agents`](https://github.com/ColeMurray/background-agents). This file records
what diverges on purpose, why each divergence exists, and the rules that keep a sync from silently
dropping one. It exists because that analysis has now been produced and lost twice, and a sync that
starts by re-deriving it starts by getting it wrong.

**Posture.** Upstream's architecture is adopted wholesale, including refactors that change no
behaviour on their own, because sharing their file shape is what keeps the next fix cheap.
Divergence is a listed exception, not an accumulating default. Anything not on the list below is
either a bug or a sync we have not done yet, and in both cases the answer is to take upstream's
version.

The convergence effort itself is tracked in
[#78](https://github.com/mauricedesaxe/background-agents/issues/78). Everything below was verified
against the tree, not against memory, at merge base `0a753421` and upstream pin `3e344bd0`. Both
move, so recompute them rather than trusting them: `git merge-base HEAD upstream/main`.

## The permanent divergences

Each of these is ours by design. A sync proposes changing one only with a reason that beats the one
recorded here.

### 1. The agent harness is installed into the sandbox image

Every provider's image build runs
`packages/sandbox-runtime/src/sandbox_runtime/scripts/install-harness.sh`, which clones
[`lazar-harness`](https://github.com/mauricedesaxe/lazar-harness) at a pinned commit and runs its
own `install.sh`. A sandbox agent then reads the same skills, agents, and philosophy a laptop agent
reads.

**Why.** The harness used to be copied into `sandbox_runtime/` by hand and it drifted: the sandbox's
philosophy carried a section the harness had already dropped, and its `clarity-reviewer` never got
the OpenCode dialect. Installing from the harness's own installer makes drift impossible. The pin is
a commit rather than a branch so two builds of the same source produce the same image.

`github-bot`'s PR review prompt (`packages/github-bot/src/prompts.ts`) invokes `lazar-review` by
name, which is the same divergence reaching a second package.

### 2. Daytona is the provider we actually run

Upstream ships several providers and we retain all of them; the ones we do not run diverge only
through the shared harness install. Daytona is the one under load here, so it carries fork-local
work: sizing applied to the snapshot rather than the create call, 4 GiB sandboxes with a readable
OOM cause, a 24-hour auto-archive default instead of 7 days, and a stop that retries across the
provider's state-change settle.

**Why.** Each of these was a production incident, not a preference. The 7-day auto-archive plus a
300 GiB account disk cap produced a recurring "timed out waiting to connect" outage. The 1 GiB
default OOM-killed OpenCode mid-build and surfaced as an unreadable stream error.

Providers we do not run are kept, not pruned, and their only local change is the one-line call into
`install-harness.sh` that every image build shares. Pruning them would create divergence to save
nothing.

### 3. The idle window is 7 minutes, not 15

`INACTIVITY_TIMEOUT_MS` and `INACTIVITY_EXTENSION_MS` in
`packages/control-plane/src/sandbox/lifecycle/decisions.ts` sum to 7 minutes where upstream's
`DEFAULT_INACTIVITY_CONFIG` sums to 15. The extension is bounded, so 7 is a hard upper bound rather
than something a connected client can extend indefinitely.

**Why.** Daytona resumes in place. Stopping early costs one resume on the next prompt and loses
nothing on disk, so a short window is close to free. Before this, roughly 94% of Daytona spend was
idle sandboxes.

### 4. Sandboxes can be archived

`supportsArchive`, `ArchiveConfig`, and `ArchiveResult` in
`packages/control-plane/src/sandbox/provider.ts` have no upstream counterpart at all. Archiving a
session archives its sandbox, and it cascades to the session's children. Pinned by
`packages/control-plane/test/integration/archive-cascade.test.ts`.

**Why.** A stopped Daytona sandbox still holds its disk against the account cap. Only archiving
frees it. Without this the cap is reached and new sandboxes stop booting.

### 5. Child sessions inherit the parent's model, and a zero cap disables fan-out

`packages/control-plane/src/routes/session-child-spawn.ts` resolves the model from the spawn context
rather than accepting a per-child override. A child-session cap of zero turns fan-out off instead of
falling back to a default. Pinned by
`packages/control-plane/test/integration/spawn-children.test.ts`.

**Why.** A fanned-out agent silently running a different model than the one chosen is expensive and
invisible. Every fanned-out agent also gets its own sandbox, so a zero cap is the only way to cap
that cost.

### 6. A session reattaches to its OpenCode conversation and survives compaction

`packages/sandbox-runtime/src/sandbox_runtime/bridge.py` takes a control-plane-supplied
`opencodeSessionId` and reattaches, with a watchdog for messages that arrive before the sandbox is
ready. The same bridge keeps its SSE stream attached after OpenCode emits the first typed
`ContextOverflowError`, allowing OpenCode's native compaction and replay to finish. Repeated or
unrelated errors remain terminal. Automatic overflow recovery persists and renders only its
message-scoped `context_compacted` completion. Manual compaction persists its start and terminal
outcome as timeline events: starts and completions render neutrally, while failures render
destructively. The session UI exposes manual compaction only while idle. Its dedicated protocol
command subscribes to OpenCode events before calling `POST /session/:id/summarize` with the selected
model's flat, case-sensitive `providerID` and `modelID`. Only `session.compacted` is success.
`session.error` is a failure even when the HTTP response is `200`, and a five-minute deadline aborts
OpenCode before the bridge reports a timeout. The operation stays attached to the existing OpenCode
session and is stored outside the prompt transcript. The native endpoint behavior and later message
lineage were
[probed against pinned OpenCode 1.14.41](https://github.com/mauricedesaxe/background-agents/issues/129#issuecomment-5044195365).

Automatic overflow recovery is pinned by
`packages/sandbox-runtime/scripts/reproduce_context_overflow.py` and the compaction cases in
`test_bridge_sse.py`. Manual compaction is pinned by `test_bridge_compaction.py` and the
control-plane WebSocket integration tests.

**Why.** Without reattachment, resuming starts a fresh conversation and the history is gone from the
agent's point of view while still being visible in the UI. Without overflow deferral, the bridge
reports failure and disconnects while OpenCode successfully compacts and recovers in the same
session, so the recovered response never reaches the user.

### 7. The SSE reader is decoupled from the WebSocket send

The bridge enqueues events onto a pump task rather than sending them inline, salvages partial output
when the stream drops, and reports OOM as a readable cause. Pinned by
`packages/sandbox-runtime/tests/test_event_pump.py` and `tests/test_entrypoint_oom.py`.

**Why.** A slow WebSocket send used to back-pressure the SSE reader until the connection died with
`incomplete chunked read`, losing everything the agent had produced in that turn.

### 8. jj is installed in the sandbox and the PR helper is jj-aware

`packages/daytona-infra/src/toolchain.py` installs a pinned, checksum-verified jj binary, and the
pull-request helper finalises `@` before pushing rather than pushing a detached git `HEAD`.

**Why.** The repos this fork works on are jj-colocated. Without the helper fix, a session branches
from a detached HEAD, pushes an empty branch, and opens no PR, with nothing in the output saying
why.

### 9. The tldraw whiteboard

A `BoardRoom` Durable Object, board routes, a live board editor in the session view, and a
`whiteboard` skill in the sandbox. Entirely fork-local: `packages/control-plane/src/board/`,
`packages/control-plane/src/routes/board.ts`, `packages/web/src/components/board-editor.tsx`, and
`packages/sandbox-runtime/src/sandbox_runtime/skills/whiteboard/`.

**Why.** Agents explain systems faster with a diagram than with prose, and a diagram the agent can
edit live beats an exported image.

### 10. Epoch and duration values are branded in control-plane

`packages/control-plane/src/time.ts` brands `EpochMs` and `DurationMs`, and time subtraction goes
through `elapsed()` so the result stays a `DurationMs` all the way to its comparison.

**Why.** `now > config.timeoutMs` compiles exactly as readily as `inactiveTime > config.timeoutMs`,
and only one of them means anything. An epoch timestamp compared against a 10-minute duration is
always true, which is a bug that reads correctly.

### 11. OpenRouter models are in the catalog

`packages/shared/src/models.ts` carries OpenRouter entries that upstream does not have, and the
sandbox sends OpenRouter reasoning effort as an OpenCode variant.

**Why.** Several models we want are only reachable through OpenRouter.

### 12. The automation forward is decoupled from bot dispatch

`packages/github-bot/src/index.ts` extracts the control-plane forward into its own
`forwardNormalizedEvent()`, which runs whether or not the built-in handler threw, where upstream
runs it inline after a handler that can skip it by throwing. Pinned by the fork-only
`packages/github-bot/test/webhook-forward.test.ts`.

**Why.** GitHub already has its 200 by then, because the work runs in `waitUntil`. A forward dropped
here is never redelivered, so the automation silently never fires and nothing records why.

A sync flattening this back inline is the specific risk: upstream keeps editing those same lines,
and its version of the payload fix (`286a82b2`) reads a local that our extraction moved out of
scope. That value is threaded in as a parameter instead. Take upstream's _choice of payload_ on that
line, never its _placement_.

### 13. A fork-local `content-ideas` automation template

`packages/web/src/lib/automation-templates.ts` carries a `content-ideas` template that upstream does
not have and should not receive. It surveys a week of merged pull requests and closed issues and
proposes content ideas from the decisions behind them, posted to Slack.

**Why.** The prompt hardcodes personal context: `alexlazar.dev` as the source of audience and ICP, a
fixed list of exemplar videos defining the format, and two weighting rules that only make sense for
one person's service offering. A generic version would need all of that to come from configuration,
which is more machinery than one template is worth.

Nothing here is enforced by a test, so three things rot silently. The exemplar video list goes stale
as new videos publish, and a format that drifts away from it stops being proposed. The `#content`
Slack channel is named in the prompt, so renaming the channel breaks delivery while the template
still asserts only that _some_ `#channel` was mentioned. And the prompt needs the sandbox to reach
`alexlazar.dev` and YouTube, degrading to generic output rather than failing when it cannot.

It is registered under `data-research`, which is not a clean fit. Adding a category for a single
template was judged not worth the taxonomy change.

### 14. `SessionStatusService` names its DO namespace `sessions`, not `parentSessions`

The sixth constructor parameter of `packages/control-plane/src/session/session-status-service.ts` is
`sessions` here and `parentSessions` upstream. Same binding, same position, different name.

**Why.** Upstream reaches through that namespace for exactly one thing, notifying the parent of a
child update, so `parentSessions` describes every use it has. Our archive cascade also reaches
_children_ through it: `cascadeArchiveToChildren()` resolves each child DO from the same binding. A
parameter called `parentSessions` holding the stub of a child reads as a bug at the call site.

Expect a conflict on the next sync. Upstream edits this constructor whenever it adds a dependency,
and the rename touches the same lines. Take upstream's _parameter list_ and keep our _name_.

### 15. Follow-up prompts remain usable while a session runs

**Why.** The control plane already persisted and drained pending prompts in order, but the web
client disabled delivery while processing and ignored the acknowledgement. Users had to hold
complete work in an unsubmitted textarea until the active run ended, and a disconnected send cleared
that work. The Durable Object's message table remains the only queue; the browser only renders its
snapshot.

### 16. One-shot prompts use replay-safe automation launches

The new-session composer can persist a prompt for one future execution without creating or warming a
session. The scheduler claims the task atomically, then initializes its preassigned session and
message IDs. Matching retries succeed while conflicting ID reuse fails.

**Why.** A scheduler response can be lost after the session or prompt was persisted. Fresh IDs on
retry created duplicate work, while allocating a sandbox during composition defeated scheduling's
main promise that nothing runs before the due time.

### 17. Prompt composers accept draft-only voice input

Both prompt composers can record one browser-native audio clip and send it to an authenticated web
route for OpenAI transcription. The transcript is appended to the editable draft and never submits
itself. Session creation, prompt delivery, persistence, and sandbox protocols remain unchanged.

**Why.** Coding prompts often contain enough paths, symbols, and commands that device dictation is
unreliable. Server-side transcription allows vocabulary steering without exposing the OpenAI key to
the browser, while keeping mistakes visible and editable before they can start agent work.

## Where we match upstream against our own docs

The list above is where we differ from upstream. This is the inverse: a place where matching
upstream puts us at odds with a document in this repo, and matching upstream still wins.

**The sandbox clone identity lives in `packages/control-plane/src/sandbox/sandbox-env.ts`, not under
`source-control/`.** `scmCloneIdentity` maps an SCM provider to the `VCS_HOST` and
`VCS_CLONE_USERNAME` the in-sandbox credential helper uses, plus the hosts its clone-token secret
may be released to. [ADR 0001](adr/0001-single-provider-scm-boundaries.md) says sandbox
credential-helper auth belongs in provider implementations, and the
[provider contribution checklist](provider-contribution-checklist.md) says no provider-specific
token logic outside provider/auth modules. Read literally, both point away from where this sits.

**Why it stays.** Upstream ships that ADR and puts the identity in `sandbox-env.ts` anyway. Moving
it would put us deliberately out of step in a file upstream actively edits, which costs the next
sync the exact thing the posture above buys. The ADR is upstream's to reconcile with its own code.

**What it costs, and what to watch.** Authentication policy now has two owners: this map hardcodes
`x-access-token`, and `source-control/providers/github-provider.ts` independently returns the same
string as the credential broker's username. Nothing fails if they drift, and a drift means the
sandbox authenticates as one identity while the broker vends another. If a third caller appears, or
if either side gains a provider the other lacks, that is the point to collapse them onto one owner
rather than add to the duplication.

Expect a reviewer to flag the placement; upstream's `#1059` (`ef820591`) is the commit that would
re-site it, and taking that is the moment to revisit this note rather than before.

## The reserved migration range

**Fork-local session-schema migrations use identifiers from `FORK_MIGRATION_ID_FLOOR` (9000) up.
Upstream owns everything below it, permanently.**

Session Durable Object migrations live in `packages/control-plane/src/session/schema.ts` and are
applied by identifier. `applyMigrations()` records each applied id in `_schema_migrations` and skips
any id already recorded. There is no content check and no idempotency guard, so an id is a claim on
a slot rather than a description of a change.

**The reserved range is an identity namespace, not an ordering mechanism.** This is the easiest
thing to misread about it. `applyMigrations()` is a set-membership check —
`if (applied.has(migration.id)) continue` — with no sort and no high-water mark. Execution order is
the literal array order of `MIGRATIONS`. So a high id does not mean "runs last", and a fork-local
migration that depends on an upstream one has to be **positioned after it in the array**; an
identifier above the floor buys no sequencing on its own. The range exists so the two sides never
claim the same slot, and it does nothing else.

That makes a collision silent rather than loud. Shared history ends at migration 34. Both sides then
claimed 35 and 36 for entirely different schema changes:

| id  | ours                              | upstream's                         |
| --- | --------------------------------- | ---------------------------------- |
| 35  | `stop_unreconciled_at` on sandbox | create the `attachments` table     |
| 36  | `stop_unreconciled_provider_id`   | durable latest session diff bundle |

A deployed session store that has already run our 35 and 36 has those ids in `_schema_migrations`.
Taking upstream's versions would leave the runner skipping both, so `attachments` and the diff table
would never be created, and the querying code would fail at runtime against a store that reports
itself fully migrated. Nothing in CI catches this, because a fresh store in a test has no rows to
skip.

**The move is done** ([#81](https://github.com/mauricedesaxe/background-agents/issues/81)). Our two
migrations were rewritten as one guarded operation at **9001**, which inspects the store and no-ops
where the change is already present, so a store carrying the old identifiers ends in the same shape
as a fresh one. Ids 35 and 36 are released back to upstream, and taking upstream's schema changes is
no longer blocked.

Renumbering the source was only half of it, because deployed stores still carry rows at 35 and 36.
`releaseRetiredIdentifiers()` deletes those rows, and it runs **before** the runner reads the table,
so upstream's versions apply on the same wake rather than the next one. A session idle across both
deploys would otherwise serve an entire Durable Object lifetime without them.

The part worth not re-deriving is what it keys on. It releases the ids in `RETIRED_LOW_IDS` that
`MIGRATIONS` no longer claims, not a marker row recording that the move ran:

```ts
RETIRED_LOW_IDS.filter((id) => !MIGRATIONS.some((m) => m.id === id));
```

That makes it rollback-proof and self-disabling. A marker row was tried first and is wrong: rolling
back to code that still defines 35 and 36 re-runs them, `runMigration` swallows the resulting
`duplicate column` error, and the rows come back indistinguishable from upstream's. A marker check
would then skip upstream's real migrations forever. Keying on what `MIGRATIONS` claims means every
roll-forward clears the rows again, and adopting upstream's 35 and 36 turns the release off on its
own, because they are claimed again.

## Divergence by package

The shape matters when sequencing a sync. Ordered by how much diverges, heaviest first:

| Package              | What diverges                                               |
| -------------------- | ----------------------------------------------------------- |
| `control-plane`      | Nearly all of our behaviour. By far the heaviest package.   |
| `sandbox-runtime`    | Bridge recovery/reattachment, harness install, whiteboard   |
| `web`                | Board UI, compaction status, sidebar, settings, automations |
| `shared`             | Models, artifacts, compaction event, Slack `truncated`      |
| `github-bot`         | Review prompt sources `lazar-review`; forward decoupling    |
| `daytona-infra`      | Toolchain: jj, sandbox version                              |
| `modal-infra`        | The harness install call in the image build, nothing else   |
| `opencomputer-infra` | The harness install call in the image build, nothing else   |
| `slack-bot`          | Page-cap warning, and a Terraform binding parity guard      |
| `linear-bot`         | **Nothing.** Take upstream wholesale.                       |

Recompute the counts rather than remembering them, since any commit changes them:

```sh
git diff --name-only "$(git merge-base HEAD upstream/main)"..HEAD | grep '^packages/'
```

`linear-bot` is the last package that can be taken whole without a merge, and that stays true only
until someone edits it.

`slack-bot` was in the same position one issue earlier. A sync was written to take both bots
wholesale on the strength of a row like the one above, and by the time it ran a fan-out fix had
landed in `slack-bot`, so the take would have dropped it silently. **Prove divergence per package at
the moment you sync, rather than trusting this table**, which records the last sync and not today.

The behaviour that diverges is documented on `fetchThreadHistory` in
`packages/slack-bot/src/events/message-handler.ts` and pinned by
`warns when the thread came back truncated` in `packages/slack-bot/src/index.test.ts`. It **spans
two packages**, which is the part a sync gets wrong: the flag is produced by `getThreadMessages` in
`packages/shared/src/slack/client.ts` and consumed in `slack-bot`, so taking upstream's version of
_either_ file drops it, and taking the `shared` one breaks the warning from underneath rather than
at the call site. **Upstream has no such signal and its own doc comment asserts the opposite**,
claiming the newest messages survive the page cap; they do not, because pagination runs
oldest-first. That is why this one survives a sync only if someone reads this entry: upstream's
version is not a conflict and not a red test, just a quieter bot.

The neighbouring behaviour, bounding author resolution to the ten retained messages, **is no longer
a divergence**. Upstream has since fixed it the same way, so this fork now matches.
`resolves author names only for the thread messages it keeps` stays as a regression guard, because
nothing upstream pins it.

### The binding parity guard

`packages/slack-bot/src/types/env-terraform-parity.test.ts` and the `tsconfig.test.json` that lets
it use Node APIs are fork-local, and they exist because of a whole class of loss this document
otherwise misses. A Worker binding is declared in two places that no check compares: the `Env`
interface and the Terraform. `SLACK_COMPLETION_QUEUE` shipped in upstream's code with no
corresponding queue in ours, because a convergence took `packages/` and left `terraform/` behind.
Nothing caught it — TypeScript believes `Env`, tests inject their own env, and a plan cannot diff a
binding that was never declared, so the first symptom would have been every Slack completion
callback returning 503 in production.

**A convergence scoped to `packages/` is incomplete.** Upstream ships infrastructure alongside code,
so check `terraform/` for the same commit range whenever a package moves.

## Test files are merged by hand, never taken wholesale

**This applies to every package, every time.** If a port needs one of our tests edited to go green,
the port dropped a behaviour. That is the signal, not a stale test.

The failure mode it prevents is the only genuinely silent one in a sync. Upstream's tests pass
against upstream's behaviour. Replacing one of our test files with theirs therefore goes green at
the exact moment it deletes the evidence that our behaviour ever existed, and nothing anywhere
reports a loss. Everything else in a sync fails as a conflict or a red test.

Roughly half of everything we have diverged is a test file, in both `control-plane` and
`sandbox-runtime`. Those files are where the idle window, the pending-message watchdog, unreconciled
stops, session reattachment, archive cascade, and child model inheritance are actually pinned. They
are the divergence, not documentation of it.

Our tests survive upstream's refactors because they are coupled to collaborator interfaces rather
than to how those collaborators are constructed, and construction is what a dependency-injection
refactor changes. Keep new tests on that side of the line.

## Fork-only files

**Fork-only files stay under `packages/`.** There are three deliberate exceptions outside it, and
each earns it the same way: upstream will never have the file, so it can never conflict during a
sync.

- **This document.** The divergence analysis has been produced and lost twice, so it is committed.
- **`.claude/agents/`.** Repo-local reviewer agents, auto-discovered by `lazar-review` locally and
  by the PR review bot. `fork-divergence-reviewer.md` is the one that keeps this document honest by
  checking its claims against the tree on every PR that touches them.
- **`terraform/d1/migrations/9xxx_*.sql`.** Fork-local D1 schema changes use the reserved 9000+
  range so upstream can keep allocating lower migration identifiers without silently shadowing ours.
  These files stay beside the migration runner that deploys them.

General harness configuration is still not committed here, and the exception above is narrow: a
reviewer that encodes _this repo's_ invariants has nowhere else to live, because a global agent
cannot know them. Tracker configuration and per-repo conventions stay in a machine-local note
outside the repo. A file upstream does not have can never conflict, but it is still a file every
future sync has to reason about, so the count stays low on purpose.
