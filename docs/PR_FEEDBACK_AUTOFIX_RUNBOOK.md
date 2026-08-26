# PR Feedback Autofix Runbook

PR Feedback Autofix resumes the Open Inspect session that owns a pull request when eligible GitHub
feedback arrives. It is disabled by default and can be enabled globally or for individual
repositories.

## Dispatch model

- Each eligible top-level human PR comment creates one Autofix attempt.
- Each eligible submitted review creates one Autofix attempt containing its summary and inline
  comments.
- Explicit `@open-inspect` mentions continue using the existing fresh-session flow.
- A review from the exact configured Open Inspect App identity can be eligible regardless of which
  Open Inspect workflow published it. Review producers do not need a special tool or protocol.
- Other review bots must be listed by exact normalized login.

GitHub is authoritative for feedback identity and content. The webhook queues only stable routing
metadata; the control plane re-reads the pull request and feedback before admission. Duplicate
deliveries of the same immutable GitHub object do not create duplicate session messages.

## Rollout

1. Deploy the shared contract, GitHub bot, control plane, web settings, and database migrations from
   the same stack.
2. In **Settings -> Integrations -> GitHub**, leave global Autofix disabled.
3. Select one internal repository, choose **Override**, and enable human submitted reviews.
4. Enable plain human PR comments only if the team wants every such comment to start an attempt.
5. Verify the human-input acceptance checks below.
6. Enable Open Inspect reviews. Exercise both the built-in reviewer and an existing custom
   automation that publishes a GitHub review through its normal mechanism.
7. Add third-party bots only after evaluating each bot independently. Enter its exact GitHub login.
8. Keep the default attempt cap until observed volume justifies changing it.
9. Expand repository by repository after the operational signals remain healthy.

Settings changes affect future webhook deliveries. They do not cancel work already admitted.

### Budget prerequisite

Autofix has no authoritative spend budget at admission time. Existing execution timeouts,
cancellation controls, and the rolling attempt cap still apply, but they are not a spend budget.
Keep Autofix disabled for deployments that require a hard spend ceiling unless that limitation is
explicitly accepted.

## Acceptance checks

For every enabled input, verify:

- one owning-session message is created for an individual eligible PR comment;
- one owning-session message is created for a submitted eligible review;
- redelivery of the same GitHub object does not create another message;
- the session timeline identifies the author type and links to the feedback;
- Open Inspect App reviews work without producer-session metadata or a publication receipt;
- a custom automation review and built-in reviewer review follow the same admission path;
- disabled repositories and unlisted bots remain unaffected; and
- repeated distinct reviews stop at the configured rolling attempt cap.

An empty review, an approved review, or a dismissed review is non-actionable. A non-empty
`COMMENTED` review that says there are no findings may consume one no-op attempt; Autofix does not
classify arbitrary prose.

## Operational signals

The control-plane scheduled handler checks queue health once per minute and emits structured error
logs:

| Event                          | Alert condition                                                                                   |
| ------------------------------ | ------------------------------------------------------------------------------------------------- |
| `autofix.queue_health`         | Primary backlog exceeds 25, its oldest message exceeds 5 minutes, or the DLQ contains any message |
| `autofix.queue_metrics_failed` | A queue metrics read failed                                                                       |

Configure the deployment's Worker log alerting to notify on every DLQ event and when either primary
threshold is reported in two consecutive checks. This repository does not configure the external
notification destination.

Authenticated operators can inspect the durable activity ledger at:

```text
GET /autofix/activity?limit=50
```

Records include repository, pull request, source object, delivery count, decision, reason,
session/message IDs, timestamps, and the last error. Follow `nextCursor` for older records.

Common reasons:

- `disabled`, `reviews_disabled`, or `pr_comments_disabled`: expected settings decision;
- `own_reviews_disabled`: the exact Open Inspect App review setting is off;
- `bot_not_allowed`: another bot is not in the repository's exact allowlist;
- `review_state_not_actionable` or `empty_feedback`: no actionable review content;
- `duplicate`: the immutable provider object was already handled;
- `attempt_limit`: the owning session reached the configured rolling cap;
- `permanent_provider_error`: GitHub rejected an authoritative read permanently; and
- `delivery_attempts_exhausted`: transient processing failed through the queue retry limit.

## Triage

1. Inspect `autofix.queue_health` and `autofix.queue_metrics_failed` logs.
2. Inspect `/autofix/activity` for the repository and pull request.
3. Check the GitHub webhook delivery and redelivery history for the source object.
4. Confirm the resolved repository settings, exact bot identity or allowlist entry, owning session,
   pull-request state, and attempt count.
5. For a primary backlog, correct the downstream dependency; queue retries are automatic.
6. For a DLQ message, confirm whether its feedback key already has a terminal ledger decision before
   redelivering the GitHub webhook.

Do not edit Autofix ledger rows or Durable Object storage to force a retry. Provider IDs and
SessionDO admission keys make normal webhook redelivery idempotent.

## Kill switch

Disable Autofix in the affected repository override. For a deployment-wide stop, disable the global
setting and every repository override that explicitly enables it. Explicit mentions remain available
for deliberate use.

Allow admitted sessions to finish or stop them through normal session controls. Preserve queue and
ledger data for diagnosis.

## Rollout gate

Before broadening beyond dogfood, verify:

- no unexpected repository or actor type was admitted;
- duplicates did not create duplicate session messages;
- attempt caps behaved as configured;
- both built-in and custom-automation Open Inspect reviews were admitted without producer changes;
- no unexplained DLQ messages remain; and
- every tested feedback object can be traced from GitHub to its owning session.
