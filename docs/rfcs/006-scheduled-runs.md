# RFC 006: Scheduled & Triggered Runs

> **Status**: Draft **Author**: Open-Inspect Team **Created**: 2025-01-31 **Related**:
> [Feature Ideas](../FEATURE_IDEAS.md), [RFC-002 Playbooks](./002-playbooks.md)

## Summary

Enable automated session execution through scheduled runs (cron-style) and event-triggered runs (PR
merged, deploy completed). This transforms Open-Inspect from a reactive tool into a proactive QA
system that catches issues before users report them.

## Problem Statement

Current workflow is entirely human-initiated:

1. Bug is reported or feature is questioned
2. Human creates session to investigate
3. Human reviews findings

This means issues are only caught after they impact users. We want to flip this:

1. Automated runs detect issues proactively
2. Alerts notify humans of problems
3. Humans review and fix before users are affected

## Goals

1. **Scheduled execution**: Run playbooks on cron schedules (nightly, weekly, etc.)
2. **Event triggers**: Run on GitHub events (PR merge, deployment, issue created)
3. **Baseline comparison**: Detect changes from expected behavior
4. **Smart alerting**: Notify via Slack/Teams/email when issues detected
5. **Run history**: Track all automated runs with pass/fail status

## Non-Goals

- Full CI/CD replacement (complement, not replace)
- Load testing or performance benchmarking
- Security scanning (different tooling needed)
- Real-time monitoring (this is batch/scheduled)

## Technical Design

### Schedule Configuration

```yaml
# schedules.yaml
apiVersion: v1
kind: ScheduleConfig
metadata:
  orgId: acme-corp

schedules:
  - id: nightly-checkout
    name: Nightly Checkout Flow
    enabled: true

    # When to run
    cron: "0 2 * * *" # 2 AM UTC daily
    timezone: "America/New_York"

    # What to run
    playbook: checkout-flow-audit
    repo: acme-corp/frontend
    branch: main
    variables:
      feature_url: "https://staging.acme.com/checkout"
      test_user: "qa-bot@acme.com"

    # How long before timeout
    timeout_minutes: 30

    # Notifications
    notify:
      on_failure:
        slack_channel: "#qa-alerts"
        mention: ["@qa-team"]
      on_success:
        slack_channel: "#qa-daily" # Optional success notifications

    # Baseline comparison
    baseline:
      enabled: true
      tolerance: 0.02 # Allow 2% visual diff
      update_on_success: false # Manual baseline updates

  - id: weekly-full-audit
    name: Weekly Full Application Audit
    enabled: true
    cron: "0 4 * * 0" # 4 AM Sunday
    playbooks: # Run multiple playbooks in sequence
      - checkout-flow-audit
      - user-profile-audit
      - settings-audit
    repo: acme-corp/frontend
    branch: main
    timeout_minutes: 120
    notify:
      on_complete: # Always notify with summary
        slack_channel: "#qa-weekly"

triggers:
  - id: post-merge-smoke
    name: Post-Merge Smoke Test
    enabled: true

    # Trigger conditions
    event: pull_request.merged
    repo: acme-corp/frontend
    branches: [main, staging]
    paths: # Only trigger if these paths changed
      - "src/checkout/**"
      - "src/components/Button/**"

    # What to run
    playbook: quick-smoke-test
    variables:
      focus_area: "{{changed_paths}}" # Inject context from trigger

    timeout_minutes: 15

    notify:
      on_failure:
        slack_channel: "#deploys"
        mention: ["{{pr_author}}"] # Mention the PR author

  - id: deploy-verification
    name: Production Deploy Verification
    enabled: true
    event: deployment.completed
    environment: production
    playbook: production-smoke-test
    variables:
      base_url: "https://app.acme.com"
    timeout_minutes: 10
    notify:
      on_failure:
        slack_channel: "#incidents"
        pagerduty: true
```

### Data Model

