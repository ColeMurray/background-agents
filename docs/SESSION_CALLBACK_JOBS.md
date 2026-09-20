# Session callback jobs (COL-52)

Session runtimes publish unsigned, versioned `session.callback` jobs through the existing `JOBS`
port. Cloudflare uses its dedicated callback Queue and DLQ; Node uses the existing persisted jobs
table and poller. Both use the same consumer. No callback client or Slack/Linear signing key is
retained in the session runtime environment. Signing and outbound HTTP happen at delivery time with
the destination bot's key. Existing callback endpoints use **body HMAC**, not the `sig1` request
headers used by bots calling the control plane.

## Delivery contract

- Completion and Linear-start delivery failures retry up to 13 deliveries, with a 15-second default
  delay, then dead-letter. Missing configuration is retried too, so terminal events remain visible
  instead of being acknowledged silently.
- Tool progress and Slack activity refreshes are cosmetic: a failed delivery is acknowledged,
  without retry. Invalid job envelopes follow the jobs registry's existing dead-letter policy.
- Every retry preserves the original producer timestamp. A delayed Linear start must not become
  fresh merely because a consumer signed it again.
- Activity refreshes expire after a minute and query the originating session's current processing
  message immediately before sending. This avoids replaying queued activity for an already-finished
  turn; it cannot make remote HTTP and completion atomic.
- Automation completion runs in the consumer through the existing scheduler, preserving its
  state-transition guards and best-effort Slack fan-out. This is necessary to remove the scheduler's
  bot capabilities from the session runtime.

## Durability boundary

`JOBS.send()` resolves after Queue acceptance or a committed Node jobs-table write. An accepted
event survives producing-runtime eviction and Node process restart. Delivery is at least once, so
cosmetic duplicates remain possible. Tool call IDs and refresh intervals are suppressed in memory at
publication, not remote delivery.

This is **not a transactional session outbox**. Terminal/start publication gets two attempts with
the same payload; both can fail after the session transition has committed. A crash before
acceptance can also lose an event. Closing that window requires a separately designed transactional
capture/recovery protocol. The old PR's queue-acceptance guarantee is retained, not silently
promoted to exactly-once or durable-at-transition delivery.

## Rollout and verification

The Cloudflare callback queue, producer binding, consumer and DLQ ship together in Terraform. Node
needs no database migration beyond its existing jobs store. The worker retains bot bindings and keys
for the jobs consumer and scheduler; the session environment explicitly removes them. Rollback to a
build without this job kind leaves Node rows pending; do not delete the Cloudflare queue while it
holds events. Re-deploy a capable consumer to drain it.

Tests exercise real SessionDO completion, queue acceptance, actor eviction, and independent signed
delivery; Node tests reopen the jobs database before delivery. Producer tests retain context
validation, separate throttle/dedup checks, bounded dedup state, and activity refresh behavior.
Consumer tests cover timestamps, signatures, retry policy, timeout, malformed payloads, and stale
refresh suppression.

COL-106 supplies Node's URL-backed bot clients. Cloudflare keeps service bindings.
