# RFC 010: Analytics & Insights Dashboard

> **Status**: Draft **Author**: Open-Inspect Team **Created**: 2025-01-31 **Related**:
> [Feature Ideas](../FEATURE_IDEAS.md)

## Summary

Build an analytics dashboard that provides organizational insights from session data: coverage
metrics, bug hotspots, team activity, and resolution tracking. Transform raw session data into
actionable intelligence.

## Problem Statement

Sessions generate valuable data, but it's trapped in individual session views:

- No visibility into overall testing coverage
- Bug patterns across sessions aren't surfaced
- Team workload and collaboration isn't visible
- No metrics on time-to-resolution or fix success rates

Leaders can't answer questions like:

- "What features are we testing the most/least?"
- "Where are bugs clustering?"
- "How quickly are issues being resolved?"
- "Who's working on what?"

## Goals

1. **Coverage metrics**: Visualize which features/routes are tested
2. **Bug analytics**: Surface patterns and hotspots
3. **Team activity**: Track sessions, contributions, collaboration
4. **Resolution metrics**: Time-to-fix, success rates, reopen rates
5. **Trends over time**: Historical views of all metrics

## Non-Goals

- Real-time alerting (see RFC-006 Scheduled Runs)
- Individual performance evaluation (privacy concerns)
- Financial/billing analytics
- Infrastructure monitoring

## Technical Design

### Analytics Data Pipeline

```
┌─────────────────────────────────────────────────────────────┐
│                    Session Events                            │
│              (Real-time from sessions)                       │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                    Event Processor                           │
│               (Cloudflare Queue)                             │
├─────────────────────────────────────────────────────────────┤
│  - Extracts metrics from events                             │
│  - Classifies features/routes                               │
│  - Detects bug patterns                                     │
│  - Aggregates into time buckets                             │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                    Analytics Store                           │
│                (Cloudflare D1 + R2)                          │
├─────────────────────────────────────────────────────────────┤
│  - Aggregated metrics tables                                │
│  - Pre-computed rollups (hourly, daily, weekly)             │
│  - Feature/route coverage maps                              │
│  - Bug classification data                                  │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                    Dashboard API                             │
├─────────────────────────────────────────────────────────────┤
│  - Coverage endpoints                                       │
│  - Bug analytics endpoints                                  │
│  - Team activity endpoints                                  │
│  - Resolution metrics endpoints                             │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                    Dashboard UI                              │
│                   (Next.js pages)                            │
└─────────────────────────────────────────────────────────────┘
```

### Data Model