```sql
-- Schedule definitions
CREATE TABLE schedules (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  name TEXT NOT NULL,
  config TEXT NOT NULL,  -- YAML/JSON configuration
  enabled BOOLEAN DEFAULT TRUE,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  created_by TEXT NOT NULL,

  -- Computed from config for indexing
  cron_expression TEXT,
  next_run_at INTEGER,

  FOREIGN KEY (org_id) REFERENCES organizations(id)
);

-- Trigger definitions
CREATE TABLE triggers (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  name TEXT NOT NULL,
  config TEXT NOT NULL,
  enabled BOOLEAN DEFAULT TRUE,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  created_by TEXT NOT NULL,

  -- For indexing webhook routing
  event_type TEXT NOT NULL,
  repo_pattern TEXT,

  FOREIGN KEY (org_id) REFERENCES organizations(id)
);

-- Run history
CREATE TABLE automated_runs (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,

  -- Source
  schedule_id TEXT,  -- Null if triggered
  trigger_id TEXT,   -- Null if scheduled
  trigger_event TEXT,  -- JSON of triggering event

  -- Execution
  session_id TEXT,  -- The session that was created
  playbook_id TEXT,
  status TEXT NOT NULL,  -- 'pending', 'running', 'passed', 'failed', 'timeout', 'cancelled'

  -- Timing
  scheduled_at INTEGER,
  started_at INTEGER,
  completed_at INTEGER,

  -- Results
  findings_count INTEGER DEFAULT 0,
  screenshots_count INTEGER DEFAULT 0,
  baseline_diff_score REAL,
  error_message TEXT,

  -- Notifications
  notifications_sent TEXT,  -- JSON array of notification IDs

  FOREIGN KEY (schedule_id) REFERENCES schedules(id),
  FOREIGN KEY (trigger_id) REFERENCES triggers(id),
  FOREIGN KEY (session_id) REFERENCES sessions(id)
);

-- Baseline snapshots for comparison
CREATE TABLE baselines (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  schedule_id TEXT NOT NULL,

  -- Baseline content
  screenshots TEXT NOT NULL,  -- JSON array of { url, route, viewport }
  created_at INTEGER NOT NULL,
  created_by TEXT NOT NULL,  -- 'auto' or user_id

  -- Metadata
  source_run_id TEXT,
  notes TEXT,
  is_active BOOLEAN DEFAULT TRUE,

  FOREIGN KEY (schedule_id) REFERENCES schedules(id)
);
```

### Scheduler Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Scheduler Service                         │
│                (Cloudflare Cron Trigger)                     │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  Every minute:                                               │
│  1. Query schedules WHERE next_run_at <= now AND enabled    │
│  2. For each due schedule:                                  │
│     a. Create automated_run record                          │
│     b. Create session with playbook                         │
│     c. Update next_run_at based on cron                     │
│  3. Check running runs for timeout                          │
│                                                              │
└─────────────────────────────────────────────────────────────┘
         │
         │ Creates
         ▼
┌─────────────────────────────────────────────────────────────┐
│                    Session Execution                         │
│                  (Normal Session Flow)                       │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  - Session runs playbook automatically                      │
│  - No human interaction required                            │
│  - Completion triggers result processing                    │
│                                                              │
└─────────────────────────────────────────────────────────────┘
         │
         │ On complete
         ▼
┌─────────────────────────────────────────────────────────────┐
│                    Result Processor                          │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  1. Analyze session outcomes                                │
│  2. Compare to baseline (if configured)                     │
│  3. Determine pass/fail status                              │
│  4. Send notifications                                      │
│  5. Update baseline (if auto-update enabled)                │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

### Cron Trigger Implementation

Using Cloudflare Workers Cron Triggers:

```typescript
// wrangler.toml
[triggers]
crons = ["* * * * *"]  # Every minute

// scheduler.ts
export default {
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    const now = Date.now();

    // Get due schedules
    const dueSchedules = await env.DB.prepare(`
      SELECT * FROM schedules
      WHERE enabled = TRUE
        AND next_run_at <= ?
      ORDER BY next_run_at ASC
      LIMIT 10
    `).bind(now).all();

    for (const schedule of dueSchedules.results) {
      ctx.waitUntil(executeSchedule(schedule, env));
    }

    // Check for timed out runs
    ctx.waitUntil(checkTimeouts(env));
  }
};

async function executeSchedule(schedule: Schedule, env: Env): Promise<void> {
  const config = JSON.parse(schedule.config);

  // Create run record
  const runId = generateId();
  await env.DB.prepare(`
    INSERT INTO automated_runs (id, org_id, schedule_id, status, scheduled_at)
    VALUES (?, ?, ?, 'pending', ?)
  `).bind(runId, schedule.org_id, schedule.id, Date.now()).run();

  // Create session
  const session = await createSession({
    orgId: schedule.org_id,
    repoOwner: config.repo.split('/')[0],
    repoName: config.repo.split('/')[1],
    branch: config.branch,
    name: `[Scheduled] ${schedule.name}`,
    automatedRunId: runId,
    playbook: config.playbook,
    playbookVariables: config.variables
  });

  // Update run with session
  await env.DB.prepare(`
    UPDATE automated_runs
    SET session_id = ?, status = 'running', started_at = ?
    WHERE id = ?
  `).bind(session.id, Date.now(), runId).run();

  // Update next run time
  const nextRun = getNextCronTime(config.cron, config.timezone);
  await env.DB.prepare(`
    UPDATE schedules SET next_run_at = ? WHERE id = ?
  `).bind(nextRun, schedule.id).run();
}
```

