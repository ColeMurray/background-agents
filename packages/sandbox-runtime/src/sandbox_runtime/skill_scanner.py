"""Scan for SKILL.md files and extract skill metadata.

Discovers skills from two sources:
1. Repo directories: .opencode/skills/, .claude/skills/, .agents/skills/
2. Plugin cache: OpenCode's plugin installation directory

Returns a list of skill info dicts ready to send as a skills_discovered event.
No external YAML library needed — frontmatter is simple key: value pairs.
"""

import re
from pathlib import Path
from typing import Any

from .log_config import get_logger

log = get_logger("skill_scanner")

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

    log.info(
        "skills.scan_complete",
        total=len(merged),
        repo=len(repo_skills),
        container=len(container_skills),
    )
    return merged