```sql
-- Feature/route registry (discovered from sessions)
CREATE TABLE features (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  repo_owner TEXT,
  repo_name TEXT,

  -- Feature identification
  route_pattern TEXT NOT NULL,  -- e.g., '/checkout/*', '/settings/profile'
  name TEXT,  -- Human-friendly name
  category TEXT,  -- e.g., 'checkout', 'settings', 'admin'

  -- Tracking
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  session_count INTEGER DEFAULT 0,

  UNIQUE(org_id, route_pattern)
);

-- Daily aggregated metrics
CREATE TABLE daily_metrics (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  date TEXT NOT NULL,  -- YYYY-MM-DD

  -- Session metrics
  sessions_created INTEGER DEFAULT 0,
  sessions_completed INTEGER DEFAULT 0,
  sessions_failed INTEGER DEFAULT 0,

  -- Activity metrics
  total_prompts INTEGER DEFAULT 0,
  total_tool_calls INTEGER DEFAULT 0,
  total_screenshots INTEGER DEFAULT 0,

  -- PR metrics
  prs_created INTEGER DEFAULT 0,
  prs_merged INTEGER DEFAULT 0,

  -- Bug metrics
  bugs_found INTEGER DEFAULT 0,
  bugs_resolved INTEGER DEFAULT 0,

  -- Timing (in seconds)
  avg_session_duration INTEGER,
  avg_time_to_pr INTEGER,

  -- Unique counts
  unique_users INTEGER DEFAULT 0,
  unique_repos INTEGER DEFAULT 0,
  unique_features INTEGER DEFAULT 0,

  UNIQUE(org_id, date)
);

-- Feature coverage metrics
CREATE TABLE feature_coverage (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  feature_id TEXT NOT NULL,
  date TEXT NOT NULL,

  -- Coverage
  sessions_count INTEGER DEFAULT 0,
  screenshots_count INTEGER DEFAULT 0,

  -- Issues
  bugs_found INTEGER DEFAULT 0,

  -- Last activity
  last_session_id TEXT,
  last_session_at INTEGER,

  UNIQUE(org_id, feature_id, date),
  FOREIGN KEY (feature_id) REFERENCES features(id)
);

-- Bug classifications
CREATE TABLE bug_classifications (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,

  -- Source
  session_id TEXT NOT NULL,
  finding_text TEXT NOT NULL,

  -- Classification
  category TEXT,  -- 'visual', 'functional', 'ux', 'accessibility', 'performance'
  severity TEXT,  -- 'critical', 'major', 'minor', 'trivial'
  feature_id TEXT,
  route TEXT,

  -- Resolution
  status TEXT DEFAULT 'open',  -- 'open', 'resolved', 'wont_fix', 'duplicate'
  resolution_session_id TEXT,
  resolution_pr_url TEXT,
  resolved_at INTEGER,

  -- Timing
  created_at INTEGER NOT NULL,

  FOREIGN KEY (session_id) REFERENCES sessions(id),
  FOREIGN KEY (feature_id) REFERENCES features(id)
);

-- Team activity
CREATE TABLE user_activity (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  date TEXT NOT NULL,

  -- Activity counts
  sessions_created INTEGER DEFAULT 0,
  prompts_sent INTEGER DEFAULT 0,
  bugs_found INTEGER DEFAULT 0,
  prs_created INTEGER DEFAULT 0,

  -- Collaboration
  sessions_joined INTEGER DEFAULT 0,
  annotations_added INTEGER DEFAULT 0,

  UNIQUE(org_id, user_id, date)
);

-- Indexes for common queries
CREATE INDEX idx_daily_metrics_org_date ON daily_metrics(org_id, date);
CREATE INDEX idx_feature_coverage_org ON feature_coverage(org_id, date);
CREATE INDEX idx_bug_classifications_org ON bug_classifications(org_id, created_at);
CREATE INDEX idx_user_activity_org ON user_activity(org_id, date);
```

### Event Processing

```typescript
interface AnalyticsProcessor {
  // Process session events
  processSessionCreated(event: SessionCreatedEvent): Promise<void>;
  processSessionCompleted(event: SessionCompletedEvent): Promise<void>;
  processToolCall(event: ToolCallEvent): Promise<void>;
  processBugFound(event: BugFoundEvent): Promise<void>;
  processPRCreated(event: PRCreatedEvent): Promise<void>;

  // Aggregation jobs
  aggregateDaily(orgId: string, date: string): Promise<void>;
  computeFeatureCoverage(orgId: string): Promise<void>;
  classifyBugs(orgId: string): Promise<void>;
}

// Process incoming events
async function processEvent(event: SessionEvent, env: Env): Promise<void> {
  const processor = new AnalyticsProcessorImpl(env);

  switch (event.type) {
    case "session_created":
      await processor.processSessionCreated(event);
      break;
    case "session_completed":
      await processor.processSessionCompleted(event);
      break;
    case "tool_call":
      if (event.toolName === "take-screenshot") {
        await processScreenshot(event, env);
      }
      break;
    // ... other event types
  }
}

// Feature extraction from screenshots
async function processScreenshot(event: ToolCallEvent, env: Env): Promise<void> {
  const { sessionId, toolInput, toolResult } = event;
  const session = await getSession(sessionId);

  // Extract route from screenshot metadata or URL
  const route = extractRoute(toolResult);
  if (!route) return;

  // Upsert feature
  const featureId = await upsertFeature(env.DB, {
    orgId: session.orgId,
    routePattern: normalizeRoute(route),
    repoOwner: session.repoOwner,
    repoName: session.repoName,
  });

  // Update coverage
  await incrementFeatureCoverage(env.DB, {
    orgId: session.orgId,
    featureId,
    date: getCurrentDate(),
  });
}

// Bug classification using AI
async function classifyBug(finding: string, context: SessionContext): Promise<BugClassification> {
  const response = await claude.generate({
    model: "claude-3-haiku",
    system: `Classify this bug finding. Return JSON with:
      - category: 'visual' | 'functional' | 'ux' | 'accessibility' | 'performance'
      - severity: 'critical' | 'major' | 'minor' | 'trivial'
      - route: the URL/route where the bug was found (if determinable)`,
    messages: [{ role: "user", content: finding }],
  });

  return JSON.parse(response.content);
}
```