### Webhook Handler for Triggers

```typescript
// Handle GitHub webhooks for triggers
async function handleGitHubWebhook(event: GitHubEvent, env: Env): Promise<void> {
  const eventType = getEventType(event); // 'pull_request.merged', 'deployment.completed', etc.

  // Find matching triggers
  const triggers = await env.DB.prepare(
    `
    SELECT * FROM triggers
    WHERE enabled = TRUE
      AND event_type = ?
      AND (repo_pattern IS NULL OR ? LIKE repo_pattern)
  `
  )
    .bind(eventType, event.repository.full_name)
    .all();

  for (const trigger of triggers.results) {
    const config = JSON.parse(trigger.config);

    // Check additional conditions (paths, branches, etc.)
    if (!matchesTriggerConditions(event, config)) continue;

    // Create and execute run
    await executeTrigger(trigger, event, env);
  }
}

async function executeTrigger(trigger: Trigger, event: GitHubEvent, env: Env): Promise<void> {
  const config = JSON.parse(trigger.config);

  // Interpolate variables from event
  const variables = interpolateVariables(config.variables, {
    changed_paths: event.pull_request?.changed_files || [],
    pr_author: event.pull_request?.user?.login,
    pr_number: event.pull_request?.number,
    commit_sha: event.after || event.pull_request?.merge_commit_sha,
    // ... more context
  });

  // Create run and session
  const runId = generateId();
  await env.DB.prepare(
    `
    INSERT INTO automated_runs
    (id, org_id, trigger_id, trigger_event, status, scheduled_at)
    VALUES (?, ?, ?, ?, 'pending', ?)
  `
  )
    .bind(runId, trigger.org_id, trigger.id, JSON.stringify(event), Date.now())
    .run();

  // Create session with trigger context
  const session = await createSession({
    orgId: trigger.org_id,
    repoOwner: event.repository.owner.login,
    repoName: event.repository.name,
    branch: config.branch || event.pull_request?.base?.ref || "main",
    name: `[Triggered] ${trigger.name}`,
    automatedRunId: runId,
    playbook: config.playbook,
    playbookVariables: variables,
    triggerContext: {
      event: event,
      triggerId: trigger.id,
    },
  });

  // Update run
  await env.DB.prepare(
    `
    UPDATE automated_runs
    SET session_id = ?, status = 'running', started_at = ?
    WHERE id = ?
  `
  )
    .bind(session.id, Date.now(), runId)
    .run();
}
```

### Baseline Comparison

```typescript
interface BaselineComparison {
  compare(
    currentScreenshots: Screenshot[],
    baseline: Baseline,
    tolerance: number
  ): Promise<BaselineResult>;

  updateBaseline(
    scheduleId: string,
    screenshots: Screenshot[],
    createdBy: string
  ): Promise<Baseline>;
}

interface BaselineResult {
  passed: boolean;
  overallDiffScore: number;
  comparisons: Array<{
    route: string;
    viewport: string;
    baselineUrl: string;
    currentUrl: string;
    diffUrl: string;
    diffScore: number;
    passed: boolean;
  }>;
}

async function compareToBaseline(
  runId: string,
  scheduleId: string,
  screenshots: Screenshot[],
  env: Env
): Promise<BaselineResult> {
  // Get active baseline
  const baseline = await env.DB.prepare(
    `
    SELECT * FROM baselines
    WHERE schedule_id = ? AND is_active = TRUE
    ORDER BY created_at DESC LIMIT 1
  `
  )
    .bind(scheduleId)
    .first();

  if (!baseline) {
    // No baseline - pass by default, create initial baseline
    await createInitialBaseline(scheduleId, screenshots, env);
    return { passed: true, overallDiffScore: 0, comparisons: [] };
  }

  const baselineScreenshots = JSON.parse(baseline.screenshots);
  const comparisons: BaselineResult["comparisons"] = [];
  let totalDiff = 0;

  for (const current of screenshots) {
    const baselineMatch = baselineScreenshots.find(
      (b: any) => b.route === current.route && b.viewport === current.viewport
    );

    if (!baselineMatch) {
      // New route/viewport - flag as changed
      comparisons.push({
        route: current.route,
        viewport: current.viewport,
        baselineUrl: null,
        currentUrl: current.url,
        diffUrl: null,
        diffScore: 1, // 100% different (new)
        passed: false,
      });
      totalDiff += 1;
      continue;
    }

    // Compare images
    const diff = await compareImages(baselineMatch.url, current.url);
    const passed = diff.score <= (baseline.tolerance || 0.02);

    comparisons.push({
      route: current.route,
      viewport: current.viewport,
      baselineUrl: baselineMatch.url,
      currentUrl: current.url,
      diffUrl: diff.diffImageUrl,
      diffScore: diff.score,
      passed,
    });

    totalDiff += diff.score;
  }

  const overallDiffScore = totalDiff / Math.max(screenshots.length, 1);
  const passed = comparisons.every((c) => c.passed);

  return { passed, overallDiffScore, comparisons };
}
```

