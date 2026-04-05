# Skills Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add first-class skills support — container discovery, control plane forwarding, slash
palette, sidebar timeline, and inline skill badges.

**Architecture:** Container discovers skills from plugin cache + repo directories, bridge emits
`skills_discovered` event through existing WebSocket pipeline, control plane persists and forwards
to web client, web renders via three new UI surfaces.

**Tech Stack:** Python (bridge scanner), TypeScript (shared types, control plane DO, Next.js/React
components), Vitest (tests)

**Branch:** `feat/skills-support` (create from `main`)

**Spec:** `docs/superpowers/specs/2026-04-05-skills-support-design.md`

---

### Task 1: Create Feature Branch

**Files:** None (git only)

- [ ] **Step 1: Create and switch to feature branch**

```bash
git checkout -b feat/skills-support main
```

- [ ] **Step 2: Verify branch**

```bash
git branch --show-current
```

Expected: `feat/skills-support`

---

### Task 2: Shared Types — SkillInfo and SkillsDiscoveredEvent

**Files:**

- Modify: `packages/shared/src/types/index.ts:29-42` (EventType union)
- Modify: `packages/shared/src/types/index.ts:141-240` (SandboxEvent union)
- Modify: `packages/shared/src/types/index.ts:309-326` (SessionState)

- [ ] **Step 1: Add SkillInfo interface**

In `packages/shared/src/types/index.ts`, add after the `SessionState` interface (after line 326):

```typescript
// Skill metadata discovered from container plugins and repo directories
export interface SkillInfo {
  name: string;
  description: string;
  source: "container" | "repo";
  plugin?: string;
  path?: string;
}
```

- [ ] **Step 2: Add `skills_discovered` to EventType union**

In `packages/shared/src/types/index.ts`, add to the `EventType` union (after `"user_message"` on
line 42):

```typescript
  | "skills_discovered";
```

- [ ] **Step 3: Add SkillsDiscoveredEvent to SandboxEvent union**

In `packages/shared/src/types/index.ts`, add a new variant to the `SandboxEvent` union (after the
`user_message` variant, around line 240):

```typescript
  | {
      type: "skills_discovered";
      skills: SkillInfo[];
      sandboxId: string;
      timestamp: number;
    };
```

- [ ] **Step 4: Add skills to SessionState**

In `packages/shared/src/types/index.ts`, add to the `SessionState` interface (after
`codeServerPassword` on line 325):

```typescript
  skills?: SkillInfo[];
```

- [ ] **Step 5: Build shared package**

```bash
npm run build -w @open-inspect/shared
```

Expected: Clean build, no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/types/index.ts
git commit -m "feat: add SkillInfo type and skills_discovered event to shared types"
```

---

### Task 3: Bridge — Skill Scanner Utility

**Files:**

- Create: `packages/sandbox-runtime/src/sandbox_runtime/skill_scanner.py`
- Test: `packages/sandbox-runtime/tests/test_skill_scanner.py`

- [ ] **Step 1: Write the test file**

Create `packages/sandbox-runtime/tests/test_skill_scanner.py`:

```python
"""Tests for the skill scanner that reads SKILL.md frontmatter."""

import textwrap
from pathlib import Path

import pytest

from sandbox_runtime.skill_scanner import scan_skills, parse_skill_frontmatter


class TestParseSkillFrontmatter:
    def test_parses_name_and_description(self, tmp_path: Path):
        skill_md = tmp_path / "SKILL.md"
        skill_md.write_text(textwrap.dedent("""\
            ---
            name: brainstorming
            description: Collaborative design and spec creation
            ---

            # Brainstorming

            Some content here.
        """))
        result = parse_skill_frontmatter(skill_md)
        assert result is not None
        assert result["name"] == "brainstorming"
        assert result["description"] == "Collaborative design and spec creation"

    def test_returns_none_for_missing_file(self, tmp_path: Path):
        result = parse_skill_frontmatter(tmp_path / "nonexistent" / "SKILL.md")
        assert result is None

    def test_returns_none_for_no_frontmatter(self, tmp_path: Path):
        skill_md = tmp_path / "SKILL.md"
        skill_md.write_text("# Just a heading\n\nNo frontmatter here.")
        result = parse_skill_frontmatter(skill_md)
        assert result is None

    def test_returns_none_for_missing_name(self, tmp_path: Path):
        skill_md = tmp_path / "SKILL.md"
        skill_md.write_text(textwrap.dedent("""\
            ---
            description: Missing the name field
            ---
        """))
        result = parse_skill_frontmatter(skill_md)
        assert result is None

    def test_handles_multiline_description(self, tmp_path: Path):
        skill_md = tmp_path / "SKILL.md"
        skill_md.write_text(textwrap.dedent("""\
            ---
            name: tdd
            description: Test-driven development workflow
            ---
        """))
        result = parse_skill_frontmatter(skill_md)
        assert result is not None
        assert result["name"] == "tdd"


