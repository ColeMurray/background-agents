# Producer-Agnostic Open Inspect Review Autofix

## Status

Proposed correction to the stacked PR Feedback Autofix implementation. This plan replaces the
attested-review publication dependency in PR #1183 with direct consumption of authoritative GitHub
reviews from the configured Open Inspect GitHub App identity, then restacks PR #1184 on that smaller
change.

## Decision Summary

Autofix is a consumer of GitHub feedback. It must not require existing review producers to publish
through a new Open Inspect-specific tool or endpoint.

The target flow is:

```text
Any existing review producer
  -> submitted GitHub review
  -> signed GitHub webhook
  -> authoritative GitHub API read
  -> Autofix eligibility and deduplication
  -> PR-owning SessionDO
```

This includes the built-in GitHub reviewer and user-defined automations triggered by events such as
`pull_request.opened`. Those workflows continue publishing reviews through their existing `gh` or
GitHub API behavior. Autofix identifies an Open Inspect review by the exact configured bot login in
the provider response, not by a control-plane publication receipt.

## Problem

The current PR #1183 implementation changes review production in order to support review
consumption:

1. Every sandbox receives a `publish-review` OpenCode tool.
2. The built-in reviewer prompt is changed to require that tool.
3. The tool calls a session-scoped control-plane publication endpoint.
4. The control plane records a publication receipt and marker before posting the review.
5. Autofix accepts an app-authored review only when it can match the GitHub review ID to that
   receipt.

This is the wrong dependency direction. Existing automation review sessions do not use the new tool,
so their genuine Open Inspect reviews are classified as `own_app_unattributed` and do not reach
Autofix. The tool is also visible to unrelated agents even though most sessions cannot use it
successfully.

The receipt is not a meaningful privilege boundary in the current deployment model. Sandboxes can
already obtain the GitHub App installation token through the SCM credential broker and use `gh`. The
receipt therefore proves that one particular application path was used; it does not prove that the
caller possessed authority unavailable elsewhere in the sandbox.

## Goals

- Allow reviews submitted by the exact Open Inspect GitHub App identity to trigger Autofix when the
  repository setting permits it.
- Preserve all existing review-producing workflows without prompt, tool, or API changes.
- Preserve one Autofix admission per immutable GitHub review ID.
- Preserve authoritative provider read-through, tracked-PR correlation, attempt limits, queue
  retries, and activity observability.
- Keep reviews from other bots behind the existing explicit bot allowlist.
- Remove publication infrastructure that exists only to make Autofix trust its own App reviews.
- Reduce PR #1183 to the smallest independently reviewable own-review eligibility change.

## Non-Goals

- Standardizing how review agents publish GitHub reviews.
- Guaranteeing exactly-once review publication by arbitrary producers.
- Identifying which Open Inspect session or automation run produced an App-authored review.
- Preventing a sandbox with the shared App token from making arbitrary GitHub mutations. That is a
  separate credential-scope concern.
- Semantically determining that arbitrary review prose means "no findings."
- Changing human feedback, third-party bot allowlists, PR ownership, or normal session execution.

## Revised Product Guarantees

### Hard guarantees

1. **Provider authority**: Autofix acts on review content and identity re-read from GitHub, not on
   webhook body text alone.
2. **Exact App identity**: `openInspectReviewsEnabled` applies only when the review author's login
   exactly matches the configured Open Inspect bot login, compared case-insensitively.
3. **Review-only own-App input**: an issue or PR comment authored by the Open Inspect bot does not
   enter Autofix through this setting.
4. **Actionable review shape**: only submitted reviews in `COMMENTED` or `CHANGES_REQUESTED` state
   with a non-empty body or inline comment are eligible.
5. **Tracked owner**: feedback is sent only to the session recorded as owning the PR.
6. **At-most-once admission**: one provider review ID maps to one Autofix feedback key and no more
   than one SessionDO message.
7. **Bounded cycling**: every newly submitted review is a new feedback unit, but the existing per-PR
   rolling attempt cap bounds iterative reviewer/fixer cycles.
8. **Observable decisions**: received feedback ends as queued, skipped, or failed with a reason in
   the existing Autofix activity ledger.

### Explicitly relaxed guarantees

- Autofix does not prove which session produced an Open Inspect review.
- Autofix does not suppress a review merely because it may have originated from the PR-owning
  session.
