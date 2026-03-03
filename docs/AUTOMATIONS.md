# Automations

Automations let you run coding agents on a recurring schedule. Define a task, pick a repository and
branch, set a cron schedule, and Open-Inspect will spawn a new session at each scheduled time — no
manual triggering required.

Common use cases include nightly dependency updates, periodic code quality sweeps, daily test runs,
and recurring report generation.

---

## Creating an Automation

Navigate to **Automations** in the sidebar, then click **Create Automation**.

### Required Fields

| Field            | Description                                                                                                                                                                         |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Name**         | A short label for the automation (max 200 characters). Appears in the automations list and in session titles prefixed with `[Auto]`.                                                |
| **Repository**   | The GitHub repository to run against. Only repositories installed on the GitHub App are available. Cannot be changed after creation.                                                |
| **Schedule**     | When and how often to run. See [Schedule Options](#schedule-options) below.                                                                                                         |
| **Timezone**     | The IANA timezone for interpreting the schedule. Defaults to your browser's local timezone.                                                                                         |
| **Instructions** | The prompt sent to the coding agent each time the automation fires (max 10,000 characters). Write this as you would a normal session prompt — be specific about what you want done. |

### Optional Fields

| Field      | Description                                                                                     |
| ---------- | ----------------------------------------------------------------------------------------------- |
| **Branch** | The base branch for each session. Defaults to the repository's default branch (usually `main`). |
| **Model**  | The AI model to use. Defaults to the system default model.                                      |

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

**Pausing** an automation stops it from firing on schedule. No new runs will be created until it is
resumed. You can pause from the automations list or the detail page.

**Resuming** reactivates the automation and calculates the next run time from the current moment. It
also resets the consecutive failure counter (see [Auto-Pause](#auto-pause) below).

### Trigger Now

Click **Trigger Now** to fire a one-off run immediately, regardless of the schedule. This does not
affect the next scheduled run time. Manual triggers follow the same concurrency rules as scheduled
runs — if a run is already active, the trigger is rejected.

### Edit

You can change an automation's name, branch, model, schedule, timezone, and instructions at any
time. The repository cannot be changed after creation.

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
| **Enabled**  | Running normally on schedule.                                                         |
| **Degraded** | Enabled but has recent consecutive failures. The failure count is shown on the badge. |
| **Paused**   | Not firing. Either manually paused or auto-paused after repeated failures.            |

---

## Concurrent Runs

Only one run per automation can be active at a time. If a scheduled run fires while a previous run
is still in progress, the new run is recorded as **Skipped** with reason "concurrent run active" and
the schedule advances to the next occurrence.

This prevents overlapping sessions from interfering with each other on the same repository.

---

## Auto-Pause

If an automation fails **3 consecutive times**, it is automatically paused to prevent runaway
failures. The status changes to **Paused** and no further runs are scheduled.

To re-enable the automation, click **Resume**. This resets the failure counter and schedules the
next run.

Consecutive failures are tracked across both scheduled and manually triggered runs. A single
successful run resets the counter to zero.

Runs that time out (sessions running longer than 90 minutes) also count as failures toward the
auto-pause threshold.

---

## Limits

| Limit                                  | Value             |
| -------------------------------------- | ----------------- |
| Automation name length                 | 200 characters    |
| Instructions length                    | 10,000 characters |
| Minimum schedule interval              | 15 minutes        |
| Concurrent runs per automation         | 1                 |
| Consecutive failures before auto-pause | 3                 |
| Run execution timeout                  | 90 minutes        |
