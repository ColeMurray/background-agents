# Pi Slack durable ingress runbook

`PI_SLACK_DURABLE_INGRESS_ENABLED` defaults to `false`. When enabled, Slack channel events are
signature-checked, admitted to D1, and persisted to Queue before the HTTP acknowledgement. D1 owns
the event receipt, stable session/message IDs, thread mapping, leases, and terminal reconciliation;
Slack KV is only a repairable cache.

Ordinary replies in an active Pi thread remain queued new turns. Normal text is never interpreted as
steering.

## SLOs

- Slack ACK p95 below 500 ms.
- Assistant activity p95 below 1 second from a successful receipt claim.
- Pi admission p95 below 1 second from the durable prompt claim, excluding model latency.
- One D1 session, SessionDO message, thread mapping, and Slack completion per external event ID.

Telemetry contains receipt/event/session/message IDs, timestamps, durations, state, attempt count,
and recovery outcome only. It never contains event bodies, prompts, tool output, or credentials.

## Ten-minute canary

1. Apply D1 migrations 0092 and 0095 while the feature remains off.
2. Enable `pi_slack_durable_ingress_enabled` for one personal Slack installation and apply
   Terraform.
3. Mention the bot in one channel with a no-repository Pi request. Confirm ACK under 500 ms and the
   activity indicator under one second.
4. Redeliver the same Slack event ID. Confirm one session, one first message, one mapping, and one
   completion reply.
5. Reply while Pi is working. Confirm the reply queues as a new turn and does not steer the active
   run.
6. Delete the KV thread key and reply again. Confirm D1 repairs the mapping and reuses the same
   SessionDO/Pi conversation.
7. Temporarily fail Queue delivery, then restore it. Confirm Slack receives a retryable response and
   the redelivery completes without duplicates.
8. Disable the flag to roll back. Keep D1 migrations, Queue/DLQ resources, bindings, and receipt
   readers so admitted work remains recoverable.