### API Endpoints

```typescript
// Dashboard summary
GET /analytics/summary
Query: { from?: string; to?: string }
Response: {
  period: { from: string; to: string };
  sessions: { total: number; completed: number; failed: number };
  bugs: { found: number; resolved: number; open: number };
  prs: { created: number; merged: number };
  coverage: { featuresTracked: number; avgCoverage: number };
}

// Coverage metrics
GET /analytics/coverage
Query: { from?: string; to?: string; repo?: string }
Response: {
  features: Array<{
    id: string;
    name: string;
    route: string;
    sessionsLast30Days: number;
    lastTested: string;
    bugCount: number;
    coverageScore: number;  // 0-100
  }>;
  coverageByCategory: Record<string, number>;
  staleFeatures: Array<{ id: string; name: string; daysSinceTest: number }>;
}

// Bug analytics
GET /analytics/bugs
Query: { from?: string; to?: string; status?: string; category?: string }
Response: {
  summary: {
    total: number;
    bySeverity: Record<string, number>;
    byCategory: Record<string, number>;
    byStatus: Record<string, number>;
  };
  hotspots: Array<{
    featureId: string;
    featureName: string;
    bugCount: number;
    percentOfTotal: number;
  }>;
  trends: Array<{
    date: string;
    found: number;
    resolved: number;
  }>;
  recentBugs: Bug[];
}

// Team activity
GET /analytics/team
Query: { from?: string; to?: string }
Response: {
  totalUsers: number;
  activeUsers: number;  // Active in period
  activity: Array<{
    date: string;
    sessions: number;
    prompts: number;
    users: number;
  }>;
  leaderboard: Array<{
    userId: string;
    userName: string;
    sessions: number;
    bugsFound: number;
    prsCreated: number;
  }>;
  collaboration: {
    sharedSessions: number;
    avgParticipantsPerSession: number;
  };
}

// Resolution metrics
GET /analytics/resolution
Query: { from?: string; to?: string }
Response: {
  avgTimeToResolution: number;  // hours
  resolutionRate: number;  // percentage
  reopenRate: number;  // percentage
  byCategory: Array<{
    category: string;
    avgTime: number;
    rate: number;
  }>;
  trends: Array<{
    date: string;
    avgTime: number;
    rate: number;
  }>;
}

// Export data
GET /analytics/export
Query: { format: 'csv' | 'json'; type: string; from?: string; to?: string }
Response: File download
```

### Dashboard Components

#### Overview Page

