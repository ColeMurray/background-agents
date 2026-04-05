# Skills Support for Open-Inspect

**Date:** 2026-04-05 **Status:** Approved

## Goal

Add first-class skills support to Open-Inspect so that:

1. **Discovery** — users see what skills are available before and during a session
2. **Observability** — the UI shows which skills the agent used and when
3. **Transparency** — a sidebar timeline shows the agent's high-level workflow progression
4. **Control** — skills are managed via config files (read-only in UI for now)

Skills become invocable via a slash command palette in the session input.

## Architecture Overview

```
Container (OpenCode + superpowers plugin)
  └─ discovers skills from:
       .opencode/skills/    (native)
       .claude/skills/      (symlinked in)
       .agents/skills/      (symlinked in)
  └─ Bridge scans SKILL.md files, emits skills_discovered event

Control Plane (Durable Object)
  └─ persists skill catalog on session state
  └─ forwards skills_discovered to WebSocket clients

Web Client
  └─ Slash palette (/ trigger, fuzzy filter, pill insertion)
  └─ Sidebar skills timeline (derived from Skill tool calls)
  └─ Inline skill badges in event stream (transition headers)
```

## 1. Container Configuration

### OpenCode config

Add the superpowers plugin to the OpenCode config written by `entrypoint.py`:

```python
opencode_config = {
    # ...existing model/provider config...
    "plugin": ["superpowers@git+https://github.com/obra/superpowers.git"],
    "permission": {"*": {"*": "allow"}},
}
```

This applies to both the Fuelix proxy and direct Anthropic config paths.

### Skill directory symlinks

Extend `_install_tools()` in `entrypoint.py` to symlink alternative skill directories into
OpenCode's native discovery path:

```python
for alt_dir in [".claude/skills", ".agents/skills"]:
    src = workdir / alt_dir
    if src.exists():
        for skill_dir in src.iterdir():
            if skill_dir.is_dir():
                target = opencode_skills_dir / skill_dir.name
                if not target.exists():
                    target.symlink_to(skill_dir.resolve())
```

This means skills in `.claude/skills/my-skill/SKILL.md` and `.agents/skills/my-skill/SKILL.md` are
discovered by OpenCode alongside its native `.opencode/skills/` directory. Symlinked skills within
those directories are followed naturally.

## 2. Shared Types

New additions to `packages/shared/src/types/index.ts`:

### SkillInfo

```typescript
interface SkillInfo {
  name: string;
  description: string;
  source: "container" | "repo";
  plugin?: string; // e.g. "superpowers" for container skills
  path?: string; // e.g. ".claude/skills/ci-debug" for repo skills
}
```

### New event type

Add `"skills_discovered"` to the `EventType` union:

```typescript
interface SkillsDiscoveredEvent {
  type: "skills_discovered";
  skills: SkillInfo[];
  timestamp: number;
  sandboxId: string;
}
```

### SessionState extension

```typescript
interface SessionState {
  // ...existing fields...
  skills?: SkillInfo[];
}
```

Build `@open-inspect/shared` first — all other packages depend on these types.

## 3. Bridge — Skill Discovery

After OpenCode starts and the bridge connects, the bridge scans for skill metadata from two distinct
sources:

**Repo skills** (scanned from the workspace):

- `.opencode/skills/*/SKILL.md`
- `.claude/skills/*/SKILL.md`
- `.agents/skills/*/SKILL.md`

Tagged as `source: "repo"` with `path` set to the relative directory.

