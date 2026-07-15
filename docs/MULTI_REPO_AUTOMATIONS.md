# Multi-Repository Automations

This document records the design decisions behind multi-repository automations: extending an
automation's repository context from zero-or-one repository to a set of up to ten, with each firing
fanning out into one session per repository.

## Goal

Support recurring maintenance across a set of repositories — for example checking `AGENTS.md` in ten
repositories every week, updating each independently, and opening one pull request per repository
where changes are needed.

## The model

```text
automation ── repositories (0..10, the live selection)
    │
    └── invocation                 one per firing (schedule tick, Trigger Now, or event)
          │                        carries the firing-scoped keys and skip reason
          └── runs (0..10)         one per repository, each linked to one session
                └── session        ordinary sandbox session; owns branch, artifacts, PR
```

Every firing — single-repo, multi-repo, repo-less, or skipped — takes the same path: it records one
`automation_invocations` row, and unless it was skipped, one `automation_runs` child per repository.
There is no separate single-repo pipeline and no group-of-N special case; a single-repo firing is
simply an invocation with one run.

**API ↔ UI vocabulary.** The API speaks `automation / repository / invocation / run / session`. The
UI keeps its established "run" copy: the history section is still titled "Run History", the empty
state still says "No runs yet.", and an invocation of one renders exactly like the flat run row
always did. A fan-out invocation renders as one expandable history row whose children are
_repository_ rows.

## Decisions

### Should multi-repo automations create one session per repo?

Answer: yes. A multi-repo firing fans out into one child session per selected repository.

Reasoning: fan-out keeps each repository's checkout, sync state, artifacts, and pull-request flow in
its own session. The _workspace_ variant (one session that clones several repositories for atomic
cross-repo work) shipped later as environment targets: an automation's selection may also name
environments (`environmentIds`), and each firing fans out one run per target — a repository run
works that repository alone, while an environment run launches one session opening that
environment's full workspace (multi-repo sessions design §13.3). Repositories and environments share
the combined target cap and fan out together.

### How is a firing stored?

Answer: as a thin `automation_invocations` row plus per-repository `automation_runs` children. The
invocation row stores identity, source, the firing-scoped dedup/concurrency keys, and a skip reason
— **not** a status.

Reasoning: a stored aggregate status must be kept consistent with the children by read-modify-write,
and any crash or race between "last child completed" and "parent updated" wedges the automation.
Deriving status from the children (one SQL fragment, one TypeScript twin) makes the wedge class
unrepresentable.

### How is invocation status derived?

- no children → `skipped`
- any child `starting`/`running` → `starting` / `running`
- all children terminal: all skipped → `skipped`; none failed → `completed`; none completed →
  `failed`; a mix → `partial_failed`

`partial_failed` preserves the distinction between "the sweep failed everywhere" and "one repository
failed while nine completed".

### What does the run history depend on — the live selection or the firing?

Answer: the firing. Every run snapshots its repository (`repo_owner/repo_name/repo_id/base_branch`)
at firing time; history rendering and the session-creation path read the snapshot, never the
automation's current repository set.

Reasoning: copying each firing's trigger context into an immutable record makes history
self-contained. Once history is self-contained, editing the repository set can never corrupt it —
which is why there is **no edit-while-active guard and no cardinality freeze**: you can add or
remove repositories at any time, including while an invocation is in flight. In-flight children keep
their snapshots; the next firing uses the new set. Earlier drafts blocked repository edits while a
run was active and froze 0/1/N cardinality once history existed; both guards existed only to protect
readers that re-queried the live selection, and snapshots remove that dependency.

### Where does the repository selection live?

Answer: in a normalized `automation_repositories` table — the single source of truth, exposed as
`Automation.repositories`. The automation row itself holds no repository columns.

Reasoning: repository rows need validation, counting, joins, and per-repo fields (base branch today,
possibly per-repo overrides later). A JSON blob would push parsing into every reader; a mode enum
would pack count, absence, and trigger compatibility into one field. Zero rows = repo-less
automation, one row = single-repo, N rows = fan-out — behavior derives from the data.

