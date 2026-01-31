# Open-Inspect RFCs

Request for Comments (RFCs) for major feature additions to Open-Inspect. Each RFC describes the
problem, proposed solution, technical design, and implementation plan.

## RFC Index

| RFC                                       | Title                               | Status | Description                                                         |
| ----------------------------------------- | ----------------------------------- | ------ | ------------------------------------------------------------------- |
| [001](./001-session-replay.md)            | Session Replay & Time Travel        | Draft  | Timeline navigation, forking, side-by-side comparison, video export |
| [002](./002-playbooks.md)                 | Smart Session Templates (Playbooks) | Draft  | Reusable session templates for repeatable testing patterns          |
| [003](./003-cross-session-memory.md)      | Cross-Session Memory & Context      | Draft  | Organizational memory, semantic search, knowledge extraction        |
| [004](./004-figma-integration.md)         | Figma Integration                   | Draft  | Visual regression testing against design source of truth            |
| [005](./005-github-issues-integration.md) | GitHub Issues Integration           | Draft  | Create sessions from issues, auto-commenting, bidirectional linking |
| [006](./006-scheduled-runs.md)            | Scheduled & Triggered Runs          | Draft  | Cron-scheduled and event-triggered automated sessions               |
| [007](./007-annotation-layer.md)          | Annotation Layer                    | Draft  | Drawing and commenting on screenshots                               |
| [008](./008-voice-interface.md)           | Voice Interface                     | Draft  | Voice commands and voice notes                                      |
| [009](./009-teams-integration.md)         | Microsoft Teams Integration         | Draft  | Tabs, Adaptive Cards, meeting integration, approval workflows       |
| [010](./010-analytics-dashboard.md)       | Analytics & Insights Dashboard      | Draft  | Coverage metrics, bug analytics, team activity tracking             |

## Also Planned

- **[Linear Integration](../LINEAR_INTEGRATION_PLAN.md)** - Already in planning, session and task
  linking to Linear issues

## RFC Lifecycle

1. **Draft**: Initial proposal, open for feedback
2. **Review**: Active discussion, design refinements
3. **Approved**: Ready for implementation
4. **Implemented**: Feature shipped
5. **Superseded**: Replaced by another RFC

## Implementation Priority

Based on impact and dependencies, here's a suggested implementation order:

### Phase 1: Foundation (High Impact, Lower Complexity)

1. **[RFC-005](./005-github-issues-integration.md)** - GitHub Issues Integration
2. **[RFC-007](./007-annotation-layer.md)** - Annotation Layer
3. **[RFC-002](./002-playbooks.md)** - Playbooks (depends on RFC-007 for annotated screenshots)

### Phase 2: Automation (The 10x Multiplier)

4. **[RFC-006](./006-scheduled-runs.md)** - Scheduled Runs (depends on RFC-002)
5. **[RFC-004](./004-figma-integration.md)** - Figma Integration (enables design regression in
   RFC-006)
6. **[RFC-001](./001-session-replay.md)** - Session Replay

### Phase 3: Intelligence

7. **[RFC-003](./003-cross-session-memory.md)** - Cross-Session Memory
8. **[RFC-010](./010-analytics-dashboard.md)** - Analytics Dashboard

### Phase 4: Platform Expansion

9. **[RFC-009](./009-teams-integration.md)** - Teams Integration
10. **[RFC-008](./008-voice-interface.md)** - Voice Interface

## Contributing

To propose a new feature:

1. Create a new RFC file: `docs/rfcs/NNN-feature-name.md`
2. Use the template structure from existing RFCs
3. Include: Summary, Problem Statement, Goals, Non-Goals, Technical Design, Implementation Plan
4. Submit a PR for discussion

## Related Documents

- [Feature Ideas](../FEATURE_IDEAS.md) - High-level feature concepts
- [Getting Started](../GETTING_STARTED.md) - Deployment guide
- [CLAUDE.md](../../CLAUDE.md) - Development notes