**Plugin skills** (scanned from OpenCode's plugin cache):

- Superpowers installs via OpenCode's plugin system and registers its skills directory via a
  `config` hook. The skills live in OpenCode's plugin cache, not the workspace.
- The bridge scans `~/.local/share/opencode/plugins/` (or the resolved plugin cache path) for
  `*/skills/*/SKILL.md` files.
- Tagged as `source: "container"` with `plugin` set to the plugin name (e.g. `"superpowers"`).

For each `SKILL.md`, parse the YAML frontmatter to extract `name` and `description`.

Emit a single `skills_discovered` event through the existing WebSocket to the control plane. This is
a one-time event per session, sent shortly after startup.

**Why filesystem scanning:** OpenCode doesn't expose a "list skills" API in serve mode. The
filesystem is the source of truth and the bridge already has workspace access. The exact plugin
cache path should be verified against OpenCode's source — if it varies, the entrypoint can set an
environment variable pointing to it.

## 4. Control Plane

### Durable Object session state

When `skills_discovered` arrives from the bridge:

1. Persist the skill catalog on the session DO state (SQLite)
2. Forward the event to all connected WebSocket clients

Late-joining clients receive the skill catalog from `sessionState.skills`.

### Active skill tracking

The control plane does not track which skill is "active" — this is a UI concern. The web client
derives active skill state from the event stream: a `tool_call` with `tool === "Skill"` marks the
start of a skill phase.

### No new API endpoints

The skill catalog reaches the client via:

1. `sessionState.skills` (for the slash palette when joining a session)
2. `skills_discovered` event (real-time, when it arrives during the session)

## 5. Web Client — Slash Palette

### Component: `SkillPalette`

Floating overlay anchored above the session input box.

**Trigger:** Input `onChange` detects text starting with `/`.

**Behavior:**

- Everything after `/` is the filter query
- Fuzzy matching (weighted substring match — no external dependency needed)
- Skills grouped by `source` with section headers ("Container", "Repo")
- Container skills: green accent. Repo skills: purple accent. Using existing theme variables, not
  custom colors.
- Arrow keys navigate, Enter/click selects, Escape dismisses
- First item highlighted by default

**On selection:**

- Replace `/query` with the skill name
- Render as a non-editable pill badge before the editable input text
- Cursor positioned after the pill for the user's message
- Backspace into the pill removes it and re-opens the palette

**Data source:** `sessionState.skills`. If skills haven't arrived yet, show "Loading skills..."
placeholder. If no skills, `/` does nothing special.

**Implementation approach:** Controlled state. Track `selectedSkill` and `inputText` as separate
state. Render the pill as a styled `<span>` before a plain `<input>`. Concatenate on send:
`/${selectedSkill} ${inputText}`.

**Placement:** Child of the session input component. Local component state only (`isOpen`,
`filterQuery`, `selectedIndex`, `selectedSkill`).

## 6. Web Client — Sidebar Skills Timeline

### Component: `SkillsTimelineSection`

Vertical timeline in the right sidebar showing skill progression.

### Utility: `extractSkillTimeline(events)`

New file: `packages/web/src/lib/skills.ts`

Scans `tool_call` events where `tool === "Skill"`:

- Each `Skill` call starts a new skill phase
- Last skill call with no subsequent `Skill` call and no `execution_complete` → `active`
- Any skill call followed by another `Skill` call → `completed`
- After `execution_complete` → all `completed`

Returns:

```typescript
interface SkillPhase {
  name: string;
  status: "active" | "completed";
  startedAt: number;
  description?: string;
}
```

No "pending/upcoming" phases — the timeline only shows what has happened and what's happening now.

### Visual treatment

Uses existing theme classes throughout:

- Active: `text-accent`, `animate-pulse`, `border-accent` left bar, small "ACTIVE" badge
- Completed: `text-secondary-foreground`, checkmark via `CheckCircleIcon`, dimmed
- Vertical connecting line using `border-border-muted`
- Follows the same spacing and typography as `TasksSection`

### Sidebar placement

Between Metadata and Tasks sections in `SessionRightSidebar`:

```tsx
{
  skillTimeline.length > 0 && (
    <CollapsibleSection title="Skills" defaultOpen={true}>
      <SkillsTimelineSection phases={skillTimeline} />
    </CollapsibleSection>
  );
}
```

## 7. Web Client — Inline Skill Badges

### Component: `SkillTransitionHeader`

Renders when the event stream encounters a `tool_call` with `tool === "Skill"`.

```tsx
<div className="flex items-center gap-2 py-2 border-b border-border-muted">
  <span
    className="inline-flex items-center gap-1 bg-accent/10 text-accent
                    px-2 py-0.5 rounded-full text-xs font-semibold"
  >
    {skillName}
  </span>
  <span className="text-xs text-muted-foreground">{description}</span>
</div>
```

Uses existing theme tokens only. No custom hex colors.

### Event stream rendering changes

In the session page's event rendering loop:

- `tool_call` where `tool?.toLowerCase() === "skill"` → render `SkillTransitionHeader`
- Tool calls following a skill header get `ml-1` additional left margin for subtle grouping
- The header is a flat divider, not collapsible

### Tool formatter addition

New `case "skill"` in `tool-formatters.ts`:

```typescript
case "skill": {
  const skillName = getStringArg(args, "skill");
  return {
    toolName: "Skill",
    summary: skillName || "skill",
    icon: "zap",  // new icon, or reuse "box"
    getDetails: () => ({ args, output }),
  };
}
```

## 8. Deferred to Later Iteration

These surfaces are valuable but not required for the core experience:

- **Pre-session discovery badges** — skill badges on the new session screen before container starts
- **Repo settings skills tab** — read-only inventory page per repo
- **Per-repo skill caching in D1** — persisting the latest skill catalog per repo for pre-session
  use
- **UI-based skill control** — toggling skills on/off from the web UI

## Implementation Order

1. Shared types (SkillInfo, event type, SessionState extension)
2. Container config (plugin line, symlink setup in entrypoint.py)
3. Bridge skill scanner (SKILL.md parsing, skills_discovered event)
4. Control plane (persist skills on DO state, forward event)
5. Web: inline skill badges (SkillTransitionHeader, tool-formatters update)
6. Web: sidebar skills timeline (extractSkillTimeline, SkillsTimelineSection)
7. Web: slash palette (SkillPalette, input pill state)

Steps 1-4 are the data pipeline. Steps 5-7 are independent UI features that can be built in parallel
once the pipeline is in place.
