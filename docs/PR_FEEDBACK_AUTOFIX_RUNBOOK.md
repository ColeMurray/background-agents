# PR Feedback Autofix Runbook

PR Feedback Autofix resumes the Open Inspect session associated with a pull request when eligible
feedback arrives. It is disabled by default and can be enabled globally or for selected repository
overrides.

## Rollout

1. Deploy the control plane and GitHub bot together so the queue producer, consumer, database
   migrations, and settings schema agree.
2. In **Settings → Integrations → GitHub**, leave the global Autofix switch off.
3. Choose one internal repository, select its **Override** mode, and enable submitted human reviews.
   Enable plain human PR comments only if the team wants every comment to start an attempt in the
   owning session.
4. Exercise the human-only inputs and confirm the acceptance checks below.
5. Enable Open Inspect reviews only after human inputs are healthy, then verify self-echo,
   cross-session provenance, no-findings suppression, and single-review publication.
6. Add CodeRabbit's exact bot login only after Open Inspect reviews are healthy. Add no other bot
   identity until it has been evaluated independently.
7. Leave the attempt cap at its default until the dogfood repository shows a need to change it.
8. For each enabled input, confirm:
   - one owning-session request is created for each individual PR comment;
   - one owning-session request is created for a submitted review;
   - Open Inspect publishes at most one GitHub review for a reviewer run;
   - the session timeline links back to the originating feedback;
   - disabled repositories remain unaffected.
9. Expand by repository only after the acceptance checks and operational signals below remain
   healthy.

Explicit `@open-inspect` mentions remain supported even when automatic dispatch is disabled.
Settings changes affect future webhook deliveries; they do not cancel sessions already admitted.

### Budget prerequisite

The current platform has no authoritative per-session spend-budget setting for Autofix to inspect at
admission. Existing execution timeouts, cancellation controls, and the rolling attempt cap still
apply, but they are not a spend budget. Keep Autofix default-off for any deployment that requires an
enforced spend ceiling; dogfood enablement requires either accepting this limitation explicitly or
first adding an authoritative budget facility outside this feature.

## Operational signals

The control-plane cron checks queue health once per minute and emits structured error logs:

| Event                          | Meaning                             | Alert condition                                                                                       |
| ------------------------------ | ----------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `autofix.queue_health`         | Queue work is not draining normally | Primary backlog exceeds 25, oldest primary message exceeds 5 minutes, or the DLQ contains any message |
| `autofix.queue_metrics_failed` | Queue health could not be inspected | Any metrics read failure                                                                              |

Configuring the alert destination is a required dogfood gate owned by the deployment, because this
repository does not manage the external notification sink. Route these error-level events through
the deployment's Worker log alerting. Alert on every DLQ event and when either primary-queue
threshold is reported in two consecutive checks.

The durable activity ledger is available to authenticated operators at:

```text
GET /autofix/activity?limit=50
```

Each record includes the repository, PR, source object, delivery count, decision, reason,
session/message IDs, timestamps, and the last error. Follow `nextCursor` to inspect older records.

Useful decision reasons include:

- `disabled` or a source-specific policy reason: expected settings decision;
- `duplicate`: the same immutable provider object was already handled;
- `attempt_cap`: the PR reached its configured automatic-session cap;
- `no_findings`: an Open Inspect review intentionally had no findings;
- `own_app_unattributed`: the review receipt was not available after bounded retries and needs
  reconciliation;
- `permanent_provider_error`: GitHub rejected the provider read permanently;
- `delivery_attempts_exhausted`: transient processing repeatedly failed.

## Triage

1. Inspect `autofix.queue_health` and `autofix.queue_metrics_failed` logs.
2. Inspect `/autofix/activity` for the affected repository and PR.
3. Check the GitHub webhook delivery and redelivery history for the source object.
4. Confirm the repository's resolved Autofix settings, bot allowlist, source session, PR head, and
   attempt count before retrying work.
5. For a primary backlog, correct the downstream dependency first. Queue retries are automatic.
6. For a DLQ message, confirm whether its feedback key already has a terminal ledger decision before
   redelivering its GitHub webhook. Immutable provider IDs and session admission keys make safe
   redeliveries idempotent.

Do not edit Autofix ledger rows or Session Durable Object storage to force a retry.

## Review publication reconciliation

A timed-out GitHub review publication is marked `uncertain` and is never automatically reposted.
Reconcile it explicitly:

1. Find its `publicationKey` and marker in `github_review_publications`.
2. Ask the authenticated endpoint to search the exact PR:

   ```json
   POST /autofix/review-publications/{publicationKey}/reconcile
   { "action": "search" }
   ```

3. Inspect the returned candidates on GitHub.
4. If no candidate exists, explicitly abandon the stale `pending` or `uncertain` publication:

   ```json
   POST /autofix/review-publications/{publicationKey}/reconcile
   { "action": "abandon" }
   ```

   The server repeats the marker search and refuses abandonment when a candidate exists. A failed
   receipt is never reposted; producing another review requires a new reviewer message.

5. Otherwise, confirm only the review authored by the configured Open Inspect bot whose body
   contains the stored marker:

   ```json
   POST /autofix/review-publications/{publicationKey}/reconcile
   { "action": "confirm", "providerReviewId": "123456789" }
   ```

Confirmation re-reads the exact provider review and fails closed unless both bot identity and marker
match. It also reopens only the corresponding `own_app_unattributed` feedback receipt for safe
webhook redelivery.

## Kill switch

Disable Autofix for the affected repository override. For a deployment-wide stop, disable the global
Autofix setting and every repository override that enables it. Explicit mentions remain available
for deliberate operator use.

After disabling, allow in-flight sessions to finish or stop them through the normal session
controls. Preserve queue and ledger data for diagnosis.

## Rollout gate

Before broadening beyond the dogfood repository, verify:

- no unexpected repositories or actor types were admitted;
- duplicate deliveries did not create duplicate session messages;
- attempt caps behaved as configured;
- no unexplained DLQ messages or uncertain publications remain;
- review feedback was published as a single GitHub review;
- operators can trace every tested feedback object from GitHub to its session.
