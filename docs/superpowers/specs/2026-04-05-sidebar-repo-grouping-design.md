# Sidebar Repo Grouping — Design Spec

**Date:** 2026-04-05  
**Status:** Approved

## Summary

Group sessions in the left sidebar by `repoOwner/repoName` using collapsible sections. Pure frontend
change — no backend or data model modifications required. All necessary data (`repoOwner`,
`repoName`) is already present on every session object returned by the existing API.

## Scope

One file changed: `packages/web/src/components/session-sidebar.tsx`.

No changes to: API routes, control-plane, D1 schema, shared types, or any other component.

## Data Grouping & Sorting

The existing `useMemo` that produces a flat sorted list is replaced with a grouping pipeline:

1. Separate top-level sessions (no `parentSessionId`) from child sessions. Child sessions are not
   grouped independently — they remain nested under their parent as today.
2. Group top-level sessions by `${repoOwner}/${repoName}`.
3. Within each group, sort sessions by `updatedAt` descending (most recent first).
4. Sort groups by the `updatedAt` of their most-recent session, descending (most recently active
   repo floats to top).
5. The existing active/inactive time-threshold split is removed — it does not compose cleanly with
   per-repo collapsing and adds visual noise.

Sessions that are actively running remain visually distinguishable via existing status indicators on
`SessionListItem`.

Search/filter still applies across all groups. Groups with zero matching sessions are hidden
entirely.

## Collapse State

- State shape: `Record<string, boolean>` keyed by `"${repoOwner}/${repoName}"`.
- Persisted in `localStorage` under key `open-inspect:sidebar-collapsed-repos`.
- Default for any repo group not present in storage: **expanded**.
- Initialized via `useState` with a lazy initializer that reads from `localStorage` on mount.
- On toggle: update React state and write to `localStorage` synchronously.
- No server round-trip, no new React context, no new hook file.

## UI / Rendering

### Repo Group Section

Each repo group renders as:

```
▼ owner/repo-name  [3]        ← header row (clickable, full width)
  ┌─ SessionListItem           ← existing component, unchanged
  ├─ SessionListItem
  │    └─ ChildSessionListItem ← existing component, unchanged
  └─ SessionListItem
```

**Header row elements:**

- Chevron icon: points down when expanded, right when collapsed (CSS rotation transition).
- Label: `repoOwner/repoName` in the existing muted/small repo label style.
- Badge: count of top-level sessions in the group (not counting children).
- Entire header row is the click target for toggle.

**Collapsed state:** body (`SessionListItem` list) is hidden; header remains visible.

### New Components / Logic

- `RepoGroupHeader` — small presentational component for the header row (chevron + label + badge).
- `RepoGroup` — renders `RepoGroupHeader` + collapsible body containing `SessionWithChildren` items.
- The top-level render loop in `SessionSidebar` iterates over sorted groups and renders a
  `RepoGroup` per repo.

Existing `SessionListItem`, `ChildSessionListItem`, and `SessionWithChildren` are **unchanged**.

## Testing

No new unit tests required for this change — the grouping/sorting logic is pure and can be verified
visually. If the project adds sidebar snapshot or integration tests in the future, the grouping
output should be covered there.

## Out of Scope

- Persisting collapse state to the server (D1).
- A first-class "Project" entity spanning multiple repos.
- Any backend API changes.