- Autofix does not reconcile ambiguous review publication outcomes; publication reliability belongs
  to the producer.
- A non-empty `COMMENTED` review saying that no problems were found may cause one no-op Autofix
  attempt. This is preferable to brittle prose classification or requiring every producer to adopt a
  new protocol. `APPROVED` and empty reviews remain non-actionable.

## Eligibility Rules

Apply the existing global and repository Autofix settings before author-specific rules.

| Feedback author        | Feedback kind    | Additional requirement                                               | Decision                |
| ---------------------- | ---------------- | -------------------------------------------------------------------- | ----------------------- |
| Exact Open Inspect bot | Submitted review | `openInspectReviewsEnabled` and actionable review content            | Eligible                |
| Exact Open Inspect bot | PR comment       | None                                                                 | Skip as own-App comment |
| Other bot              | Submitted review | Exact normalized login in `allowedReviewBots` and actionable content | Eligible                |
| Other bot              | PR comment       | None                                                                 | Skip as bot PR comment  |
| Human                  | Submitted review | Repository write permission and actionable content                   | Eligible                |
| Human                  | Plain PR comment | Repository write permission, non-empty, and no explicit bot mention  | Eligible                |

The exact Open Inspect bot check occurs before the general bot allowlist so the dedicated setting is
authoritative. Enabling Open Inspect reviews must not implicitly allow any other bot.

## Target Architecture

### GitHub bot ingress

Keep the existing producer-neutral `pull_request_review.submitted` envelope. It contains stable
provider identity and routing metadata, not review content. Preserve `traceId` propagation for
observability.

Do not modify built-in review prompts or review publication behavior as part of Autofix. Custom
automation event consumers require no changes.

### Control-plane Autofix policy

`AutofixService` continues to:

1. persist or recover the feedback receipt;
2. locate the PR-owning session;
3. read the current PR and full review from GitHub;
4. attach provider context to the activity record;
5. apply repository, author, review-state, and content policy;
6. build one session command; and
7. dispatch idempotently to the owning SessionDO.

For the exact Open Inspect bot, policy changes from "require a completed publication receipt" to
"require the dedicated setting and an actionable submitted review." The command uses the existing
generic review origin:

```text
{ kind: "review", authorType: "bot", feedbackUrl }
```

No producer session ID, source message ID, publication key, or marker enters the session contract.

### Session execution

No execution change is required. SessionDO remains the atomic admission boundary for feedback-key
deduplication and the rolling per-PR attempt limit. The owning session reuses its existing logical
session context and normal sandbox lifecycle.

### Review production

Review production remains outside Autofix. The built-in reviewer, `pull_request.opened` automations,
and other review workflows continue using their existing mechanisms. A separate future project may
improve review publication idempotency, but Autofix must not depend on it.

## Implementation Changes

### Retain

- The dedicated versioned Autofix queue envelope and `traceId`.
- GitHub webhook signature validation and queue delivery.
- Authoritative GitHub reads for PR state, author identity, review body, and inline comments.
- `pr_autofix_feedback` as the delivery, decision, and activity ledger.
- PR-to-owning-session lookup through `session_pull_requests`.
- SessionDO feedback-key uniqueness and per-PR attempt admission.
- Settings for human reviews, PR comments, Open Inspect reviews, allowed third-party review bots,
  and attempt caps.
- Queue health monitoring, activity UI, and generic review-origin timeline rendering.

### Modify

- `AutofixService`: remove `ReviewPublicationStore`, `OwnReviewReceiptPendingError`,
  `resolveOwnReview`, and the special `OpenInspectReviewOrigin`. Accept the exact App bot directly
  under the rules above.
- Autofix composition: remove publication-store construction and its constructor parameter.
- Queue consumer: remove receipt-pending retry and `own_app_unattributed` terminal handling; retain
  normal transient and permanent provider failure behavior.
- Shared Autofix contracts: keep the generic human/bot review origin and remove publication and
  reconciliation fields.
- Activity reasons and UI/runbook language: describe own-App reviews as ordinary eligible review
  inputs and remove receipt-specific states.
- PR #1183 tests: assert producer-independent own-App review eligibility instead of publication
  provenance.

### Remove

