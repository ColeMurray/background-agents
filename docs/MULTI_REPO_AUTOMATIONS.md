# Multi-Repository Automations

This document records the design decisions for extending repository automations from one fixed
repository or no repository to a fixed set of repositories.

## Goal

Support weekly maintenance automations such as checking `AGENTS.md` across 10 repositories, updating
each repository independently, and opening one pull request per repository when changes are needed.

## Decisions

### Should multi-repo automations create one session per repo?

Answer: yes. A multi-repo automation fans out into one child session per selected repository.

Reasoning: the existing session model is single-repository: each session has one repository, base
branch, branch, sync state, artifacts, and pull request flow. Keeping sessions single-repo avoids
cross-repo checkout and PR coordination inside one sandbox.

### Should weekly results be grouped?

Answer: yes. A scheduled fan-out should appear as one grouped automation run with per-repository
child results.

Reasoning: users need to answer whether a weekly sweep passed everywhere. A group can show aggregate
state such as 8 completed, 1 failed, and 1 running, instead of requiring users to correlate multiple
rows with the same timestamp.

### Should each repo use its default branch?

Answer: yes for v1. Do not add per-repository branch overrides yet.

Reasoning: weekly maintenance should normally target each repository's default branch. Per-repo
branch overrides add schema and UI complexity and can be added later to target rows if needed.

### Which trigger types should support multiple repositories?

Answer: only scheduled automations and manual "Run now" in v1.

Reasoning: GitHub and Linear events already arrive scoped to a repository. Slack, webhook, and
Sentry fan-out semantics need additional safety and UX rules. The initial use case is scheduled
maintenance.

### Should grouped runs be first-class records?

Answer: yes. Add a grouped run record and link child runs to it.

Reasoning: inferring groups from timestamps is fragile, and the current `automation_runs` model has
a uniqueness constraint around one run per automation schedule. A first-class group also gives a
stable place for aggregate status, counts, and drill-down.

### How should grouped run history appear?

Answer: collapsed by default, expandable inline.

Reasoning: the normal run history should remain readable. A group row can show scheduled time,
aggregate status, repo count, child status counts, and duration. Expanding shows each repository
child with status, session link, and pull request artifact link where available.

### How should partial failures be represented?

Answer: use a distinct group status such as `partial_failed`.

Reasoning: a sweep where some repos complete and some fail is not the same as a total failure. The
group status should preserve that distinction. `partial_failed` can be active while sibling child
runs are still running; in that state `completed_at` stays null, the group still blocks overlap, and
the group failure is counted once immediately.

### Should repeated partial failures auto-pause the automation?

Answer: yes. Count `partial_failed` groups against the same consecutive failure threshold as fully
failed groups.

Reasoning: a weekly sweep that fails one repository every week is still broken and should not run
forever unattended. Counting partial failures keeps the failure policy simple and makes stale
repository permissions visible.

### Should auto-pause cancel in-flight child runs?

Answer: no. Auto-pause should stop future scheduled runs, not cancel child sessions that already
started.

Reasoning: sibling repositories may still finish successfully after the first child failure. Letting
them continue preserves useful work and gives the group history an accurate final outcome across the
selected repositories.

### Should a fully successful group reset consecutive failures?

Answer: yes. Reset `consecutive_failures` when every child run in a group completes successfully.

Reasoning: a fully successful sweep means the automation has recovered. This matches the existing
single-run behavior and prevents old partial failures from keeping an otherwise healthy automation
close to auto-pause.

### What if one target repository becomes inaccessible?

Answer: fail only that child repository run and continue starting the other child runs.

Reasoning: weekly maintenance should produce as much useful work as possible. One stale permission,
renamed repository, or deleted repository should not block updates across the rest of the selected
set. The inaccessible child contributes to the group's `partial_failed` status.

### Should fan-out be concurrent?

Answer: yes, launch all selected repositories concurrently in v1 and cap the selected repository
count at 10.

Reasoning: serial execution could turn a weekly maintenance run into a long queue. The existing
architecture already uses one sandbox/session per repo. The v1 safety valve is a product-level max
of 10 repositories.

### What happens if the next schedule fires while a group is active?

Answer: skip the whole next group.

Reasoning: weekly maintenance should not overlap itself. A second active sweep could create
duplicate branches or PRs and confusing results. This matches the current
one-active-run-per-automation invariant.

### Should manual "Run now" affect the next scheduled run?

Answer: no. Manual groups should not advance or delay `next_run_at`.

Reasoning: the weekly cadence should stay tied to the cron schedule. Manual runs are ad hoc operator
actions for immediate verification or catch-up work, and should not move the scheduled maintenance
window.

### Should paused automations allow manual "Run now"?

Answer: yes. Paused should stop scheduled execution, not manual operator-triggered groups.

