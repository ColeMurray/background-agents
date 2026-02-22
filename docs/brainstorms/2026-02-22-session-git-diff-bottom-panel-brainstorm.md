---
date: 2026-02-22
topic: session-git-diff-bottom-panel
---

# Session Git Diff Bottom Panel

## What We're Building

Add a lightweight, expandable bottom panel on the session page that shows all files changed in the
session's git working tree and renders per-file diffs in a right-hand pane. The interaction model is
GitHub-like: file list on the left, selected file diff on the right, with quick scanning and minimal
UI weight.

V1 is desktop-first on the session page. Mobile behavior is intentionally deferred to a later phase.
The panel should feel fast and accurate: users should trust that what they see matches git state
while keeping the feature unobtrusive during normal session use.

## Why This Approach

We considered three approaches for data flow: event-driven updates, hybrid invalidation + fetch, and
on-demand git snapshot fetch. We chose on-demand snapshot for V1 because it is the simplest path to
accurate git data with lower system complexity.

This aligns with YAGNI: ship the core user value first (reliable changed-file + diff visibility),
then evolve toward more real-time sophistication only if needed. It also matches the desired UX of
loading when the panel opens, with lightweight refresh while open and manual refresh when desired.

## Key Decisions

- **Source of truth:** Use git working tree state, not inferred tool edit events.
- **Change coverage:** Include all working-tree categories (modified, added, deleted, renamed,
  untracked).
- **Refresh behavior:** Fetch when panel opens, auto-refresh periodically while open, and provide a
  manual refresh action.
- **Surface scope:** Session page first, desktop-first; mobile can be phase 2.
- **Diff presentation:** Unified (GitHub-style) by default with optional side-by-side toggle.
- **Success criteria:** Speed and accuracy are equally important for V1.

## Resolved Questions

- **What counts as changed files?** Git working tree truth.
- **How should updates occur?** Open-load + auto-refresh while open + manual refresh.
- **Which change types are included?** All working-tree change categories.
- **Where does it ship first?** Session page desktop-first, mobile later.
- **How should diffs appear?** Unified default with optional split view.
- **What defines success?** Both lightweight UX and git-accurate output.

## Open Questions

- None at the product-definition level for V1. Technical execution details are deferred to planning.

## Next Steps

-> `/workflows:plan` for implementation details, API shape, and rollout/testing strategy.