- `packages/sandbox-runtime/src/sandbox_runtime/tools/publish-review.js`.
- Built-in reviewer prompt instructions requiring `publish-review`.
- GitHub bot review-target `originContext` added solely for publication attestation.
- `GitHubReviewPublisher` and its tests.
- `GitHubReviewPublicationStore` and its integration tests.
- `/sessions/:id/github-review` and the SessionDO publication-context route.
- `/autofix/review-publications/:key/reconcile` and marker-search reconciliation.
- The control-plane `AUTOFIX_QUEUE` producer binding used only for reconciliation.
- `github_review_publications` cleanup references and migration `0053` if it has never been applied
  outside an ephemeral PR environment.
- Publication request/response schemas, review-target origins, Open Inspect publication origins,
  reconciliation envelope fields, and their exports.
- Provider methods used only to publish or locate marked reviews.
- Runbook procedures and decision reasons for `own_app_unattributed`, `no_findings`, publication
  uncertainty, receipt mismatch, same-session review, and manual reconciliation.

Do not carry the feedback-client extraction from the current PR #1183 merely as collateral to the
publication feature. The read-only provider boundary already present in PR #1182 is sufficient for
this change. Any source-control client reorganization should be a separate refactor with its own
rationale.

## Data And Migration Handling

PR #1183 is not merged into `main`, so the preferred path is to remove migration `0053` and the
`github_review_publications` table entirely from the stack.

Before implementation, verify whether any shared dogfood database has applied migration `0053`:

- **Not applied**: delete the migration and all table references. Do not reserve or reuse its number
  until the stack is rebased against current `main` and migration numbering is rechecked.
- **Applied anywhere persistent**: do not issue a destructive rollback. Keep the migration as a
  historical no-op dependency, stop reading and writing the table, and schedule table removal as a
  separate operational migration only if worthwhile.

The `pr_autofix_feedback` migration remains authoritative and unchanged. Existing feedback rows do
not require rewriting; receipt-specific decisions exist only in unmerged or dogfood data and may
remain historical if already deployed.

## Stacked PR Plan

### PR #1182: Human and allowlisted-bot Autofix foundation

- Preserve the current admission, retry, SessionDO, and activity foundations.
- Move or retain generic `traceId` propagation here if restacking would otherwise make PR #1183
  carry an unrelated observability fix.
- Do not add own-review publication concepts.

### PR #1183: Producer-agnostic Open Inspect reviews

Rebuild this PR on the final #1182 head instead of reverting the publication implementation commit
by commit. Its intended diff should be limited to:

- exact own-App review eligibility;
- the dedicated setting behavior;
- focused service, ingress, and settings tests;
- any minimal shared type changes required by those behaviors.

The PR description should explicitly state that existing review producers require no changes and
that source-session provenance is not part of the contract.

### PR #1184: Dogfood controls and operations

Restack on the simplified #1183 and retain:

- configuration UI;
- queue health monitoring;
- Autofix activity and generic timeline provenance;
- rollout guidance and attempt-cap operations.

Remove publication reconciliation, receipt-specific activity explanations, and single-review
publication acceptance checks. Update the Open Inspect review setting copy to say that reviews
submitted by the configured App identity are eligible regardless of which Open Inspect workflow
produced them.

After restacking, verify ancestry in order and push each rewritten branch with an exact
`--force-with-lease` expectation. Preserve backup refs for the current remote heads until all three
PR diffs and checks are confirmed.

## TDD And Test Plan

Implementation follows red-green-refactor. Start from the simplified #1182 base and add failing
tests for the revised contract before changing policy.

### Autofix service tests

- Exact Open Inspect bot review, setting enabled, `COMMENTED`, non-empty summary -> queued.
- Exact Open Inspect bot review, setting enabled, inline findings only -> queued.
- Exact Open Inspect bot review, setting disabled -> `own_reviews_disabled`.
- Exact Open Inspect bot PR comment -> skipped and never admitted as a review.
- Exact Open Inspect bot `APPROVED`, `DISMISSED`, or empty review -> existing non-actionable reason.
- Exact Open Inspect bot review requires no publication lookup or source-session metadata.
- Another bot still requires its exact allowlist entry.
- Duplicate delivery of the same own-App review ID resolves to the same message.
- Each different review ID remains a distinct feedback unit and is bounded by the existing attempt
  cap.

### Ingress and integration tests

