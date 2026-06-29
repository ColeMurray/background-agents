# Automations

Automations let you run coding agents either on a recurring schedule or when an external event
arrives. Define the repository, branch, model, and instructions once, then Open-Inspect starts a new
session whenever the trigger fires.

Trigger types:

| Trigger Type        | Description                               | Availability       |
| ------------------- | ----------------------------------------- | ------------------ |
| **Schedule**        | Run on a cron schedule                    | Available          |
| **Inbound Webhook** | Trigger from any system with an HTTP POST | Available          |
| **Sentry Alert**    | Trigger from a Sentry Custom Integration  | Available          |
| **Slack Message**   | Trigger on messages in watched channels   | Available (opt-in) |
| **GitHub Event**    | Trigger on GitHub activity                | Planned            |
| **Linear Event**    | Trigger on Linear activity                | Planned            |

Common use cases include nightly dependency updates, reacting to deploy or incident events, triaging
new Sentry issues, and recurring report generation.

---

## Creating an Automation

Navigate to **Automations** in the sidebar, then click **Create Automation**.

Start by choosing a **Trigger Type**. The rest of the form adjusts based on that choice.

### Required Fields

| Field            | Description                                                                                                                                                                                |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Trigger Type** | How the automation starts: schedule, inbound webhook, or Sentry alert.                                                                                                                     |
| **Name**         | A short label for the automation (max 200 characters). Appears in the automations list and in session titles prefixed with `[Auto]`.                                                       |
| **Repository**   | The GitHub repository to run against. Only repositories installed on the GitHub App are available. Cannot be changed after creation.                                                       |
| **Instructions** | The prompt sent to the coding agent each time the automation fires (max 10,000 characters). Write this as you would a normal session prompt and reference the trigger context when useful. |

### Optional Fields

| Field          | Description                                                                                       |
| -------------- | ------------------------------------------------------------------------------------------------- |
| **Branch**     | The base branch for each session. Defaults to the repository's default branch (usually `main`).   |
| **Model**      | The AI model to use. Defaults to the system default model.                                        |
| **Reasoning**  | Optional reasoning level for models that support it.                                              |
| **Conditions** | Optional trigger filters for event-driven automations such as inbound webhooks and Sentry alerts. |

### Trigger-Specific Fields

| Trigger Type        | Additional Fields                                                                            |
| ------------------- | -------------------------------------------------------------------------------------------- |
| **Schedule**        | **Schedule** and **Timezone**                                                                |
| **Inbound Webhook** | No extra required fields                                                                     |
| **Sentry Alert**    | **Event Type** and **Sentry Client Secret**                                                  |
| **Slack Message**   | **Conditions** (a Slack Channel condition is required; a Message Text condition is optional) |

For non-schedule automations, schedule fields are not used.

---

## Inbound Webhooks

Use **Inbound Webhook** when you want any external system to trigger an automation with a JSON
payload. This is the most flexible event-driven option and works well for internal tools,
deployments, monitoring systems, scheduled jobs, and custom integrations.

### How It Works

1. Create an automation with **Trigger Type = Inbound Webhook**.
2. Copy the generated webhook URL and API key shown after creation.
3. Send an authenticated HTTP `POST` request with a JSON body.
4. Open-Inspect prepends a webhook context block to your automation instructions and starts a new
   session if the request matches the automation's conditions.

### Setup Notes

- The webhook URL and API key are shown after the automation is created.
- The API key is only shown once, so store it when you create the automation.
- The automation detail page shows the webhook path for reference.
- Webhook automations do not use schedule or timezone settings.

### Request Requirements

Inbound webhooks must meet all of the following requirements:

| Requirement          | Value                             |
| -------------------- | --------------------------------- |
| Method               | `POST`                            |
| Content-Type         | `application/json`                |
| Authentication       | `Authorization: Bearer <api-key>` |
| Maximum payload size | 64 KB                             |

Any valid JSON body is accepted.

Example:

```bash
curl -X POST "https://<your-worker-url>/webhooks/automation/<automation-id>" \
  -H "Authorization: Bearer <api-key>" \
  -H "Content-Type: application/json" \
  -d '{"event":"deploy.failed","service":"api","environment":"prod"}'
```

### What the Agent Receives

For each accepted request, Open-Inspect prepends a context block to your instructions that includes:

- The fact that the automation was triggered by an inbound webhook
- The time the webhook was received
- The JSON payload, truncated if necessary
- A warning to treat the payload as untrusted input data, not as instructions

Write your automation instructions assuming the agent will read both your saved prompt and the
incoming payload together.

### Filtering with Conditions

Webhook automations support one condition type: **JSONPath Filter**.

Use conditions when you want the automation to run only for specific payload shapes or values, such
as:

- Only production events
- Only deploy failures
- Only payloads that include a specific field

Each JSONPath condition contains one or more filters, and **all filters must match** for the
automation to run.