### Notification System

```typescript
interface NotificationService {
  sendSlackAlert(config: SlackNotificationConfig, run: AutomatedRun): Promise<void>;
  sendTeamsAlert(config: TeamsNotificationConfig, run: AutomatedRun): Promise<void>;
  sendPagerDutyAlert(config: PagerDutyConfig, run: AutomatedRun): Promise<void>;
  sendEmail(config: EmailConfig, run: AutomatedRun): Promise<void>;
}

async function sendNotifications(run: AutomatedRun, config: NotifyConfig, env: Env): Promise<void> {
  const shouldNotify =
    (run.status === "failed" && config.on_failure) ||
    (run.status === "passed" && config.on_success) ||
    config.on_complete;

  if (!shouldNotify) return;

  const notifyConfig =
    run.status === "failed"
      ? config.on_failure
      : run.status === "passed"
        ? config.on_success
        : config.on_complete;

  // Build notification content
  const session = await getSession(run.session_id);
  const content = buildNotificationContent(run, session);

  // Send to configured channels
  if (notifyConfig.slack_channel) {
    await sendSlackNotification({
      channel: notifyConfig.slack_channel,
      mentions: notifyConfig.mention,
      content,
      sessionUrl: getSessionUrl(session),
      screenshots: run.status === "failed" ? session.screenshots.slice(0, 3) : [],
    });
  }

  if (notifyConfig.pagerduty) {
    await sendPagerDutyAlert({
      severity: "critical",
      summary: `Automated run failed: ${run.name}`,
      details: content,
    });
  }

  // Record notifications sent
  await env.DB.prepare(
    `
    UPDATE automated_runs SET notifications_sent = ? WHERE id = ?
  `
  )
    .bind(JSON.stringify({ slack: true, pagerduty: notifyConfig.pagerduty }), run.id)
    .run();
}
```

### API Endpoints

```typescript
// Schedule management
POST   /schedules
GET    /schedules
GET    /schedules/:id
PUT    /schedules/:id
DELETE /schedules/:id
POST   /schedules/:id/enable
POST   /schedules/:id/disable
POST   /schedules/:id/run-now  // Manual trigger

// Trigger management
POST   /triggers
GET    /triggers
GET    /triggers/:id
PUT    /triggers/:id
DELETE /triggers/:id
POST   /triggers/:id/enable
POST   /triggers/:id/disable
POST   /triggers/:id/test  // Simulate trigger

// Run history
GET    /runs
Query: { schedule_id?, trigger_id?, status?, from?, to? }
GET    /runs/:id
POST   /runs/:id/cancel
POST   /runs/:id/retry

// Baselines
GET    /schedules/:id/baselines
POST   /schedules/:id/baselines  // Create new baseline
PUT    /schedules/:id/baselines/:baselineId/activate
DELETE /schedules/:id/baselines/:baselineId
```

### UI Components

#### Schedule List