### Is there a minimum repository count?

Answer: no. `repositories` accepts 0 to `MAX_AUTOMATION_REPOSITORIES` (10) entries; one-element
selections are fine.

Reasoning: with a unified pipeline there is no separate "multi-repo mode" for a minimum to protect.
Requiring 2+ existed to keep two pipelines apart; that fork no longer exists.

### Which trigger types support multiple repositories?

Answer: schedule and manual "Trigger Now" only, in v1. Event triggers (GitHub, Linear, Sentry,
webhook, Slack) stay at 0 or 1 repository.

Reasoning: this is a product scope cut, not an implementation limit — nothing in the unified
pipeline prevents an event invocation from having N children. What is undefined is the product
semantics: should a PR event on repository X fan out work to Y and Z? How does per-key concurrency
(for example per-PR) compose with N children per firing? Until those questions have answers, event
automations keep their current shape. The initial use case is scheduled maintenance.

### Which branch does each repository use?

Answer: each repository entry carries its own `baseBranch`; when omitted it resolves to that
repository's default branch at save time. There is no cross-repo carryover — a branch set for one
repository never leaks onto another.

### Should duplicate repositories be silently deduplicated?

Answer: no. Duplicates (after trim + lowercase normalization) are rejected with a validation error.

Reasoning: silent deduplication makes the API surprising — a client submits one count and persists
another. The UI prevents duplicates; the server enforces the invariant.

### What if one repository becomes inaccessible?

Answer: fail only that child and continue launching the others. If _every_ repository fails
resolution, the invocation is born terminal: it finalizes immediately and counts one failure,
matching the old single-repo behavior for revoked installations.

Reasoning: one stale permission or renamed repository should not block maintenance across the rest
of the set. The failed child carries the failure reason; the invocation derives `partial_failed`.

### Should fan-out be concurrent?

Answer: yes — all repositories of one firing launch concurrently, with the selection capped at
`MAX_AUTOMATION_REPOSITORIES` (10). Across one scheduler tick, child launches are additionally
budgeted (~50) so a tick full of 10-repo automations cannot exhaust the Workers subrequest limit;
automations past the budget stay overdue and are picked up next tick.

### What happens if the next schedule fires while an invocation is active?

Answer: the firing is skipped — recorded as a childless invocation with skip reason
`concurrent_run_active` — and the schedule advances. Scheduled and manual firings block on the whole
automation; event firings block per concurrency key (an active PR-42 run does not block PR-43). A
manual "Trigger Now" against an active invocation is rejected with `409` rather than recorded.

Reasoning: recurring maintenance should not overlap itself. Two details are load-bearing: the skip
is recorded **atomically with the schedule advance** (one D1 batch), so a crash between the two can
never make the tick re-collide on the same cron slot forever; and skip invocations never carry the
event `trigger_key`, so a skip never consumes the dedup slot of the real event delivery.

### Should skipped firings count as failures?

Answer: no. A childless skipped invocation never touches `consecutive_failures`.

Reasoning: the active invocation is already the operational signal; counting the skipped follow-up
would double-count one long-running sweep and could auto-pause a recoverable automation.

### Should repeated partial failures auto-pause the automation?

Answer: yes. Any invocation with at least one failed child counts **one** failure toward the same
3-strike auto-pause threshold as a fully failed invocation. The failure is counted when the first
child fails (via a compare-and-set stamp on the invocation, `failure_counted_at`, so concurrent
completion callbacks, launch failures, and recovery sweeps count it exactly once), not when the last
child finishes.

Reasoning: a weekly sweep that fails one repository every week is still broken and should not run
unattended forever. Counting early keeps parity with the old behavior, where a failure incremented
the counter the moment it happened.

### Should auto-pause cancel in-flight children?

Answer: no. Auto-pause stops future firings; children that already started run to completion.

Reasoning: sibling repositories may still finish successfully after the first failure. Letting them
continue preserves useful work and gives the history an accurate final outcome.