Supported comparisons:

| Comparison | Meaning                   |
| ---------- | ------------------------- |
| `eq`       | Equal to                  |
| `neq`      | Not equal to              |
| `gt`       | Greater than              |
| `gte`      | Greater than or equal to  |
| `lt`       | Less than                 |
| `lte`      | Less than or equal to     |
| `contains` | String contains substring |
| `exists`   | Field is present          |

Supported path syntax is limited to simple dot notation such as `$.event.type` or
`$.deployment.environment`.

Not supported:

- Array indexing
- Recursive descent
- Full JSONPath expressions

Example filters:

| Goal                             | Filter                          |
| -------------------------------- | ------------------------------- |
| Run only for production          | `$.environment eq "production"` |
| Run only for failed deploys      | `$.status eq "failed"`          |
| Run only when a field is present | `$.pull_request.number exists`  |

### Idempotency and Duplicate Deliveries

If your sender may retry the same event, include an `idempotencyKey` field in the JSON body.

When present, Open-Inspect uses that value to deduplicate repeated deliveries of the same logical
event. Re-sending the same `idempotencyKey` will not create duplicate runs.

The `idempotencyKey` remains in the stored webhook body, but it is omitted from the context block
shown to the agent.

If you do not provide an `idempotencyKey`, each webhook delivery gets its own concurrency key. That
means separate deliveries for the same automation can run at the same time.

### Responses

Successful requests return JSON in this shape:

```json
{ "ok": true, "triggered": 1, "skipped": 0 }
```

`triggered` is the number of automation runs started.

`skipped` is the number of matching runs that were ignored because of duplicate delivery or
concurrency protection.

### Error Responses

| Status | Meaning                                          |
| ------ | ------------------------------------------------ |
| `400`  | Invalid JSON body                                |
| `401`  | Missing or invalid API key                       |
| `404`  | Automation not found or not a webhook automation |
| `413`  | Payload too large                                |
| `415`  | `Content-Type` was not `application/json`        |

---

## Slack Message Triggers

A **Slack Message** automation starts a session when someone posts a matching message in a watched
Slack channel. Unlike `@mention` sessions (which are explicit, interactive requests), these triggers
fire on ambient channel messages that match the conditions you define.