```
┌─────────────────────────────────────────────────────────────┐
│  Analytics Dashboard                    [Last 30 days ▼]    │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐           │
│  │   47    │ │   23    │ │   12    │ │   89%   │           │
│  │Sessions │ │  PRs    │ │  Bugs   │ │Coverage │           │
│  │ +12%    │ │ +8%     │ │ -15%    │ │ +5%     │           │
│  └─────────┘ └─────────┘ └─────────┘ └─────────┘           │
│                                                             │
│  Activity Trend                                             │
│  ┌─────────────────────────────────────────────────────┐   │
│  │     ▲                                               │   │
│  │  12 │    ┌──┐                         ┌──┐          │   │
│  │     │ ┌──┤  │    ┌──┐      ┌──┐   ┌──┤  │ ┌──┐     │   │
│  │   8 │ │  │  │ ┌──┤  │ ┌──┐ │  │   │  │  │ │  │     │   │
│  │     │ │  │  │ │  │  │ │  │ │  │   │  │  │ │  │     │   │
│  │   4 │ │  │  │ │  │  │ │  │ │  │   │  │  │ │  │     │   │
│  │     │ │  │  │ │  │  │ │  │ │  │   │  │  │ │  │     │   │
│  │   0 └─┴──┴──┴─┴──┴──┴─┴──┴─┴──┴───┴──┴──┴─┴──┴───▶ │   │
│  │     Mon Tue Wed Thu Fri Sat Sun Mon Tue Wed Thu    │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                             │
│  ■ Sessions  ■ PRs  ■ Bugs Found                           │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

#### Coverage Heatmap

```
┌─────────────────────────────────────────────────────────────┐
│  Feature Coverage                                           │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  Filter: [All Categories ▼] [All Repos ▼]                  │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐   │
│  │                                                      │   │
│  │  Checkout                                            │   │
│  │  ├── /checkout              ████████████████ 95%    │   │
│  │  ├── /checkout/cart         ████████████░░░░ 78%    │   │
│  │  ├── /checkout/payment      █████████████░░░ 85%    │   │
│  │  └── /checkout/confirm      ██████████████░░ 88%    │   │
│  │                                                      │   │
│  │  Settings                                            │   │
│  │  ├── /settings              ████░░░░░░░░░░░░ 25%    │   │
│  │  ├── /settings/profile      ███░░░░░░░░░░░░░ 18%    │   │
│  │  └── /settings/security     ██░░░░░░░░░░░░░░ 12%    │   │
│  │                                                      │   │
│  │  Admin                                               │   │
│  │  ├── /admin                 █░░░░░░░░░░░░░░░  5%    │   │
│  │  └── /admin/users           ░░░░░░░░░░░░░░░░  0%    │   │
│  │                                                      │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                             │
│  ⚠️ Stale areas (not tested in 30+ days):                  │
│  • /admin/users (never tested)                             │
│  • /settings/security (45 days)                            │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

#### Bug Hotspots

```
┌─────────────────────────────────────────────────────────────┐
│  Bug Hotspots                                               │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  Top 5 Bug-Prone Features                                   │
│  ┌─────────────────────────────────────────────────────┐   │
│  │                                                      │   │
│  │  1. /checkout/payment      ████████████████ 8 bugs  │   │
│  │     40% of all bugs • Mostly visual issues          │   │
│  │                                                      │   │
│  │  2. /checkout/cart         ██████████░░░░░░ 5 bugs  │   │
│  │     25% of all bugs • Functional + visual           │   │
│  │                                                      │   │
│  │  3. /settings/profile      ████░░░░░░░░░░░░ 2 bugs  │   │
│  │     10% of all bugs • Form validation              │   │
│  │                                                      │   │
│  │  4. /user/dashboard        ████░░░░░░░░░░░░ 2 bugs  │   │
│  │     10% of all bugs • Layout issues                 │   │
│  │                                                      │   │
│  │  5. Other                  ███░░░░░░░░░░░░░ 3 bugs  │   │
│  │     15% of all bugs                                 │   │
│  │                                                      │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                             │
│  Bug Categories                 Bug Severity                │
│  ┌────────────────────┐        ┌────────────────────┐      │
│  │  Visual    ███ 45% │        │  Critical  █░ 5%   │      │
│  │  Functional██ 30%  │        │  Major     ██ 25%  │      │
│  │  UX        █░ 15%  │        │  Minor     ███ 50% │      │
│  │  Other     ░░ 10%  │        │  Trivial   █░ 20%  │      │
│  └────────────────────┘        └────────────────────┘      │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

#### Team Activity

```
┌─────────────────────────────────────────────────────────────┐
│  Team Activity                                              │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  Active Users: 8/12 (67%)                This Week          │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ User          │ Sessions │ Bugs │ PRs │ Collab     │   │
│  ├───────────────┼──────────┼──────┼─────┼────────────┤   │
│  │ @sarah        │    12    │   4  │  3  │ ████████   │   │
│  │ @mike         │     8    │   3  │  2  │ ██████░░   │   │
│  │ @alex         │     7    │   2  │  2  │ █████░░░   │   │
│  │ @jordan       │     5    │   1  │  1  │ ████░░░░   │   │
│  │ @taylor       │     4    │   1  │  1  │ ███░░░░░   │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                             │
│  Collaboration Score: 72%                                   │
│  (Sessions with multiple participants)                      │
│                                                             │
│  Peak Activity Hours                                        │
│  ┌─────────────────────────────────────────────────────┐   │
│  │         ░░░░░░░░████████████████░░░░░░░░░░         │   │
│  │         6am         12pm         6pm         12am  │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

