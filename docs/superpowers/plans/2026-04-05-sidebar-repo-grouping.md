# Sidebar Repo Grouping Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Group sessions in the left sidebar by `repoOwner/repoName` using collapsible sections,
replacing the current flat active/inactive split.

**Architecture:** Pure frontend change to `session-sidebar.tsx`. The existing `useMemo` grouping
logic is replaced with a repo-keyed grouping pipeline. Two new presentational sub-components
(`RepoGroupHeader`, `RepoGroup`) are added inside the same file. Collapse state is persisted to
`localStorage`.

**Tech Stack:** React (useState, useMemo, useCallback), Next.js, Tailwind CSS, localStorage.

---

## File Map

| File                                              | Change                                                                    |
| ------------------------------------------------- | ------------------------------------------------------------------------- |
| `packages/web/src/components/session-sidebar.tsx` | Replace grouping logic + add `RepoGroupHeader` and `RepoGroup` components |

No other files are created or modified.

---

### Task 1: Replace grouping `useMemo` with repo-keyed groups

**Files:**

- Modify: `packages/web/src/components/session-sidebar.tsx:163-214`

Replace the existing `{ activeSessions, inactiveSessions, childrenMap }` useMemo with one that
produces a list of repo groups.

- [ ] **Step 1: Replace the useMemo block**

In `session-sidebar.tsx`, replace lines 163–214:

```tsx
const { activeSessions, inactiveSessions, childrenMap } = useMemo(() => {
  // ... existing code ...
}, [sessions, searchQuery]);
```

With:

```tsx
const { repoGroups, childrenMap } = useMemo(() => {
  const filtered = sessions
    .filter((session) => session.status !== "archived")
    .filter((session) => {
      if (!searchQuery) return true;
      const query = searchQuery.toLowerCase();
      const title = session.title?.toLowerCase() || "";
      const repo = `${session.repoOwner}/${session.repoName}`.toLowerCase();
      return title.includes(query) || repo.includes(query);
    });

  // Sort all sessions by updatedAt descending
  const sorted = [...filtered].sort((a, b) => {
    const aTime = a.updatedAt || a.createdAt;
    const bTime = b.updatedAt || b.createdAt;
    return bTime - aTime;
  });

  // Build set of visible session IDs for orphan detection
  const visibleIds = new Set(sorted.map((s) => s.id));

  // Group children by parent ID; collect top-level sessions
  const children = new Map<string, SessionItem[]>();
  const topLevel: SessionItem[] = [];

  for (const session of sorted) {
    const parentId = session.parentSessionId;
    if (parentId && visibleIds.has(parentId)) {
      const siblings = children.get(parentId) ?? [];
      siblings.push(session);
      children.set(parentId, siblings);
    } else {
      topLevel.push(session);
    }
  }

  // Group top-level sessions by repo key
  const groupMap = new Map<string, SessionItem[]>();
  for (const session of topLevel) {
    const key = `${session.repoOwner}/${session.repoName}`;
    const group = groupMap.get(key) ?? [];
    group.push(session);
    groupMap.set(key, group);
  }

  // Sort groups by the updatedAt of their most-recent session (already sorted above)
  const groups = Array.from(groupMap.entries()).map(([key, groupSessions]) => ({
    key,
    sessions: groupSessions, // already sorted by updatedAt descending
  }));
  // groups are naturally ordered by insertion order into groupMap, which follows
  // the sorted topLevel array — so the first group always has the most-recent session.

  return { repoGroups: groups, childrenMap: children };
}, [sessions, searchQuery]);
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
npm run typecheck -w @open-inspect/web
```

Expected: no new errors (pre-existing `@open-inspect/shared` errors are fine to ignore).

- [ ] **Step 3: Commit**

```bash
git add packages/web/src/components/session-sidebar.tsx
git commit -m "refactor: replace active/inactive split with repo-keyed grouping"
```

---

### Task 2: Add collapse state with localStorage persistence

**Files:**

- Modify: `packages/web/src/components/session-sidebar.tsx` (inside `SessionSidebar`)

- [ ] **Step 1: Add the collapse state constant and useState**

Add these two items inside `SessionSidebar`, just below the existing `useState` declarations (after
line 68, before the `scrollContainerRef` ref):

```tsx
const COLLAPSED_REPOS_KEY = "open-inspect:sidebar-collapsed-repos";

const [collapsedRepos, setCollapsedRepos] = useState<Record<string, boolean>>(() => {
  try {
    const stored = localStorage.getItem(COLLAPSED_REPOS_KEY);
    return stored ? (JSON.parse(stored) as Record<string, boolean>) : {};
  } catch {
    return {};
  }
});
```

- [ ] **Step 2: Add the toggle callback**

Add this `useCallback` below the `collapsedRepos` state, before the existing `useSWR` call:

```tsx
const toggleRepoCollapsed = useCallback((repoKey: string) => {
  setCollapsedRepos((prev) => {
    const next = { ...prev, [repoKey]: !prev[repoKey] };
    try {
      localStorage.setItem(COLLAPSED_REPOS_KEY, JSON.stringify(next));
    } catch {
      // localStorage unavailable (e.g. SSR or private browsing quota)
    }
    return next;
  });
}, []);
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
npm run typecheck -w @open-inspect/web
```

Expected: no new errors.

- [ ] **Step 4: Commit**

```bash
git add packages/web/src/components/session-sidebar.tsx
git commit -m "feat: add repo collapse state persisted to localStorage"
```

---

### Task 3: Add `RepoGroupHeader` and `RepoGroup` components

**Files:**

- Modify: `packages/web/src/components/session-sidebar.tsx` (add two new functions at the bottom,
  before the final export or after `ChildSessionListItem`)

- [ ] **Step 1: Add a `ChevronIcon` inline or import one**

Check whether the project already exports a chevron icon. Look at
`packages/web/src/components/ui/icons.tsx` (or similar). If a `ChevronRightIcon` or
`ChevronDownIcon` exists, import it. If not, add a minimal inline SVG component at the bottom of
`session-sidebar.tsx`:

```tsx
function ChevronIcon({ collapsed }: { collapsed: boolean }) {
  return (
    <svg
      className={`w-3 h-3 transition-transform duration-150 ${collapsed ? "" : "rotate-90"}`}
      viewBox="0 0 16 16"
      fill="currentColor"
    >
      <path d="M6 3l5 5-5 5V3z" />
    </svg>
  );
}
```

- [ ] **Step 2: Add `RepoGroupHeader` component**

Add after `ChevronIcon` (or after `ChildSessionListItem`):

```tsx
function RepoGroupHeader({
  repoKey,
  count,
  collapsed,
  onToggle,
}: {
  repoKey: string;
  count: number;
  collapsed: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className="w-full flex items-center gap-1.5 px-3 py-1.5 mt-1 text-left text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-muted transition"
    >
      <ChevronIcon collapsed={collapsed} />
      <span className="truncate flex-1">{repoKey}</span>
      <span className="shrink-0 text-xs tabular-nums">{count}</span>
    </button>
  );
}
```

- [ ] **Step 3: Add `RepoGroup` component**

```tsx
function RepoGroup({
  repoKey,
  sessions,
  childrenMap,
  currentSessionId,
  isMobile,
  onSessionSelect,
  collapsed,
  onToggle,
}: {
  repoKey: string;
  sessions: SessionItem[];
  childrenMap: Map<string, SessionItem[]>;
  currentSessionId: string | null;
  isMobile: boolean;
  onSessionSelect?: () => void;
  collapsed: boolean;
  onToggle: () => void;
}) {
  return (
    <div>
      <RepoGroupHeader
        repoKey={repoKey}
        count={sessions.length}
        collapsed={collapsed}
        onToggle={onToggle}
      />
      {!collapsed &&
        sessions.map((session) => (
          <SessionWithChildren
            key={session.id}
            session={session}
            childSessions={childrenMap.get(session.id)}
            currentSessionId={currentSessionId}
            isMobile={isMobile}
            onSessionSelect={onSessionSelect}
          />
        ))}
    </div>
  );
}
```

- [ ] **Step 4: Verify TypeScript compiles**

```bash
npm run typecheck -w @open-inspect/web
```

Expected: no new errors.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/components/session-sidebar.tsx
git commit -m "feat: add RepoGroupHeader and RepoGroup components"
```

---

### Task 4: Wire groups into the `SessionSidebar` render output

**Files:**

- Modify: `packages/web/src/components/session-sidebar.tsx:300-333` (the session list render
  section)

- [ ] **Step 1: Replace the session list render block**

Replace the content of the `<> ... </>` fragment inside the session list `div` (currently lines
300–338, inside the `else` branch after the `loading` and empty-state checks):

Old code:

```tsx
<>
  {/* Active Sessions */}
  {activeSessions.map((session) => (
    <SessionWithChildren
      key={session.id}
      session={session}
      childSessions={childrenMap.get(session.id)}
      currentSessionId={currentSessionId}
      isMobile={isMobile}
      onSessionSelect={onSessionSelect}
    />
  ))}

  {/* Inactive Divider */}
  {inactiveSessions.length > 0 && (
    <>
      <div className="px-4 py-2 mt-2">
        <span className="text-xs font-medium text-secondary-foreground uppercase tracking-wide">
          Inactive
        </span>
      </div>
      {inactiveSessions.map((session) => (
        <SessionWithChildren
          key={session.id}
          session={session}
          childSessions={childrenMap.get(session.id)}
          currentSessionId={currentSessionId}
          isMobile={isMobile}
          onSessionSelect={onSessionSelect}
        />
      ))}
    </>
  )}

  {loadingMore && (
    <div className="flex justify-center py-3">
      <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-muted-foreground" />
    </div>
  )}