### When does the failure counter reset?

Answer: only when an invocation finishes with **every** child completed. `partial_failed` never
resets the counter.

Reasoning: a fully successful sweep means the automation has recovered; a partially successful one
does not. This matches the single-repo behavior (one completed run resets) because a single-repo
invocation with a completed child _is_ an all-completed invocation. Crash windows around
finalization are closed by a bounded recovery sweep that finds recent all-terminal invocations with
missed accounting.

### Should manual "Trigger Now" affect the schedule?

Answer: no. Manual invocations never advance or delay `next_run_at`; the cron cadence stays fixed.
Manual firings are allowed while the automation is paused (operators need to verify a fix before
resuming), a successful manual invocation resets the failure counter without resuming, and a failed
one counts toward auto-pause like any other.

### How do retries work?

Answer: there is no modeled retry in v1 — parity with the previous behavior. An invocation runs each
repository exactly once; a failed child stays failed. The operator recourse is "Trigger Now", which
starts a fresh invocation across the full selection. The anticipated future shape is a "re-run
failed repositories" affordance that creates a **new invocation linked to the original** (snapshot =
the failed subset) rather than mutating history.

### How should the repository picker work?

Answer: the selection drives everything — no mode switch to understand first. Selecting no
repository creates a repo-less automation, one repository a single-repo automation, several (on
schedule triggers) a fan-out automation. The form always submits the full `repositories` list.

### Should instructions be per-repository?

Answer: no. One shared instruction prompt; each child session receives its own repository context.
Per-repo overrides can be added later if a real use case appears.

### How should pull requests work?

Answer: unchanged. Each child session owns its repository, branch, artifacts, and PR creation. The
invocation aggregates links for display only; there is no cross-repository "mega" PR.

## API surface

- `GET /automations/:id/invocations` — the history endpoint: one entry per firing
  (`{invocations, total}`), each carrying its child `runs` with repository snapshots. `total` counts
  invocations.
- `POST /automations/:id/trigger` — returns `201 {invocationId, runs}`; `409` when blocked by an
  active invocation.
- Repository selection is written via `repositories: [{repoOwner, repoName, baseBranch?}]` on
  create/update.

## Deployment notes

### Migrations 0030 + 0031

`0030` adds the `automation_repositories` and `automation_invocations` tables and backfills them
from the pre-feature `automations.repo_*` scalars and the legacy `automation_runs` rows; it is
replay-safe by construction (safe to rerun after a partial apply — a failed version-marker insert, a
half-applied column add, or a midway replay). `0031` then drops the now-redundant scalar mirror and
frozen firing-key columns (`automations.repo_*`;
`automation_runs.trigger_key/concurrency_key/trigger_run_metadata`) and their indexes. The two apply
in order, so the backfill always runs before the drop: an instance upgrading from before this
feature migrates its existing automations and runs in the same deploy.

Dropping `automations.repo_*` needs a table rebuild (SQLite cannot `DROP COLUMN` a column named by a
CHECK, and `0029` added `repo_*` CHECKs). D1 runs each migration as one FK-enforced transaction and
rejects `PRAGMA foreign_keys = OFF` mid-transaction, and `defer_foreign_keys` does not rescue a
_parent_ rebuild: `DROP TABLE automations` books a deferred FK violation for every child row
(`automation_runs` / `automation_invocations` / `automation_repositories` all reference
`automations(id)`), and the `RENAME` never credits them back, so the commit is refused once real
child rows exist. `0031` therefore stages each child, drops the three child tables (releasing their
FK claims), rebuilds `automations` clean, then recreates the children verbatim and repopulates them.
Every id is preserved, so all foreign keys hold at commit. This was caught by a failed production
apply — a plain `defer_foreign_keys` rebuild passes on an empty test DB but fails against a
backfilled one.

Because `0031` drops columns the previous schema depended on, this feature is **not code-revertible
without a database restore** — the pre-feature worker reads `automations.repo_*`, which no longer
exist. Snapshot D1 before applying if you want a rollback path.