#### Resolution Metrics

```
┌─────────────────────────────────────────────────────────────┐
│  Resolution Metrics                                         │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐           │
│  │  4.2h   │ │   85%   │ │   12%   │ │  2.1d   │           │
│  │Avg Time │ │  Fixed  │ │ Reopen  │ │To Merge │           │
│  │ -15%    │ │ +5%     │ │ -3%     │ │ -20%    │           │
│  └─────────┘ └─────────┘ └─────────┘ └─────────┘           │
│                                                             │
│  Resolution Funnel                                          │
│  ┌─────────────────────────────────────────────────────┐   │
│  │                                                      │   │
│  │  Bug Found      ████████████████████████████  100%  │   │
│  │       ↓                                              │   │
│  │  Investigated   ██████████████████████░░░░░░   85%  │   │
│  │       ↓                                              │   │
│  │  PR Created     ████████████████░░░░░░░░░░░░   65%  │   │
│  │       ↓                                              │   │
│  │  PR Merged      ██████████████░░░░░░░░░░░░░░   58%  │   │
│  │       ↓                                              │   │
│  │  Verified Fixed ████████████░░░░░░░░░░░░░░░░   50%  │   │
│  │                                                      │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                             │
│  Time to Resolution by Category                            │
│  ┌─────────────────────────────────────────────────────┐   │
│  │  Visual      ████░░░░░░░░  2.1 hours               │   │
│  │  Functional  ████████░░░░  5.4 hours               │   │
│  │  UX          ██████████░░  8.2 hours               │   │
│  │  Performance ████████████  12.5 hours              │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

## Implementation Plan

### Phase 1: Data Pipeline (Week 1-2)

- [ ] Event processor for session events
- [ ] Daily aggregation job
- [ ] Feature extraction from screenshots
- [ ] Basic metrics storage

### Phase 2: Coverage Analytics (Week 3-4)

- [ ] Feature registry and categorization
- [ ] Coverage calculation logic
- [ ] Coverage API endpoints
- [ ] Coverage heatmap UI

### Phase 3: Bug Analytics (Week 5-6)

- [ ] Bug classification pipeline
- [ ] Hotspot detection algorithm
- [ ] Bug analytics API
- [ ] Bug dashboard UI

### Phase 4: Team & Resolution (Week 7-8)

- [ ] User activity tracking
- [ ] Resolution metrics calculation
- [ ] Team analytics API
- [ ] Team and resolution UI

### Phase 5: Polish & Export (Week 9-10)

- [ ] Dashboard overview page
- [ ] Data export functionality
- [ ] Report generation (PDF)
- [ ] Performance optimization

## Open Questions

1. **Privacy**: Should individual user activity be visible to all, or only to admins?

2. **Retention**: How long to keep detailed analytics data? Aggregate older data?

3. **Real-time vs batch**: Should dashboards update in real-time or on refresh?

4. **Custom metrics**: Allow users to define custom metrics/dashboards?

5. **Benchmarking**: Show comparison to "industry averages" or similar orgs?

## Security Considerations

- Analytics data is org-scoped
- Individual user data may be sensitive - role-based access
- Export functionality should respect access controls
- Consider GDPR: allow data deletion requests
- Avoid storing PII in analytics (use anonymized IDs where possible)