</>
```

New code:

```tsx
<>
  {repoGroups.map(({ key, sessions: groupSessions }) => (
    <RepoGroup
      key={key}
      repoKey={key}
      sessions={groupSessions}
      childrenMap={childrenMap}
      currentSessionId={currentSessionId}
      isMobile={isMobile}
      onSessionSelect={onSessionSelect}
      collapsed={!!collapsedRepos[key]}
      onToggle={() => toggleRepoCollapsed(key)}
    />
  ))}

  {loadingMore && (
    <div className="flex justify-center py-3">
      <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-muted-foreground" />
    </div>
  )}
</>
```

- [ ] **Step 2: Update the empty-state check**

The current empty check is `sessions.length === 0`. This still works, but also verify that when all
groups are filtered out by search the empty state shows. The condition `sessions.length === 0`
covers no sessions at all; when search filters produce zero groups, `repoGroups.length === 0` should
show the empty state too. Update the condition:

```tsx
) : sessions.length === 0 || repoGroups.length === 0 ? (
  <div className="px-4 py-8 text-center text-sm text-muted-foreground">
    {sessions.length === 0 ? "No sessions yet" : "No sessions match your search"}
  </div>
) : (
```

- [ ] **Step 3: Remove unused `isInactiveSession` import**

At line 8, remove `isInactiveSession` from the import since it's no longer used:

```tsx
import { formatRelativeTime } from "@/lib/time";
```

- [ ] **Step 4: Verify TypeScript compiles**

```bash
npm run typecheck -w @open-inspect/web
```

Expected: no new errors.

- [ ] **Step 5: Verify the web build succeeds**

```bash
npm run build -w @open-inspect/shared && npm run build -w @open-inspect/web
```

Expected: build completes without errors.

- [ ] **Step 6: Commit**

```bash
git add packages/web/src/components/session-sidebar.tsx
git commit -m "feat: render sidebar sessions grouped by repo with collapsible sections"
```

---

### Task 5: Remove the `repoInfo` line from `SessionListItem`

Since sessions are now grouped under a repo header, the `repoOwner/repoName` label inside each
`SessionListItem` is redundant. Remove it to reduce noise.

**Files:**

- Modify: `packages/web/src/components/session-sidebar.tsx` — `SessionListItem` component (~lines
  626–644)

- [ ] **Step 1: Remove repo info from the session link row**

In `SessionListItem`, within the `<Link>` block, the metadata row currently shows:

```tsx
<div className="flex items-center gap-1 mt-0.5 text-xs text-muted-foreground">
  <span>{relativeTime}</span>
  <span>·</span>
  <span className="truncate">{repoInfo}</span>
  {isOrphanChild && (
    <>
      <span>·</span>
      <span className="text-accent">sub-task</span>
    </>
  )}
  {session.baseBranch && session.baseBranch !== "main" && (
    <>
      <span>·</span>
      <BranchIcon className="w-3 h-3 flex-shrink-0" />
      <span className="truncate">{session.baseBranch}</span>
    </>
  )}
</div>
```

Replace with (remove the `repoInfo` span and its separator, keep the rest):

```tsx
<div className="flex items-center gap-1 mt-0.5 text-xs text-muted-foreground">
  <span>{relativeTime}</span>
  {isOrphanChild && (
    <>
      <span>·</span>
      <span className="text-accent">sub-task</span>
    </>
  )}
  {session.baseBranch && session.baseBranch !== "main" && (
    <>
      <span>·</span>
      <BranchIcon className="w-3 h-3 flex-shrink-0" />
      <span className="truncate">{session.baseBranch}</span>
    </>
  )}
</div>
```

Also do the same in the `isRenaming` branch of `SessionListItem` (the metadata shown while
renaming). Replace:

```tsx
<div className="flex items-center gap-1 mt-0.5 text-xs text-muted-foreground">
  <span>{relativeTime}</span>
  <span>·</span>
  <span className="truncate">{repoInfo}</span>
</div>
```

With:

```tsx
<div className="flex items-center gap-1 mt-0.5 text-xs text-muted-foreground">
  <span>{relativeTime}</span>
</div>
```

- [ ] **Step 2: Remove the now-unused `repoInfo` and `displayTitle` fallback**

`repoInfo` was declared as
`const repoInfo = \`${session.repoOwner}/${session.repoName}\`;`. Remove that line. `displayTitle`still uses`repoOwner/repoName`as a fallback when`session.title`
is null — keep that unchanged.

- [ ] **Step 3: Verify TypeScript compiles and build succeeds**

```bash
npm run typecheck -w @open-inspect/web
```

Expected: no new errors.

- [ ] **Step 4: Commit**

```bash
git add packages/web/src/components/session-sidebar.tsx
git commit -m "refactor: remove redundant repo label from session list items"
```