- A submitted App review produces the same generic review envelope as any other submitted review.
- The envelope carries `traceId` and does not carry publication or reconciliation fields.
- Author identity and review content come from the provider read, not the webhook body.
- A representative automation-produced review reaches the same own-App eligibility path without a
  `publish-review` call.
- D1 integration coverage remains for feedback receipt idempotency and activity; publication-store
  integration coverage is removed.

### Regression tests

- Built-in reviewer prompts retain their pre-Autofix publication instructions.
- Sandbox runtime tool installation no longer exposes `publish-review`.
- Session routes contain no GitHub review publication endpoint.
- Human comments, human reviews, allowlisted bots, explicit bot mentions, untracked PRs, closed PRs,
  and attempt caps behave unchanged.
- The settings UI persists and resolves `openInspectReviewsEnabled` independently from
  `allowedReviewBots`.

### Validation

Build `@open-inspect/shared` before dependent checks, then run:

1. focused shared contract tests;
2. focused control-plane Autofix unit and D1 integration tests;
3. GitHub bot prompt, ingress, handler, and webhook tests;
4. sandbox-runtime tool-installation tests;
5. web settings and timeline tests;
6. affected package test suites;
7. repository-wide typecheck, lint, and format check; and
8. stacked ancestry, clean-worktree, remote-head, and GitHub CI verification.

Tests should assert decisions and observable behavior rather than private helper structure. Keep
dependencies explicit and avoid introducing a generic review-producer interface or session
capability framework.

## Rollout

1. Confirm migration `0053` has not been applied to a persistent environment.
2. Rewrite and validate PR #1183 on the current #1182 head.
3. Restack and validate #1184.
4. Deploy the GitHub bot and control plane together so the envelope and policy contracts remain in
   sync.
5. Enable human reviews first in one repository and verify ownership, deduplication, and activity.
6. Enable Open Inspect reviews and exercise both:
   - the built-in reviewer; and
   - an existing `pull_request.opened` automation that publishes through its current mechanism.
7. Confirm both reviews enqueue exactly one message in the PR-owning session without any
   `publish-review` tool or receipt.
8. Observe the attempt cap and activity reasons through at least one reviewer/fixer iteration before
   expanding rollout.

## Risks And Mitigations

### No source-session provenance

An own-App review cannot be traced back to a specific Open Inspect session solely from the GitHub
review. This is accepted because current producers do not share a publication protocol and the
sandbox credential model already permits App-authored writes.

Mitigation: retain exact App identity, authoritative provider reads, tracked-PR ownership,
feedback-key deduplication, and attempt caps. Add producer attribution later only as optional
metadata; never make it an eligibility prerequisite.

### No-findings comments

GitHub does not expose a producer-neutral semantic `no_findings` field. A self-review on a PR
authored by the App may use `COMMENT` even when it found nothing.

Mitigation: accept at most one potentially no-op Autofix turn for a non-empty review rather than
classifying prose. Empty and `APPROVED` reviews remain skipped, and the rolling cap bounds repeated
reviews.

### Iterative automation cycles

A fix may push a new commit, trigger another review automation, and produce another distinct review.
That cycle is often the desired reviewer/fixer workflow, but pathological producers can continue
creating new review IDs.

Mitigation: the SessionDO per-PR rolling cap remains the hard stop. Activity records expose each
review ID and decision for diagnosis.

### Existing dogfood publication data

An environment may already contain publication rows or a runtime image with the tool.

Mitigation: verify deployment state before deleting the migration. Stale tool files are harmless
once prompts no longer call them, but runtime images should be refreshed during dogfood rollout so
unrelated agents stop seeing the tool.

## Acceptance Criteria

- A review submitted by the exact configured Open Inspect bot can trigger Autofix without a
  publication receipt.
- The built-in reviewer and a custom `pull_request.opened` automation both work without changing
  their publication mechanisms.
- The same review ID cannot enqueue more than one owning-session message.
- Open Inspect bot PR comments remain ineligible through the own-review setting.
- Other bots remain disabled unless explicitly allowlisted.
- The per-PR rolling attempt cap still bounds iterative reviews.
- `publish-review`, publication routes, publication storage, reconciliation, and special publication
  origins are absent from the final stack unless retained solely for an already-applied migration.
- Autofix activity and timeline views remain useful with the generic review origin.
- PR #1182, #1183, and #1184 are cleanly stacked, independently reviewable, and pass the full
  affected validation suite.