class TestScanSkills:
    def _make_skill(self, base: Path, name: str, desc: str) -> Path:
        skill_dir = base / name
        skill_dir.mkdir(parents=True, exist_ok=True)
        (skill_dir / "SKILL.md").write_text(
            f"---\nname: {name}\ndescription: {desc}\n---\n"
        )
        return skill_dir

    def test_scans_repo_skills(self, tmp_path: Path):
        workspace = tmp_path / "workspace"
        workspace.mkdir()
        self._make_skill(workspace / ".opencode" / "skills", "my-skill", "A repo skill")

        results = scan_skills(workspace=workspace, plugin_cache_dir=None)
        assert len(results) == 1
        assert results[0]["name"] == "my-skill"
        assert results[0]["source"] == "repo"
        assert results[0]["path"] == ".opencode/skills/my-skill"

    def test_scans_claude_skills_dir(self, tmp_path: Path):
        workspace = tmp_path / "workspace"
        workspace.mkdir()
        self._make_skill(workspace / ".claude" / "skills", "ci-debug", "Debug CI")

        results = scan_skills(workspace=workspace, plugin_cache_dir=None)
        assert len(results) == 1
        assert results[0]["name"] == "ci-debug"
        assert results[0]["source"] == "repo"
        assert results[0]["path"] == ".claude/skills/ci-debug"

    def test_scans_agents_skills_dir(self, tmp_path: Path):
        workspace = tmp_path / "workspace"
        workspace.mkdir()
        self._make_skill(workspace / ".agents" / "skills", "lint", "Auto lint")

        results = scan_skills(workspace=workspace, plugin_cache_dir=None)
        assert len(results) == 1
        assert results[0]["name"] == "lint"
        assert results[0]["source"] == "repo"
        assert results[0]["path"] == ".agents/skills/lint"

    def test_scans_plugin_cache(self, tmp_path: Path):
        workspace = tmp_path / "workspace"
        workspace.mkdir()
        plugin_dir = tmp_path / "plugins" / "superpowers"
        self._make_skill(plugin_dir / "skills", "brainstorming", "Design sessions")

        results = scan_skills(
            workspace=workspace,
            plugin_cache_dir=tmp_path / "plugins",
        )
        assert len(results) == 1
        assert results[0]["name"] == "brainstorming"
        assert results[0]["source"] == "container"
        assert results[0]["plugin"] == "superpowers"

    def test_deduplicates_by_name_repo_wins(self, tmp_path: Path):
        workspace = tmp_path / "workspace"
        workspace.mkdir()
        # Same skill in both plugin cache and repo
        plugin_dir = tmp_path / "plugins" / "superpowers"
        self._make_skill(plugin_dir / "skills", "brainstorming", "Plugin version")
        self._make_skill(workspace / ".opencode" / "skills", "brainstorming", "Repo override")

        results = scan_skills(
            workspace=workspace,
            plugin_cache_dir=tmp_path / "plugins",
        )
        assert len(results) == 1
        assert results[0]["source"] == "repo"
        assert results[0]["description"] == "Repo override"

    def test_follows_symlinks(self, tmp_path: Path):
        workspace = tmp_path / "workspace"
        workspace.mkdir()
        # Create a real skill dir, then symlink it
        real_dir = tmp_path / "external" / "my-skill"
        real_dir.mkdir(parents=True)
        (real_dir / "SKILL.md").write_text(
            "---\nname: my-skill\ndescription: Symlinked skill\n---\n"
        )
        skills_dir = workspace / ".claude" / "skills"
        skills_dir.mkdir(parents=True)
        (skills_dir / "my-skill").symlink_to(real_dir)

        results = scan_skills(workspace=workspace, plugin_cache_dir=None)
        assert len(results) == 1
        assert results[0]["name"] == "my-skill"
        assert results[0]["description"] == "Symlinked skill"

    def test_empty_dirs_return_empty_list(self, tmp_path: Path):
        workspace = tmp_path / "workspace"
        workspace.mkdir()
        results = scan_skills(workspace=workspace, plugin_cache_dir=None)
        assert results == []
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd packages/sandbox-runtime && python -m pytest tests/test_skill_scanner.py -v
```

Expected: ModuleNotFoundError — `sandbox_runtime.skill_scanner` does not exist yet.

- [ ] **Step 3: Write the skill scanner implementation**

Create `packages/sandbox-runtime/src/sandbox_runtime/skill_scanner.py`:

```python
"""Scan for SKILL.md files and extract skill metadata.

Discovers skills from two sources:
1. Repo directories: .opencode/skills/, .claude/skills/, .agents/skills/
2. Plugin cache: OpenCode's plugin installation directory

Returns a list of skill info dicts ready to send as a skills_discovered event.
No external YAML library needed — frontmatter is simple key: value pairs.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

from .log_config import get_logger

log = get_logger()

# Directories to scan for repo-level skills, relative to workspace root.
REPO_SKILL_DIRS = [
    ".opencode/skills",
    ".claude/skills",
    ".agents/skills",
]

_FRONTMATTER_RE = re.compile(r"^---\s*\n(.*?)\n---", re.DOTALL)
_KV_RE = re.compile(r"^(\w[\w-]*)\s*:\s*(.+)$", re.MULTILINE)


def parse_skill_frontmatter(skill_md: Path) -> dict[str, str] | None:
    """Parse YAML frontmatter from a SKILL.md file.

    Returns dict with at least 'name' and 'description', or None if
    the file is missing, has no frontmatter, or lacks required fields.
    Uses regex instead of a YAML library since frontmatter is simple flat key-value.
    """
    try:
        text = skill_md.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return None

    match = _FRONTMATTER_RE.match(text)
    if not match:
        return None

    fields: dict[str, str] = {}
    for kv in _KV_RE.finditer(match.group(1)):
        fields[kv.group(1)] = kv.group(2).strip()

    if "name" not in fields or "description" not in fields:
        return None

    return fields


def _scan_directory(
    base_dir: Path,
    source: str,
    *,
    plugin_name: str | None = None,
    relative_prefix: str | None = None,
) -> list[dict[str, Any]]:
    """Scan a directory for skill subdirectories containing SKILL.md."""
    skills: list[dict[str, Any]] = []
    if not base_dir.exists() or not base_dir.is_dir():
        return skills

    for entry in sorted(base_dir.iterdir()):
        if not entry.is_dir():
            continue
        skill_md = entry / "SKILL.md"
        parsed = parse_skill_frontmatter(skill_md)
        if not parsed:
            continue

        info: dict[str, Any] = {
            "name": parsed["name"],
            "description": parsed["description"],
            "source": source,
        }
        if plugin_name:
            info["plugin"] = plugin_name
        if relative_prefix:
            info["path"] = f"{relative_prefix}/{entry.name}"

        skills.append(info)

    return skills


def scan_skills(
    *,
    workspace: Path,
    plugin_cache_dir: Path | None,
) -> list[dict[str, Any]]:
    """Discover all available skills from repo dirs and plugin cache.

    Args:
        workspace: The repo working directory (e.g. /workspace/my-repo).
        plugin_cache_dir: OpenCode's plugin cache directory, or None to skip.

    Returns:
        List of skill info dicts. Repo skills override plugin skills with
        the same name (repo takes precedence in the cascade).
    """
    # Start with plugin (container) skills — repo skills override these.
    container_skills: list[dict[str, Any]] = []
    if plugin_cache_dir and plugin_cache_dir.exists():
        for plugin_dir in sorted(plugin_cache_dir.iterdir()):
            if not plugin_dir.is_dir():
                continue
            skills_dir = plugin_dir / "skills"
            container_skills.extend(
                _scan_directory(
                    skills_dir,
                    source="container",
                    plugin_name=plugin_dir.name,
                )
            )

    # Scan repo skill directories.
    repo_skills: list[dict[str, Any]] = []
    for rel_dir in REPO_SKILL_DIRS:
        abs_dir = workspace / rel_dir
        repo_skills.extend(
            _scan_directory(
                abs_dir,
                source="repo",
                relative_prefix=rel_dir,
            )
        )

    # Merge: repo skills override container skills by name.
    seen_names: set[str] = set()
    merged: list[dict[str, Any]] = []

    # Repo first (higher priority).
    for skill in repo_skills:
        if skill["name"] not in seen_names:
            seen_names.add(skill["name"])
            merged.append(skill)

    # Then container skills that weren't overridden.
    for skill in container_skills:
        if skill["name"] not in seen_names:
            seen_names.add(skill["name"])
            merged.append(skill)

    log.info("skills.scan_complete", total=len(merged), repo=len(repo_skills), container=len(container_skills))
    return merged
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd packages/sandbox-runtime && python -m pytest tests/test_skill_scanner.py -v
```

Expected: All 9 tests pass.

- [ ] **Step 5: Lint**

```bash
cd packages/sandbox-runtime && ruff check --fix && ruff format
```

- [ ] **Step 6: Commit**

```bash
git add packages/sandbox-runtime/src/sandbox_runtime/skill_scanner.py packages/sandbox-runtime/tests/test_skill_scanner.py
git commit -m "feat: add skill scanner for SKILL.md frontmatter discovery"
```

---

### Task 4: Bridge — Emit `skills_discovered` Event

**Files:**

- Modify: `packages/sandbox-runtime/src/sandbox_runtime/bridge.py:380-391` (\_connect_and_run, after
  ready event)

- [ ] **Step 1: Add skill_scanner import to bridge.py**

In `packages/sandbox-runtime/src/sandbox_runtime/bridge.py`, add to imports (around line 12, after
the existing relative imports):

```python
from .skill_scanner import scan_skills
```

- [ ] **Step 2: Add `_emit_skills_discovered` method to `AgentBridge`**

Add this method to the `AgentBridge` class (after `_connect_and_run`, around line 437):

```python
    async def _emit_skills_discovered(self) -> None:
        """Scan for skills and emit a skills_discovered event."""
        try:
            # Determine the workspace (repo) directory.
            workspace = Path("/workspace")
            repo_name = os.environ.get("REPO_NAME", "")
            if repo_name:
                repo_dir = workspace / repo_name
                if repo_dir.exists() and (repo_dir / ".git").exists():
                    workspace = repo_dir

            # OpenCode plugin cache — check common locations.
            plugin_cache_dir: Path | None = None
            for candidate in [
                Path.home() / ".local" / "share" / "opencode" / "plugins",
                Path.home() / ".config" / "opencode" / "plugins",
            ]:
                if candidate.exists():
                    plugin_cache_dir = candidate
                    break

            skills = scan_skills(
                workspace=workspace,
                plugin_cache_dir=plugin_cache_dir,
            )

            if skills:
                await self._send_event({
                    "type": "skills_discovered",
                    "skills": skills,
                })
                self.log.info("skills.emitted", count=len(skills))
            else:
                self.log.info("skills.none_found")
        except Exception as e:
            self.log.warn("skills.scan_error", exc=str(e))
```

- [ ] **Step 3: Call `_emit_skills_discovered` after buffer flush in `_connect_and_run`**

In `_connect_and_run`, after `await self._flush_event_buffer()` (around line 390), add:

```python
        # Emit skill catalog after connection is established.
        await self._emit_skills_discovered()
```

- [ ] **Step 4: Run existing bridge tests to verify no regressions**

```bash
cd packages/sandbox-runtime && python -m pytest tests/ -v
```

Expected: All existing tests still pass.

- [ ] **Step 5: Commit**

```bash
git add packages/sandbox-runtime/src/sandbox_runtime/bridge.py
git commit -m "feat: emit skills_discovered event from bridge on connect"
```

---

### Task 5: Container Config — Add Superpowers Plugin and Symlinks

**Files:**

- Modify: `packages/sandbox-runtime/src/sandbox_runtime/entrypoint.py:272-310` (\_install_tools)
- Modify: `packages/sandbox-runtime/src/sandbox_runtime/entrypoint.py:413-439` (opencode config)

- [ ] **Step 1: Add superpowers plugin to both config paths**

In `packages/sandbox-runtime/src/sandbox_runtime/entrypoint.py`, in the Fuelix proxy config block
(around line 414), add `"plugin"` to the `opencode_config` dict:

```python
            opencode_config = {
                "$schema": "https://opencode.ai/config.json",
                "plugin": ["superpowers@git+https://github.com/obra/superpowers.git"],
                "provider": {
```

And in the direct Anthropic config block (around line 436):

```python
            opencode_config = {
                "plugin": ["superpowers@git+https://github.com/obra/superpowers.git"],
                "model": f"anthropic/{model}",
                "permission": {"*": {"*": "allow"}},
            }
```

- [ ] **Step 2: Add skill directory symlink logic to `_install_tools`**

In `_install_tools`, after the package.json write (after line 309), add:

```python
        # Symlink .claude/skills/ and .agents/skills/ into .opencode/skills/
        # so OpenCode discovers them alongside its native skill directory.
        opencode_skills = opencode_dir / "skills"
        for alt_dir in [".claude/skills", ".agents/skills"]:
            src = workdir / alt_dir
            if not src.exists() or not src.is_dir():
                continue
            opencode_skills.mkdir(parents=True, exist_ok=True)
            for skill_dir in src.iterdir():
                if not skill_dir.is_dir():
                    continue
                target = opencode_skills / skill_dir.name
                if not target.exists():
                    try:
                        target.symlink_to(skill_dir.resolve())
                        self.log.info(
                            "opencode.skill_symlink",
                            source=str(skill_dir),
                            target=str(target),
                        )
                    except Exception as e:
                        self.log.warn("opencode.skill_symlink_error", exc=e)
```

- [ ] **Step 3: Lint**

```bash
cd packages/sandbox-runtime && ruff check --fix && ruff format
```

- [ ] **Step 4: Commit**

```bash
git add packages/sandbox-runtime/src/sandbox_runtime/entrypoint.py
git commit -m "feat: add superpowers plugin config and skill directory symlinks"
```

---

### Task 6: Control Plane — Handle `skills_discovered` Event

**Files:**

- Modify: `packages/control-plane/src/session/sandbox-events.ts:41-196` (processSandboxEvent)
- Modify: `packages/control-plane/src/session/durable-object.ts:1447-1485` (getSessionState)

- [ ] **Step 1: Add skills storage to the session DO**

In `packages/control-plane/src/session/durable-object.ts`, add a class property to store skills.
Find the class properties section (near other state like `presenceService`, etc.) and add:

```typescript
  /** Skill catalog from the most recent skills_discovered event. */
  private skills: import("@open-inspect/shared").SkillInfo[] = [];
```

- [ ] **Step 2: Handle skills_discovered in the event processor**

In `packages/control-plane/src/session/sandbox-events.ts`, add handling for the new event type.
After the `git_sync` block (around line 185) and before the final `this.deps.broadcast` call on line
191, add a dedicated handler. However, since `skills_discovered` is not a critical event and should
be stored and broadcast, the simplest approach is to let it fall through to the existing catch-all
block (lines 171-191) which already persists and broadcasts all unmatched event types.

The only extra work needed is passing the skills to the DO for `getSessionState`. Add a new callback
to `SessionSandboxEventProcessorDeps`:

In `packages/control-plane/src/session/sandbox-events.ts`, add to the
`SessionSandboxEventProcessorDeps` interface (around line 12):

```typescript
  updateSkills: (skills: import("@open-inspect/shared").SkillInfo[]) => void;
```

Then add handling before the catch-all block (before line 171):

```typescript
if (event.type === "skills_discovered") {
  this.deps.updateSkills(event.skills);
  this.deps.broadcast({ type: "sandbox_event", event });
  return;
}
```

- [ ] **Step 3: Wire up updateSkills in the Durable Object**

In `packages/control-plane/src/session/durable-object.ts`, where `SessionSandboxEventProcessor` is
constructed (find the constructor call and add the callback):

```typescript
updateSkills: (skills) => {
  this.skills = skills;
},
```

- [ ] **Step 4: Add skills to getSessionState**

In `packages/control-plane/src/session/durable-object.ts`, in the `getSessionState` method (around
line 1483), add `skills` to the returned object:

```typescript
      codeServerPassword,
      skills: this.skills.length > 0 ? this.skills : undefined,
    };
```

- [ ] **Step 5: Build control plane**

```bash
npm run build -w @open-inspect/control-plane
```

Expected: Clean build.

- [ ] **Step 6: Run control plane unit tests**

```bash
npm test -w @open-inspect/control-plane
```

Expected: All tests pass.

- [ ] **Step 7: Commit**

```bash
git add packages/control-plane/src/session/sandbox-events.ts packages/control-plane/src/session/durable-object.ts
git commit -m "feat: handle skills_discovered event in control plane DO"
```

---

### Task 7: Web — Skill Extraction Utility and Tests

**Files:**

- Create: `packages/web/src/lib/skills.ts`
- Create: `packages/web/src/lib/skills.test.ts`

- [ ] **Step 1: Write the test file**

Create `packages/web/src/lib/skills.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { extractSkillTimeline } from "./skills";
import type { SandboxEvent } from "@/types/session";

type ToolCallEvent = Extract<SandboxEvent, { type: "tool_call" }>;

function makeSkillCall(overrides: Partial<ToolCallEvent> = {}): ToolCallEvent {
  return {
    type: "tool_call",
    tool: "Skill",
    args: { skill: "brainstorming" },
    callId: "call-1",
    messageId: "msg-1",
    sandboxId: "sandbox-1",
    timestamp: 1000,
    ...overrides,
  };
}

function makeExecComplete(timestamp: number): SandboxEvent {
  return {
    type: "execution_complete",
    messageId: "msg-1",
    success: true,
    sandboxId: "sandbox-1",
    timestamp,
  };
}

describe("extractSkillTimeline", () => {
  it("returns empty array for no events", () => {
    expect(extractSkillTimeline([])).toEqual([]);
  });

  it("returns empty array when no Skill tool calls", () => {
    const events: SandboxEvent[] = [
      {
        type: "tool_call",
        tool: "Read",
        args: { filePath: "foo.ts" },
        callId: "c1",
        messageId: "msg-1",
        sandboxId: "sb-1",
        timestamp: 1000,
      },
    ];
    expect(extractSkillTimeline(events)).toEqual([]);
  });

  it("marks single skill as active when no execution_complete", () => {
    const events: SandboxEvent[] = [
      makeSkillCall({ timestamp: 1000, args: { skill: "brainstorming" } }),
    ];
    const result = extractSkillTimeline(events);
    expect(result).toEqual([{ name: "brainstorming", status: "active", startedAt: 1000 }]);
  });

  it("marks all skills completed after execution_complete", () => {
    const events: SandboxEvent[] = [
      makeSkillCall({ timestamp: 1000, callId: "c1", args: { skill: "brainstorming" } }),
      makeSkillCall({ timestamp: 2000, callId: "c2", args: { skill: "writing-plans" } }),
      makeExecComplete(3000),
    ];
    const result = extractSkillTimeline(events);
    expect(result).toEqual([
      { name: "brainstorming", status: "completed", startedAt: 1000 },
      { name: "writing-plans", status: "completed", startedAt: 2000 },
    ]);
  });

  it("marks earlier skills completed, last skill active", () => {
    const events: SandboxEvent[] = [
      makeSkillCall({ timestamp: 1000, callId: "c1", args: { skill: "brainstorming" } }),
      makeSkillCall({ timestamp: 2000, callId: "c2", args: { skill: "writing-plans" } }),
      makeSkillCall({ timestamp: 3000, callId: "c3", args: { skill: "executing-plans" } }),
    ];
    const result = extractSkillTimeline(events);
    expect(result).toEqual([
      { name: "brainstorming", status: "completed", startedAt: 1000 },
      { name: "writing-plans", status: "completed", startedAt: 2000 },
      { name: "executing-plans", status: "active", startedAt: 3000 },
    ]);
  });

  it("extracts description from args if present", () => {
    const events: SandboxEvent[] = [
      makeSkillCall({
        timestamp: 1000,
        args: { skill: "brainstorming", args: "design the auth system" },
      }),
    ];
    const result = extractSkillTimeline(events);
    expect(result).toEqual([
      {
        name: "brainstorming",
        status: "active",
        startedAt: 1000,
        description: "design the auth system",
      },
    ]);
  });

  it("ignores non-tool_call events interspersed", () => {
    const events: SandboxEvent[] = [
      makeSkillCall({ timestamp: 1000, callId: "c1", args: { skill: "tdd" } }),
      {
        type: "token",
        content: "some text",
        messageId: "msg-1",
        sandboxId: "sb-1",
        timestamp: 1500,
      },
      {
        type: "tool_call",
        tool: "Read",
        args: { filePath: "foo.ts" },
        callId: "c2",
        messageId: "msg-1",
        sandboxId: "sb-1",
        timestamp: 1600,
      },
    ];
    const result = extractSkillTimeline(events);
    expect(result).toEqual([{ name: "tdd", status: "active", startedAt: 1000 }]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npm test -w @open-inspect/web -- --run src/lib/skills.test.ts
```

Expected: FAIL — module `./skills` not found.

- [ ] **Step 3: Write the implementation**

Create `packages/web/src/lib/skills.ts`:

```typescript
/**
 * Skill timeline extraction from sandbox events.
 *
 * Scans tool_call events for Skill invocations and builds a timeline
 * of skill phases: which skills were used and their status.
 */

import type { SandboxEvent } from "@/types/session";

type ToolCallEvent = Extract<SandboxEvent, { type: "tool_call" }>;

export interface SkillPhase {
  name: string;
  status: "active" | "completed";
  startedAt: number;
  description?: string;
}

/**
 * Extract a skill timeline from sandbox events.
 *
 * A Skill tool call marks the start of a new skill phase.
 * All phases except the last are "completed". The last phase is "active"
 * unless an execution_complete event follows it — then all are "completed".
 */
export function extractSkillTimeline(events: SandboxEvent[]): SkillPhase[] {
  const phases: SkillPhase[] = [];
  let hasExecutionComplete = false;

  for (const event of events) {
    if (event.type === "execution_complete") {
      hasExecutionComplete = true;
      continue;
    }

    if (event.type !== "tool_call") continue;

    const toolEvent = event as ToolCallEvent;
    if (toolEvent.tool?.toLowerCase() !== "skill") continue;

    const skillName = typeof toolEvent.args?.skill === "string" ? toolEvent.args.skill : null;
    if (!skillName) continue;

    const description = typeof toolEvent.args?.args === "string" ? toolEvent.args.args : undefined;

    phases.push({
      name: skillName,
      status: "active",
      startedAt: toolEvent.timestamp,
      ...(description ? { description } : {}),
    });
  }

  // Mark all but the last as completed. If execution_complete seen, mark all completed.
  for (let i = 0; i < phases.length; i++) {
    if (i < phases.length - 1 || hasExecutionComplete) {
      phases[i].status = "completed";
    }
  }

  return phases;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npm test -w @open-inspect/web -- --run src/lib/skills.test.ts
```

Expected: All 7 tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/lib/skills.ts packages/web/src/lib/skills.test.ts
git commit -m "feat: add extractSkillTimeline utility for sidebar timeline"
```

---

### Task 8: Web — Tool Formatter for Skill Calls

**Files:**

- Modify: `packages/web/src/lib/tool-formatters.ts:146-288` (formatToolCall switch)
- Modify: `packages/web/src/components/tool-call-item.tsx:24-49` (ToolIcon switch)

- [ ] **Step 1: Add `skill` case to `formatToolCall`**

In `packages/web/src/lib/tool-formatters.ts`, add a new case before the `default` case (before line
281):

```typescript
    case "skill": {
      const skillName = getStringArg(args, "skill");
      return {
        toolName: "Skill",
        summary: skillName || "skill",
        icon: "bolt",
        getDetails: () => ({ args, output }),
      };
    }
```

- [ ] **Step 2: Add `bolt` icon to ToolIcon component**

In `packages/web/src/components/tool-call-item.tsx`, add a new case in the `ToolIcon` switch (before
the `default` case on line 47), and add the import:

Add to the import statement on line 15:

```typescript
import {
  ChevronRightIcon,
  FileIcon,
  PencilIcon,
  PlusIcon,
  TerminalIcon,
  SearchIcon,
  FolderIcon,
  BoxIcon,
  GlobeIcon,
  BoltIcon,
} from "@/components/ui/icons";
```

Add the case:

```typescript
    case "bolt":
      return <BoltIcon className={iconClass} />;
```

- [ ] **Step 3: Build web package to verify**

```bash
npm run build -w @open-inspect/web 2>&1 | head -5
```

Expected: No type errors related to the changes (build may have other warnings).

- [ ] **Step 4: Commit**

```bash
git add packages/web/src/lib/tool-formatters.ts packages/web/src/components/tool-call-item.tsx
git commit -m "feat: add Skill tool formatter with bolt icon"
```

---

### Task 9: Web — Inline Skill Transition Header

**Files:**

- Create: `packages/web/src/components/skill-transition-header.tsx`
- Modify: `packages/web/src/app/(app)/session/[id]/page.tsx:63-104` (groupEvents function)

- [ ] **Step 1: Create `SkillTransitionHeader` component**

Create `packages/web/src/components/skill-transition-header.tsx`:

```typescript
import { BoltIcon } from "@/components/ui/icons";

interface SkillTransitionHeaderProps {
  skillName: string;
  description?: string;
}

export function SkillTransitionHeader({ skillName, description }: SkillTransitionHeaderProps) {
  return (
    <div className="flex items-center gap-2 py-2 border-b border-border-muted">
      <span className="inline-flex items-center gap-1 bg-accent/10 text-accent px-2 py-0.5 rounded-full text-xs font-semibold">
        <BoltIcon className="w-3 h-3" />
        {skillName}
      </span>
      {description && <span className="text-xs text-muted-foreground truncate">{description}</span>}
    </div>
  );
}
```

- [ ] **Step 2: Modify event grouping to break groups at skill transitions**

In `packages/web/src/app/(app)/session/[id]/page.tsx`, modify the `groupEvents` function (line
79-88) to treat Skill tool calls as group breaks. Replace the `for` loop body:

```typescript
for (const event of events) {
  if (event.type === "tool_call") {
    const isSkillCall = event.tool?.toLowerCase() === "skill";

    if (isSkillCall) {
      // Skill calls always break groups and render as standalone
      flushToolGroup();
      groups.push({
        type: "single",
        event,
        id: `skill-${event.callId || event.timestamp}-${groupIndex++}`,
      });
    } else if (currentToolGroup.length > 0 && currentToolGroup[0].tool === event.tool) {
      currentToolGroup.push(event);
    } else {
      flushToolGroup();
      currentToolGroup = [event];
    }
  } else {
    flushToolGroup();
    groups.push({
      type: "single",
      event,
      id: `single-${event.type}-${("messageId" in event ? event.messageId : undefined) || event.timestamp}-${groupIndex++}`,
    });
  }
}
```

- [ ] **Step 3: Render SkillTransitionHeader in EventItem**

In `packages/web/src/app/(app)/session/[id]/page.tsx`, import the component at the top:

```typescript
import { SkillTransitionHeader } from "@/components/skill-transition-header";
```

Then in the `EventItem` component's switch statement, update the `tool_call` case (around line
1247):

```typescript
    case "tool_call": {
      // Skill calls render as transition headers
      if (event.tool?.toLowerCase() === "skill") {
        const skillName = typeof event.args?.skill === "string" ? event.args.skill : "Skill";
        const description = typeof event.args?.args === "string" ? event.args.args : undefined;
        return <SkillTransitionHeader skillName={skillName} description={description} />;
      }
      // Other tool calls are handled by ToolCallGroup
      return null;
    }
```

- [ ] **Step 4: Build and verify**

```bash
npm run build -w @open-inspect/web 2>&1 | head -5
```

Expected: No type errors.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/components/skill-transition-header.tsx packages/web/src/app/\(app\)/session/\[id\]/page.tsx
git commit -m "feat: add inline skill transition headers in event stream"
```

---

### Task 10: Web — Sidebar Skills Timeline

**Files:**

- Create: `packages/web/src/components/sidebar/skills-timeline-section.tsx`
- Modify: `packages/web/src/components/session-right-sidebar.tsx:1-127`

- [ ] **Step 1: Create `SkillsTimelineSection` component**

Create `packages/web/src/components/sidebar/skills-timeline-section.tsx`:

```typescript
"use client";

import type { SkillPhase } from "@/lib/skills";
import { ClockIcon, CheckCircleIcon } from "@/components/ui/icons";

interface SkillsTimelineSectionProps {
  phases: SkillPhase[];
}

export function SkillsTimelineSection({ phases }: SkillsTimelineSectionProps) {
  if (phases.length === 0) return null;

  return (
    <div className="space-y-1">
      {phases.map((phase, index) => (
        <SkillPhaseItem key={`${phase.name}-${phase.startedAt}`} phase={phase} isLast={index === phases.length - 1} />
      ))}
    </div>
  );
}

function SkillPhaseItem({ phase, isLast }: { phase: SkillPhase; isLast: boolean }) {
  const isActive = phase.status === "active";

  return (
    <div className="flex items-start gap-2">
      {/* Vertical line + status icon */}
      <div className="flex flex-col items-center flex-shrink-0">
        {isActive ? (
          <span className="mt-0.5">
            <ClockIcon className="w-4 h-4 text-accent animate-pulse" />
          </span>
        ) : (
          <span className="mt-0.5">
            <CheckCircleIcon className="w-4 h-4 text-success" />
          </span>
        )}
        {!isLast && <div className="w-px h-4 bg-border-muted mt-1" />}
      </div>

      {/* Content */}
      <div className="min-w-0 pb-1">
        <div className="flex items-center gap-2">
          <span
            className={`text-sm font-medium ${
              isActive ? "text-foreground" : "text-secondary-foreground"
            }`}
          >
            {phase.name}
          </span>
          {isActive && (
            <span className="text-[10px] font-semibold text-accent bg-accent/10 px-1.5 py-0.5 rounded">
              ACTIVE
            </span>
          )}
        </div>
        {phase.description && (
          <p className="text-xs text-muted-foreground truncate">{phase.description}</p>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Add SkillsTimelineSection to the right sidebar**

In `packages/web/src/components/session-right-sidebar.tsx`, add imports:

```typescript
import { extractSkillTimeline } from "@/lib/skills";
import { SkillsTimelineSection } from "./sidebar/skills-timeline-section";
```

Add the `useMemo` for skill timeline (after the `filesChanged` memo, around line 34):

```typescript
const skillTimeline = useMemo(() => extractSkillTimeline(events), [events]);
```

Add the Skills section between Code Server and Tasks (after the Code Server block ending around line
79, before the Tasks block):

```tsx
{
  /* Skills Timeline */
}
{
  skillTimeline.length > 0 && (
    <CollapsibleSection title="Skills" defaultOpen={true}>
      <SkillsTimelineSection phases={skillTimeline} />
    </CollapsibleSection>
  );
}
```

- [ ] **Step 3: Export from sidebar index if one exists**

Check if `packages/web/src/components/sidebar/index.ts` exports sidebar components. If it does, add:

```typescript
export { SkillsTimelineSection } from "./skills-timeline-section";
```

If there's no index file, skip this — the direct import is fine.

- [ ] **Step 4: Build and verify**

```bash
npm run build -w @open-inspect/web 2>&1 | head -5
```

Expected: No type errors.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/components/sidebar/skills-timeline-section.tsx packages/web/src/components/session-right-sidebar.tsx
git commit -m "feat: add skills timeline section to session sidebar"
```

---

### Task 11: Web — Slash Command Palette

**Files:**

- Create: `packages/web/src/components/skill-palette.tsx`
- Modify: `packages/web/src/app/(app)/session/[id]/page.tsx` (input area)

- [ ] **Step 1: Create the fuzzy match utility**

Create `packages/web/src/components/skill-palette.tsx`:

```typescript
"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { BoltIcon } from "@/components/ui/icons";
import type { SkillInfo } from "@open-inspect/shared";

interface SkillPaletteProps {
  skills: SkillInfo[];
  isOpen: boolean;
  filterQuery: string;
  onSelect: (skillName: string) => void;
  onClose: () => void;
}

/**
 * Simple fuzzy match: check if all characters of the query appear
 * in order within the target string (case-insensitive).
 */
function fuzzyMatch(query: string, target: string): boolean {
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  let qi = 0;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) qi++;
  }
  return qi === q.length;
}

function fuzzyScore(query: string, target: string): number {
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  // Prefer prefix matches
  if (t.startsWith(q)) return 2;
  if (t.includes(q)) return 1;
  return 0;
}

export function SkillPalette({ skills, isOpen, filterQuery, onSelect, onClose }: SkillPaletteProps) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  // Filter and sort skills
  const filtered = skills
    .filter((s) => !filterQuery || fuzzyMatch(filterQuery, s.name))
    .sort((a, b) => {
      if (filterQuery) {
        return fuzzyScore(filterQuery, b.name) - fuzzyScore(filterQuery, a.name);
      }
      // Default: container first, then repo, alphabetical within
      if (a.source !== b.source) return a.source === "container" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

  // Group by source
  const containerSkills = filtered.filter((s) => s.source === "container");
  const repoSkills = filtered.filter((s) => s.source === "repo");
  const orderedSkills = [...containerSkills, ...repoSkills];

  // Reset selection when filter changes
  useEffect(() => {
    setSelectedIndex(0);
  }, [filterQuery]);

  // Keyboard navigation
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (!isOpen) return;

      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          setSelectedIndex((i) => Math.min(i + 1, orderedSkills.length - 1));
          break;
        case "ArrowUp":
          e.preventDefault();
          setSelectedIndex((i) => Math.max(i - 1, 0));
          break;
        case "Enter":
          e.preventDefault();
          if (orderedSkills[selectedIndex]) {
            onSelect(orderedSkills[selectedIndex].name);
          }
          break;
        case "Escape":
          e.preventDefault();
          onClose();
          break;
      }
    },
    [isOpen, orderedSkills, selectedIndex, onSelect, onClose]
  );

  useEffect(() => {
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);

  // Scroll selected item into view
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const selected = list.children[selectedIndex] as HTMLElement | undefined;
    selected?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  if (!isOpen || orderedSkills.length === 0) return null;

  let flatIndex = 0;

  return (
    <div
      ref={listRef}
      className="absolute bottom-full left-0 right-0 mb-1 max-h-64 overflow-y-auto bg-card border border-border-muted rounded-lg shadow-lg z-50"
    >
      {containerSkills.length > 0 && (
        <>
          <div className="px-3 py-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">
            Container
          </div>
          {containerSkills.map((skill) => {
            const idx = flatIndex++;
            return (
              <SkillOption
                key={skill.name}
                skill={skill}
                isSelected={idx === selectedIndex}
                onClick={() => onSelect(skill.name)}
              />
            );
          })}
        </>
      )}
      {repoSkills.length > 0 && (
        <>
          {containerSkills.length > 0 && <div className="border-t border-border-muted" />}
          <div className="px-3 py-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">
            Repo
          </div>
          {repoSkills.map((skill) => {
            const idx = flatIndex++;
            return (
              <SkillOption
                key={skill.name}
                skill={skill}
                isSelected={idx === selectedIndex}
                onClick={() => onSelect(skill.name)}
              />
            );
          })}
        </>
      )}
    </div>
  );
}

function SkillOption({
  skill,
  isSelected,
  onClick,
}: {
  skill: SkillInfo;
  isSelected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-full flex items-center gap-2.5 px-3 py-2 text-left transition-colors ${
        isSelected ? "bg-accent/10" : "hover:bg-accent/5"
      }`}
    >
      <BoltIcon
        className={`w-3.5 h-3.5 flex-shrink-0 ${
          skill.source === "container" ? "text-accent" : "text-purple-400"
        }`}
      />
      <div className="min-w-0">
        <div className="text-sm text-foreground font-medium">/{skill.name}</div>
        <div className="text-xs text-muted-foreground truncate">{skill.description}</div>
      </div>
      {isSelected && (
        <span className="ml-auto text-xs text-muted-foreground flex-shrink-0">↵</span>
      )}
    </button>
  );
}
```

- [ ] **Step 2: Integrate the palette into the session page input**

In `packages/web/src/app/(app)/session/[id]/page.tsx`, add imports near the top:

```typescript
import { SkillPalette } from "@/components/skill-palette";
```

Add state for the skill palette (near the existing `prompt` state, around line 320):

```typescript
const [selectedSkill, setSelectedSkill] = useState<string | null>(null);
```

Add derived state for palette visibility (near other derived state):

```typescript
const isPaletteOpen = !selectedSkill && prompt.startsWith("/");
const paletteFilter = isPaletteOpen ? prompt.slice(1) : "";
const skills = sessionState?.skills ?? [];
```

Add a skill selection handler (near `handleSubmit`):

```typescript
const handleSkillSelect = useCallback((skillName: string) => {
  setSelectedSkill(skillName);
  setPrompt("");
  inputRef.current?.focus();
}, []);

const handleSkillRemove = useCallback(() => {
  setSelectedSkill(null);
  setPrompt("/");
  inputRef.current?.focus();
}, []);
```

Modify `handleSubmit` (around line 328) to prepend the selected skill:

```typescript
const handleSubmit = (e: React.FormEvent) => {
  e.preventDefault();
  if ((!prompt.trim() && !selectedSkill) || isProcessing) return;

  const message = selectedSkill ? `/${selectedSkill} ${prompt}`.trim() : prompt;
  sendPrompt(message, selectedModel, reasoningEffort);
  setPrompt("");
  setSelectedSkill(null);
  mutate(SIDEBAR_SESSIONS_KEY);
};
```

Modify `handleKeyDown` to handle backspace into the skill pill. Find the existing `handleKeyDown`
and add at the start of the function:

```typescript
// Backspace with empty input removes the skill pill
if (e.key === "Backspace" && selectedSkill && !prompt) {
  e.preventDefault();
  handleSkillRemove();
  return;
}
```

- [ ] **Step 3: Add the palette and pill to the input JSX**

In the input container `<div className="relative">` (around line 907), replace the textarea block
with:

```tsx
            <div className="relative">
              {/* Skill palette overlay */}
              {skills.length > 0 && (
                <SkillPalette
                  skills={skills}
                  isOpen={isPaletteOpen}
                  filterQuery={paletteFilter}
                  onSelect={handleSkillSelect}
                  onClose={() => setPrompt("")}
                />
              )}

              {/* Input area with optional skill pill */}
              <div className="flex items-start px-4 pt-4 pb-12">
                {selectedSkill && (
                  <button
                    type="button"
                    onClick={handleSkillRemove}
                    className="inline-flex items-center gap-1 bg-accent/10 text-accent px-2 py-1 rounded-full text-xs font-semibold mr-2 mt-0.5 flex-shrink-0 hover:bg-accent/20 transition-colors"
                  >
                    /{selectedSkill}
                    <span className="text-accent/60">&times;</span>
                  </button>
                )}
                <textarea
                  ref={inputRef}
                  value={prompt}
                  onChange={handleInputChange}
                  onKeyDown={handleKeyDown}
                  placeholder={
                    selectedSkill
                      ? "Add a message (optional)..."
                      : isProcessing
                        ? "Type your next message..."
                        : "Ask or build anything"
                  }
                  className="flex-1 resize-none bg-transparent focus:outline-none text-foreground placeholder:text-secondary-foreground"
                  rows={3}
                />
              </div>

              {/* Floating action buttons */}
              <div className="absolute bottom-3 right-3 flex items-center gap-2">
```

(Keep the rest of the action buttons as-is.)

- [ ] **Step 4: Build and verify**

```bash
npm run build -w @open-inspect/web 2>&1 | head -10
```

Expected: No type errors related to the changes.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/components/skill-palette.tsx packages/web/src/app/\(app\)/session/\[id\]/page.tsx
git commit -m "feat: add slash command palette for skill invocation"
```

---

### Task 12: Web — Handle skills_discovered in Socket Hook

**Files:**

- Modify: `packages/web/src/hooks/use-session-socket.ts:168-198` (processSandboxEvent)

- [ ] **Step 1: Add skills_discovered handling**

In `packages/web/src/hooks/use-session-socket.ts`, in the `processSandboxEvent` callback, add
handling for the new event type. After the `else if (event.type === "execution_complete")` block and
before the final `else`, add:

```typescript
    } else if (event.type === "skills_discovered") {
      // Update session state with the discovered skills catalog.
      setSessionState((prev) =>
        prev ? { ...prev, skills: event.skills } : null
      );
      // Also add to events for timeline rendering.
      setEvents((prev) => [...prev, event]);
```

- [ ] **Step 2: Build and verify**

```bash
npm run build -w @open-inspect/web 2>&1 | head -5
```

Expected: No type errors.

- [ ] **Step 3: Commit**

```bash
git add packages/web/src/hooks/use-session-socket.ts
git commit -m "feat: handle skills_discovered event in session socket hook"
```

---

### Task 13: Typecheck, Lint, and Full Test Suite

**Files:** None (verification only)

- [ ] **Step 1: Build shared (dependency for everything)**

```bash
npm run build -w @open-inspect/shared
```

Expected: Clean build.

- [ ] **Step 2: Typecheck all TypeScript packages**

```bash
npm run typecheck
```

Expected: No errors.

- [ ] **Step 3: Lint and format**

```bash
npm run lint:fix
npm run format
```

Expected: Clean or auto-fixed.

- [ ] **Step 4: Run all TypeScript tests**

```bash
npm test -w @open-inspect/control-plane
npm test -w @open-inspect/web
```

Expected: All tests pass.

- [ ] **Step 5: Run Python tests**

```bash
cd packages/sandbox-runtime && python -m pytest tests/ -v
```

Expected: All tests pass.

- [ ] **Step 6: Python lint**

```bash
cd packages/sandbox-runtime && ruff check --fix && ruff format
```

Expected: Clean.

- [ ] **Step 7: Commit any lint/format fixes**

```bash
git add -A
git commit -m "chore: lint and format fixes for skills support"
```

(Skip if no changes.)

---

### Task 14: Local Testing Verification

**Files:** None (manual testing)

- [ ] **Step 1: Verify the control plane builds with new event type**

```bash
npm run build -w @open-inspect/control-plane
```

Expected: Clean build with `skills_discovered` event handling.

- [ ] **Step 2: Verify the web app starts locally**

```bash
cd packages/web && npm run dev
```

Expected: Dev server starts. Navigate to a session page — no console errors related to skills.

- [ ] **Step 3: Verify the skill scanner runs in isolation**

```bash
cd packages/sandbox-runtime && python -c "
from sandbox_runtime.skill_scanner import scan_skills
from pathlib import Path
import json
# Scan a test workspace (no skills expected, just verify no crash)
result = scan_skills(workspace=Path('/tmp'), plugin_cache_dir=None)
print(json.dumps(result, indent=2))
"
```

Expected: `[]` (empty list, no errors).

- [ ] **Step 4: Document what was tested**

Add a brief note in the PR description about what was verified locally.
