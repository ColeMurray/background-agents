# RFC 002: Smart Session Templates (Playbooks)

> **Status**: Draft **Author**: Open-Inspect Team **Created**: 2025-01-31 **Related**:
> [Feature Ideas](../FEATURE_IDEAS.md)

## Summary

Introduce "Playbooks" - reusable session templates that codify repeatable testing patterns. Teams
can create, share, and refine playbooks for common workflows like QA audits, feature exploration,
and regression testing.

## Problem Statement

Users frequently run similar session patterns:

- "Navigate to feature X, screenshot all states, test edge cases, reset"
- "Check this PR's changes, verify they work, test related features"
- "Audit this page for accessibility issues"

Today, users must manually type these instructions each time, leading to:

- Inconsistent testing coverage
- Forgotten steps in complex workflows
- No institutional knowledge capture
- Difficulty onboarding new team members to testing patterns

## Goals

1. **Capture patterns**: Save session flows as reusable templates
2. **Parameterization**: Templates accept variables (feature URL, test data, etc.)
3. **Team sharing**: Playbooks shared across organization
4. **Adaptive execution**: Agent follows template but adapts intelligently
5. **Progress tracking**: Visual indication of playbook progress
6. **Analytics**: Track playbook usage and success rates

## Non-Goals

- Fully deterministic execution (agent maintains autonomy)
- Visual playbook builder (YAML/JSON editing is fine for v1)
- Branching/conditional logic in playbooks (keep it simple)
- Integration with external test frameworks (Playwright, Cypress)

## Technical Design

### Playbook Schema

```yaml
# playbook.yaml
apiVersion: v1
kind: Playbook
metadata:
  id: ux-audit-v1
  name: UX Audit
  description: Comprehensive feature exploration and bug hunting
  author: sarah@company.com
  created: 2025-01-15
  updated: 2025-01-30
  tags: [qa, ux, visual-testing]

spec:
  # Variables that must be provided when starting
  variables:
    - name: feature_url
      type: string
      description: URL of the feature to audit
      required: true
    - name: test_user
      type: string
      description: User account to test with
      default: "test@example.com"
    - name: include_mobile
      type: boolean
      description: Also test mobile viewport
      default: true

  # Setup instructions run before steps
  setup: |
    Navigate to {{feature_url}} and log in as {{test_user}}.
    Take a screenshot of the initial state.

  # Main steps - agent executes in order but can adapt
  steps:
    - id: explore-states
      name: Explore Main States
      instruction: |
        Explore all main states of this feature:
        - List/index view
        - Detail view
        - Edit/create form
        - Empty state (if applicable)
        - Error states (if easily triggerable)
        Take a screenshot of each state.
      success_criteria:
        - At least 3 screenshots taken
        - All major UI states documented

    - id: edge-cases
      name: Test Edge Cases
      instruction: |
        Test the feature with edge case inputs:
        - Very long text (500+ characters)
        - Special characters (!@#$%^&*)
        - Empty/blank inputs
        - Maximum values
        - Minimum values
        Document any unexpected behavior.
      success_criteria:
        - At least 5 edge cases tested
        - Any bugs documented with screenshots

    - id: mobile-test
      name: Mobile Viewport Test
      condition: "{{include_mobile}}"
      instruction: |
        Resize to mobile viewport (375x667).
        Navigate through the same states tested earlier.
        Screenshot any layout issues or broken elements.
      success_criteria:
        - Mobile screenshots taken
        - Layout issues documented

    - id: document-bugs
      name: Document Findings
      instruction: |
        Summarize all bugs and issues found:
        - Visual bugs (misalignment, overflow, etc.)
        - Functional bugs (broken interactions)
        - UX issues (confusing flows, missing feedback)
        Create a structured list with severity ratings.

    - id: cleanup
      name: Reset State
      instruction: |
        Reset any test data created during this audit.
        Return the feature to its original state.
        Confirm cleanup is complete.

  # Teardown runs even if steps fail
  teardown: |
    Ensure browser is on a neutral page.
    Log out if still logged in.
```