```
┌─────────────────────────────────────────────────────────────┐
│  Automated Runs                               [+ Schedule]  │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  Schedules                                                  │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ ● Nightly Checkout Flow               Next: 2 AM    │   │
│  │   Every day at 2:00 AM • checkout-flow-audit        │   │
│  │   Last run: ✅ Passed (2h ago) • 0 issues          │   │
│  │   [Run Now] [Edit] [Disable]                        │   │
│  └─────────────────────────────────────────────────────┘   │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ ● Weekly Full Audit                   Next: Sunday  │   │
│  │   Every Sunday at 4:00 AM • 3 playbooks             │   │
│  │   Last run: ⚠️ 2 issues found (5d ago)             │   │
│  │   [Run Now] [Edit] [Disable]                        │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                             │
│  Triggers                                    [+ Trigger]    │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ ⚡ Post-Merge Smoke Test                            │   │
│  │   On PR merge to main • acme-corp/frontend          │   │
│  │   Last triggered: 3h ago • ✅ Passed                │   │
│  │   [Test] [Edit] [Disable]                           │   │
│  └─────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

#### Run History

```
┌─────────────────────────────────────────────────────────────┐
│  Run History                                                │
├─────────────────────────────────────────────────────────────┤
│  Filter: [All ▼] [Last 7 days ▼] [All statuses ▼]          │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ ❌ Nightly Checkout Flow              Jan 31, 2:00 AM│   │
│  │    Duration: 12 min • 2 issues found                │   │
│  │    Baseline diff: 3.2% (threshold: 2%)              │   │
│  │    [View Session] [View Diff] [Update Baseline]     │   │
│  └─────────────────────────────────────────────────────┘   │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ ✅ Post-Merge Smoke Test              Jan 30, 4:32 PM│   │
│  │    Triggered by: PR #456 merged                     │   │
│  │    Duration: 8 min • 0 issues                       │   │
│  │    [View Session]                                   │   │
│  └─────────────────────────────────────────────────────┘   │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ ✅ Nightly Checkout Flow              Jan 30, 2:00 AM│   │
│  │    Duration: 11 min • 0 issues                      │   │
│  │    [View Session]                                   │   │
│  └─────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

#### Baseline Management

```
┌─────────────────────────────────────────────────────────────┐
│  Baseline: Nightly Checkout Flow                            │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  Active Baseline: Jan 28, 2025 (3 days ago)                │
│  Created by: sarah@ after run #1234                        │
│                                                             │
│  Screenshots (8):                                           │
│  ┌─────┐ ┌─────┐ ┌─────┐ ┌─────┐ ┌─────┐ ┌─────┐          │
│  │     │ │     │ │     │ │     │ │     │ │     │ ...      │
│  │ 📸  │ │ 📸  │ │ 📸  │ │ 📸  │ │ 📸  │ │ 📸  │          │
│  └─────┘ └─────┘ └─────┘ └─────┘ └─────┘ └─────┘          │
│  /checkout /cart /payment /confirm /success /error          │
│                                                             │
│  Previous Baselines:                                        │
│  • Jan 25, 2025 - Created by auto after successful run     │
│  • Jan 20, 2025 - Created by mike@ manually                │
│                                                             │
│  [Update from Latest Run]  [Upload New Baseline]           │
└─────────────────────────────────────────────────────────────┘
```

## Implementation Plan

### Phase 1: Scheduler Core (Week 1-2)

- [ ] Schedule data model and API
- [ ] Cron trigger implementation
- [ ] Basic run execution flow
- [ ] Run history tracking

### Phase 2: Event Triggers (Week 3-4)

- [ ] Trigger data model and API
- [ ] GitHub webhook integration
- [ ] Variable interpolation
- [ ] Trigger testing endpoint

### Phase 3: Baselines & Comparison (Week 5-6)

- [ ] Baseline storage and management
- [ ] Visual comparison integration
- [ ] Pass/fail determination
- [ ] Baseline update workflow

### Phase 4: Notifications (Week 7-8)

- [ ] Slack notification integration
- [ ] Teams notification integration
- [ ] PagerDuty integration
- [ ] Email notifications

### Phase 5: UI & Polish (Week 9-10)

- [ ] Schedule management UI
- [ ] Run history dashboard
- [ ] Baseline management UI
- [ ] Real-time run status updates

## Open Questions

1. **Concurrency**: Can multiple scheduled runs execute simultaneously? Limit per org?

2. **Retry policy**: How to handle flaky runs? Automatic retry with backoff?

3. **Cost management**: Scheduled runs use compute - billing model? Limits?

4. **Baseline drift**: How to handle gradual acceptable changes vs regressions?

5. **Trigger debouncing**: If 5 PRs merge in 5 minutes, run 5 times or debounce?

## Security Considerations

- Scheduled runs execute with service account, not user credentials
- Webhook signatures must be verified
- Variables from triggers could be attack vectors - sanitize inputs
- Rate limiting on webhook endpoints
- Baseline images may contain sensitive UI - access control required