This source is opt-in per deployment and ships **disabled by default**. Enabling it requires the
operator to set the `SLACK_TRIGGERS_ENABLED` flag and configure the Slack app — see
[the Slack integration guide](integrations/SLACK.md#channel-message-triggers) for setup and the
threat model. The web form and these conditions are always available to author; messages are only
ingested once the flag is on.

### Conditions

A Slack automation must define at least a **Slack Channel** condition; the rest are optional
filters.

- **Slack Channel** (required) — the channels to watch. Pick channels by name in the web form;
  channel IDs (for example `C0123ABCD`) also work as a fallback when channel listing is unavailable.
  Only messages in these channels are considered, and the bot must be a member of each.
- **Message Text** (optional) — filter on the message text. Without it, every message in the watched
  channels triggers the automation. Pick a mode:
  - **contains** — the message contains the substring (optionally case-insensitive).
  - **exact** — the message equals the text.
  - **regex** — the message matches a regular expression. Patterns are capped in length and limited
    to the `i` and `m` flags; an invalid pattern is rejected when you save.
- **Slack User** (optional) — include or exclude specific Slack user IDs (an allowlist is the
  recommended way to limit who can trigger a run).

A message runs the automation only when **every** condition passes. The bot-mention token is
stripped before matching, and messages that `@mention` the bot are handled by the interactive
`@mention` flow instead — they never double-fire as triggers.

### Run feedback

A triggering message is marked with the 👀 reaction while its run is in flight. When the run
finishes, the agent's final response is posted as a reply in that message's thread — with links to
any pull requests it opened and to the full web session — and the reaction is cleared. A failed run
posts a short failure notice in the thread instead.

Every reply in a thread **continues the same session** — during the run and after it finishes — for
up to 7 days after the thread's first trigger, exactly like replying in an `@mention` thread. The
reply is enqueued as a follow-up turn on that session (re-spawning it from a snapshot if it had gone
idle), and the agent posts its response in-thread when the turn finishes. A follow-up does not need
to match the trigger condition — conditions gate new runs, not replies that continue an existing
thread. If a reply races the very first trigger before its session exists, it falls back to an
ephemeral "a run is already active" notice (reason `concurrent_run_active`); a reply more than 7
days after the first trigger starts a fresh run.

---

## Schedule Options

The schedule picker offers four presets and a custom mode:

| Preset         | Description                                  | Controls                              |
| -------------- | -------------------------------------------- | ------------------------------------- |
| **Every hour** | Runs once per hour at the top of the hour    | None                                  |
| **Daily**      | Runs once per day at a chosen time           | Hour picker (12-hour AM/PM)           |
| **Weekly**     | Runs once per week on a chosen day and time  | Day-of-week + hour picker             |
| **Monthly**    | Runs once per month on a chosen day and time | Day-of-month (1st–28th) + hour picker |
| **Custom**     | Any valid 5-field cron expression            | Text input with live validation       |

The picker shows a live preview of the next scheduled run time below the controls.

### Custom Cron Expressions

Custom expressions must use the standard 5-field format:

```
minute  hour  day-of-month  month  day-of-week
```

Examples:

| Expression      | Meaning                          |
| --------------- | -------------------------------- |
| `*/15 * * * *`  | Every 15 minutes                 |
| `0 9 * * *`     | Daily at 9:00 AM                 |
| `30 14 * * 1-5` | Weekdays at 2:30 PM              |
| `0 0 1 * *`     | First of every month at midnight |

> **Note**: The minimum schedule interval is **15 minutes**. Expressions that fire more frequently
> (e.g., `*/5 * * * *`) are rejected.

> **Note**: Six-field expressions (with seconds) are not supported.

---

## Managing Automations

### Pause and Resume

**Pausing** an automation stops it from firing. Scheduled automations will not run on their cron,
and event-driven automations will ignore incoming events until resumed. You can pause from the
automations list or the detail page.

**Resuming** reactivates the automation. Scheduled automations calculate the next run time from the
current moment. Event-driven automations resume listening immediately. Resuming also resets the
consecutive failure counter (see [Auto-Pause](#auto-pause) below).

### Trigger Now

Click **Trigger Now** to fire a one-off run immediately. For scheduled automations, this does not
affect the next scheduled run time. Manual triggers follow the same concurrency rules as all other
runs: if a run is already active, the trigger is rejected.

### Edit

You can change an automation's name, branch, model, and instructions at any time. For scheduled
automations, you can also change the schedule and timezone. The repository cannot be changed after
creation.

If you update the schedule or timezone, the next run time is recalculated automatically.

### Delete

Deleting an automation stops all future runs and removes it from the list. Existing run history and
any sessions it created are preserved.

---

## Run History

Each automation's detail page shows a chronological list of runs with status, duration, and links to
the underlying session.

### Run Statuses

| Status        | Meaning                                                                                                |
| ------------- | ------------------------------------------------------------------------------------------------------ |
| **Starting**  | A session is being created for this run.                                                               |
| **Running**   | The session is actively executing.                                                                     |
| **Completed** | The session finished successfully.                                                                     |
| **Failed**    | The session encountered an error. The failure reason is shown on the run.                              |
| **Skipped**   | The run was skipped because a previous run was still active (see [Concurrent Runs](#concurrent-runs)). |

Click **View session** on any run to jump to the full session with its output and artifacts.

---

## Automation Status

Automations display one of three statuses:

| Status       | Meaning                                                                               |
| ------------ | ------------------------------------------------------------------------------------- |
| **Enabled**  | Running normally and ready to respond to its trigger.                                 |
| **Degraded** | Enabled but has recent consecutive failures. The failure count is shown on the badge. |
| **Paused**   | Not firing. Either manually paused or auto-paused after repeated failures.            |

---

## Concurrent Runs

For scheduled and manual triggers, only one run per automation can be active at a time. If one of
those triggers fires while a previous run is still in progress, the new run is recorded as
**Skipped** with reason "concurrent run active".

Event-driven automations use concurrency keys instead. For inbound webhooks, retries with the same
`idempotencyKey` are treated as the same event, but separate deliveries without a shared
`idempotencyKey` can overlap.

Slack Message triggers key concurrency by thread. Replies in a thread are not skipped — for 7 days
after the thread's first trigger they continue the same session (during the run and after it
finishes), routed to that session as follow-up prompts (see the **Run feedback** note under
[Slack Message Triggers](#slack-message-triggers)).

This prevents overlapping sessions from interfering with each other on the same repository.

---

## Auto-Pause

If an automation fails **3 consecutive times**, it is automatically paused to prevent runaway
failures. The status changes to **Paused** and no further runs will start until you resume it.

To re-enable the automation, click **Resume**. This resets the failure counter. Scheduled
automations also compute their next run at that point.

Consecutive failures are tracked across both scheduled and manually triggered runs. A single
successful run resets the counter to zero.

Runs that time out (sessions running longer than 90 minutes) also count as failures toward the
auto-pause threshold.

---

## Limits

| Limit                                  | Value                                |
| -------------------------------------- | ------------------------------------ |
| Automation name length                 | 200 characters                       |
| Instructions length                    | 10,000 characters                    |
| Minimum schedule interval              | 15 minutes                           |
| Webhook payload size                   | 64 KB                                |
| Concurrent runs per automation         | 1 for scheduled/manual triggers only |
| Consecutive failures before auto-pause | 3                                    |
| Run execution timeout                  | 90 minutes                           |