### Data Model

```sql
-- Playbooks table
CREATE TABLE playbooks (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,  -- For multi-tenancy
  name TEXT NOT NULL,
  description TEXT,
  author_id TEXT NOT NULL,
  spec TEXT NOT NULL,  -- YAML/JSON content
  version INTEGER DEFAULT 1,
  is_public BOOLEAN DEFAULT FALSE,  -- Shared across orgs
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  FOREIGN KEY (author_id) REFERENCES users(id)
);

-- Playbook versions for history
CREATE TABLE playbook_versions (
  id TEXT PRIMARY KEY,
  playbook_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  spec TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  created_by TEXT NOT NULL,
  change_notes TEXT,
  FOREIGN KEY (playbook_id) REFERENCES playbooks(id)
);

-- Track playbook executions
CREATE TABLE playbook_runs (
  id TEXT PRIMARY KEY,
  playbook_id TEXT NOT NULL,
  playbook_version INTEGER NOT NULL,
  session_id TEXT NOT NULL,
  variables TEXT,  -- JSON of variable values used
  started_at INTEGER NOT NULL,
  completed_at INTEGER,
  status TEXT NOT NULL,  -- 'running', 'completed', 'failed', 'cancelled'
  current_step_id TEXT,
  step_results TEXT,  -- JSON array of step outcomes
  FOREIGN KEY (playbook_id) REFERENCES playbooks(id),
  FOREIGN KEY (session_id) REFERENCES sessions(id)
);

-- Link sessions to playbooks
ALTER TABLE sessions ADD COLUMN playbook_run_id TEXT;
```

### Execution Engine

The playbook executor doesn't rigidly control the agent. Instead, it:

1. **Injects context**: Adds playbook instructions to system prompt
2. **Tracks progress**: Monitors which steps have been addressed
3. **Provides nudges**: Suggests next step when agent seems done with current
4. **Validates completion**: Checks success criteria before moving on

```typescript
interface PlaybookExecutor {
  // Start playbook execution
  start(
    sessionId: string,
    playbookId: string,
    variables: Record<string, unknown>
  ): Promise<PlaybookRun>;

  // Get current state
  getState(runId: string): Promise<PlaybookRunState>;

  // Agent reports step completion
  completeStep(runId: string, stepId: string, result: StepResult): Promise<void>;

  // Skip a step (user or agent decision)
  skipStep(runId: string, stepId: string, reason: string): Promise<void>;

  // Pause/resume execution
  pause(runId: string): Promise<void>;
  resume(runId: string): Promise<void>;

  // Cancel execution
  cancel(runId: string): Promise<void>;
}

interface PlaybookRunState {
  runId: string;
  playbookId: string;
  status: "running" | "paused" | "completed" | "failed" | "cancelled";
  currentStepIndex: number;
  steps: Array<{
    id: string;
    name: string;
    status: "pending" | "running" | "completed" | "skipped" | "failed";
    startedAt?: number;
    completedAt?: number;
    result?: StepResult;
  }>;
  progress: number; // 0-100
}

interface StepResult {
  success: boolean;
  screenshots: string[]; // Artifact IDs
  findings: string[];
  notes?: string;
}
```

### System Prompt Integration

When a playbook is active, the agent's system prompt is augmented:

```
You are executing a playbook: "UX Audit"

Current step (2 of 5): Test Edge Cases
Instructions: Test the feature with edge case inputs...

Success criteria:
- At least 5 edge cases tested
- Any bugs documented with screenshots

Progress:
✓ Step 1: Explore Main States - Completed
→ Step 2: Test Edge Cases - In Progress
○ Step 3: Mobile Viewport Test - Pending
○ Step 4: Document Findings - Pending
○ Step 5: Reset State - Pending

When you've completed the current step, say "Step complete" and summarize what you did.
If you need to skip this step, say "Skip step" and explain why.
```