Reasoning: operators need a way to verify a fix before resuming the weekly cadence. Manual runs
should still avoid changing `next_run_at`; resume remains the explicit action that restarts
scheduled execution.

### Should successful manual runs clear failures while paused?

Answer: yes. A successful manual group should reset `consecutive_failures`, but leave the automation
paused.

Reasoning: a successful manual run proves the failure condition has recovered, so keeping the old
failure count is misleading. However, restarting the weekly cadence should remain an explicit resume
action; clearing failures must not set `enabled` or `next_run_at`.

### Should manual failures count toward auto-pause?

Answer: yes. Manual multi-repo failures should affect `consecutive_failures` and auto-pause the same
way scheduled failures do.

Reasoning: a failed manual run is still evidence that the automation is broken. Using one failure
policy for scheduled and manual groups keeps behavior predictable and matches existing single-repo
manual runs.

### Should skipped groups count as failures?

Answer: no. A group skipped because a previous group is still active should not affect
`consecutive_failures`.

Reasoning: the active group is already the operational signal. Counting the skipped follow-up as an
additional failure would double-count one long-running sweep and could auto-pause an otherwise
recoverable automation too aggressively.

### How should a multi-repo group count in scheduler tick summaries?

Answer: count one successfully started group as one processed automation, not one processed item per
child repository.

Reasoning: the scheduler tick loop and `MAX_PER_TICK` limit are automation-oriented. Child
repository counts belong in grouped run history, where users can see per-repository progress. Making
the tick summary count children would make the summary inconsistent with the scheduler's unit of
work.

### Can users edit the selected repo set after creation?

Answer: yes, but only while the automation has no active group or run. After an automation has run
history, changing repository cardinality between zero, one, and many targets is blocked; create a
new automation instead.

Reasoning: maintenance repo sets change as repositories are added or retired. Recreating an
automation just to add or remove a repo is unnecessary friction. However, cardinality changes alter
the run-history shape and pagination semantics, making older runs confusing or hidden. The server
must enforce the active-run guard and cardinality immutability after history exists; the UI should
disable target edits while active.

### How should target repositories be stored?

Answer: add a normalized `automation_targets` table.

Reasoning: target rows need validation, listing, counting, joining to child runs, and possible
future fields such as per-repo branch override. A JSON blob would push parsing and validation into
every path.

### Should target mode be the durable product model?

Answer: no. Repository context is modeled as zero, one, or many repository targets.

Reasoning: a target-mode enum packs repository absence, repository count, trigger compatibility, and
launch materialization into one field. The durable model should stay closer to the data: repo-less
automations have no repository target, single-repo automations keep the direct repo fields and a
normalized target row, and multi-repo automations use multiple normalized target rows. The scheduler
derives launch behavior from resolved targets.

### Should multi-repo selection allow one repository?

Answer: no. Require 2-10 repositories.

Reasoning: one repository should use the single-repo path. This keeps validation clear and catches
accidental states where a multi-repo selection was reduced to one repo.

### Should duplicate target repositories be silently deduplicated?

Answer: no. Reject duplicate repository targets after normalization.

Reasoning: silent deduplication makes the API surprising because a client can submit one target
count and persist another. The UI should prevent duplicates, and the server should enforce the
invariant with a clear validation error. Duplicate detection should trim and lowercase owner/name
before comparison.

### How should the repository picker work?

Answer: derive repository context from the picker selection.

Reasoning: users should not need to understand an internal mode before picking repositories.
Selecting no repository creates a repo-less automation, selecting one repository creates a
single-repo automation, and selecting 2-10 repositories creates grouped multi-repo runs.

### Should instructions be per-repository?

Answer: no. Use one shared instruction prompt for v1.

Reasoning: the weekly `AGENTS.md` use case has the same instruction across all repositories. Each
child session receives its own repository context. Per-repo overrides can be added later if needed.

### How should pull requests work?

Answer: keep the existing per-session pull request flow unchanged.

Reasoning: each child session owns its repository, branch, artifacts, and PR creation. The group
aggregates PR links for display only; it should not create a cross-repository or "mega" pull
request.

## Deployment Notes

### How should migration 0030 partial-apply recovery work?

Answer: make the migration replay-safe. Do not add special-case migration-runner logic for this
single migration, and do not manually mark it applied after a failed run unless a separate schema
inspection shows the database is already correct.

Reasoning: `scripts/d1-migrate.sh` applies each SQL file and then records the version in
`_schema_migrations`. Migration `0030` is safe to rerun if the SQL file succeeds but the marker
insert fails, if an older attempt added only some `automation_runs` columns, or if the replay
resumes after `automation_runs` was dropped and the populated shadow table is still present.

Recovery checklist: rerun `terraform apply` with the replay-safe migration. If the rerun still
fails, inspect the D1 error and the current schema before inserting anything into
`_schema_migrations`.
