"""Tests for the skill scanner that reads SKILL.md frontmatter."""

import textwrap
from pathlib import Path

import pytest

from sandbox_runtime.skill_scanner import scan_skills, parse_skill_frontmatter


class TestParseSkillFrontmatter:
    def test_parses_name_and_description(self, tmp_path: Path):
        skill_md = tmp_path / "SKILL.md"
        skill_md.write_text(
            textwrap.dedent("""\
            ---
            name: brainstorming
            description: Collaborative design and spec creation
            ---

            # Brainstorming

            Some content here.
        """)
        )
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
        skill_md.write_text(
            textwrap.dedent("""\
            ---
            description: Missing the name field
            ---
        """)
        )
        result = parse_skill_frontmatter(skill_md)
        assert result is None

    def test_handles_multiline_description(self, tmp_path: Path):
        skill_md = tmp_path / "SKILL.md"
        skill_md.write_text(
            textwrap.dedent("""\
            ---
            name: tdd
            description: Test-driven development workflow
            ---
        """)
        )
        result = parse_skill_frontmatter(skill_md)
        assert result is not None
        assert result["name"] == "tdd"


class TestScanSkills:
    def _make_skill(self, base: Path, name: str, desc: str) -> Path:
        skill_dir = base / name
        skill_dir.mkdir(parents=True, exist_ok=True)
        (skill_dir / "SKILL.md").write_text(f"---\nname: {name}\ndescription: {desc}\n---\n")
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