### API Endpoints

```typescript
// Playbook CRUD
GET    /playbooks                    // List playbooks
POST   /playbooks                    // Create playbook
GET    /playbooks/:id                // Get playbook
PUT    /playbooks/:id                // Update playbook
DELETE /playbooks/:id                // Delete playbook
GET    /playbooks/:id/versions       // List versions
GET    /playbooks/:id/versions/:v    // Get specific version

// Playbook execution
POST   /sessions/:id/playbook/start  // Start playbook in session
Body: { playbookId: string, variables: Record<string, unknown> }

GET    /sessions/:id/playbook        // Get current playbook state
POST   /sessions/:id/playbook/step/:stepId/complete  // Mark step complete
POST   /sessions/:id/playbook/step/:stepId/skip      // Skip step
POST   /sessions/:id/playbook/pause  // Pause execution
POST   /sessions/:id/playbook/resume // Resume execution
POST   /sessions/:id/playbook/cancel // Cancel execution

// Analytics
GET    /playbooks/:id/analytics      // Usage stats
GET    /playbooks/:id/runs           // Execution history
```

### UI Components

#### Playbook Library

```
┌─────────────────────────────────────────────────────────────┐
│  Playbooks                                    [+ New]       │
├─────────────────────────────────────────────────────────────┤
│  🔍 Search playbooks...                                     │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ 📋 UX Audit                              ⭐ 12 runs │   │
│  │ Comprehensive feature exploration and bug hunting    │   │
│  │ by sarah@ • Updated 2 days ago                      │   │
│  │ [Start] [Edit] [...]                                │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ 📋 PR Review Checklist                    ⭐ 8 runs │   │
│  │ Verify PR changes work correctly                     │   │
│  │ by mike@ • Updated 1 week ago                       │   │
│  │ [Start] [Edit] [...]                                │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ 📋 Accessibility Audit                    ⭐ 3 runs │   │
│  │ Check WCAG compliance and screen reader support      │   │
│  │ by alex@ • Updated 3 weeks ago                      │   │
│  │ [Start] [Edit] [...]                                │   │
│  └─────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

#### Start Playbook Dialog

```
┌─────────────────────────────────────────────────────────────┐
│  Start Playbook: UX Audit                                   │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  Configure variables:                                       │
│                                                             │
│  Feature URL *                                              │
│  [https://app.example.com/payments                    ]     │
│                                                             │
│  Test User                                                  │
│  [test@example.com                                   ]      │
│                                                             │
│  ☑ Include mobile viewport testing                         │
│                                                             │
│  ─────────────────────────────────────────────────────     │
│  Steps to execute:                                          │
│  ☑ 1. Explore Main States                                  │
│  ☑ 2. Test Edge Cases                                      │
│  ☑ 3. Mobile Viewport Test                                 │
│  ☑ 4. Document Findings                                    │
│  ☑ 5. Reset State                                          │
│                                                             │
│  [Cancel]                              [Start Playbook]     │
└─────────────────────────────────────────────────────────────┘
```

#### Progress Indicator (In Session)

```
┌─────────────────────────────────────────────────────────────┐
│  📋 UX Audit                                    ▐▐ Pause    │
├─────────────────────────────────────────────────────────────┤
│  ████████████░░░░░░░░░░░░░░░░░░░░░░░░░░░  40%              │
│                                                             │
│  ✓ Explore Main States         3 screenshots               │
│  → Test Edge Cases             Running...                   │
│  ○ Mobile Viewport Test                                     │
│  ○ Document Findings                                        │
│  ○ Reset State                                              │
│                                                             │
│  [Skip Current Step]  [View Step Details]  [Cancel]         │
└─────────────────────────────────────────────────────────────┘
```

#### Playbook Editor

```
┌─────────────────────────────────────────────────────────────┐
│  Edit Playbook: UX Audit                        [Save]      │
├─────────────────────────────────────────────────────────────┤
│  Name: [UX Audit                                      ]     │
│  Description: [Comprehensive feature exploration...   ]     │
│  Tags: [qa] [ux] [visual-testing] [+]                      │
│                                                             │
│  Variables                                     [+ Add]      │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ feature_url (string) * - URL of the feature         │   │
│  │ test_user (string) = "test@example.com"             │   │
│  │ include_mobile (boolean) = true                     │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                             │
│  Steps                                         [+ Add]      │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ ≡ 1. Explore Main States                    [Edit]  │   │
│  │ ≡ 2. Test Edge Cases                        [Edit]  │   │
│  │ ≡ 3. Mobile Viewport Test  (if include_mobile)      │   │
│  │ ≡ 4. Document Findings                      [Edit]  │   │
│  │ ≡ 5. Reset State                            [Edit]  │   │
│  └─────────────────────────────────────────────────────┘   │
│  (Drag to reorder)                                          │
│                                                             │
│  [Preview YAML]  [Import from YAML]  [Delete Playbook]      │
└─────────────────────────────────────────────────────────────┘
```

### Analytics Dashboard

Track playbook effectiveness:

```
┌─────────────────────────────────────────────────────────────┐
│  UX Audit - Analytics                                       │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  Total Runs: 47        Success Rate: 89%                    │
│  Avg Duration: 12 min  Bugs Found: 23                       │
│                                                             │
│  Runs over time                                             │
│  ▁▂▄▆█▆▄▃▅▇█▆▄▂▃▄▆█▇▅▃▂▄▅▆▇█                              │
│  Jan 1                              Jan 31                  │
│                                                             │
│  Step completion rates                                      │
│  Explore Main States    ████████████████████ 100%          │
│  Test Edge Cases        ████████████████░░░░  85%          │
│  Mobile Viewport Test   ████████████░░░░░░░░  65%  ← Often skipped
│  Document Findings      ██████████████████░░  92%          │
│  Reset State            ████████████████████  98%          │
│                                                             │
│  Common issues found                                        │
│  • Button misalignment (7 occurrences)                     │
│  • Form validation missing (5 occurrences)                 │
│  • Mobile overflow (4 occurrences)                         │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

## Implementation Plan

### Phase 1: Core Infrastructure (Week 1-2)

- [ ] Playbook schema definition and validation
- [ ] Database tables and migrations
- [ ] CRUD API endpoints
- [ ] Basic playbook list UI

### Phase 2: Execution Engine (Week 3-4)

- [ ] System prompt integration
- [ ] Step tracking logic
- [ ] Progress reporting
- [ ] Pause/resume/cancel functionality

### Phase 3: UI Polish (Week 5-6)

- [ ] Start playbook dialog with variables
- [ ] Progress indicator in session view
- [ ] Playbook editor with YAML preview
- [ ] Step details modal

### Phase 4: Analytics & Refinement (Week 7-8)

- [ ] Execution history tracking
- [ ] Analytics dashboard
- [ ] Playbook versioning
- [ ] Public playbook sharing

## Open Questions

1. **Step validation**: How strict should success criteria validation be? Should the agent
   self-report, or should we try to programmatically verify?

2. **Playbook marketplace**: Should there be a public marketplace for playbooks?
   Community-contributed templates?

3. **Branching logic**: Should v2 support conditional branching (if bug found, run extended
   debugging)?

4. **Integration with scheduled runs**: How do playbooks interact with RFC-006 (Scheduled Runs)?

5. **Version compatibility**: If a playbook is updated mid-run, what happens to in-progress
   executions?

## Security Considerations

- Playbook specs can contain sensitive patterns (test credentials, internal URLs) - access control
  required
- Variables may contain secrets - don't log them in plaintext
- Shared playbooks across orgs need careful permission model
