"""Tests for checkout-local exclusions of Open-Inspect runtime assets."""

import subprocess
from pathlib import Path

from sandbox_runtime.git_excludes import install_runtime_git_excludes


def _git(repo: Path, *args: str) -> str:
    result = subprocess.run(["git", *args], cwd=repo, check=True, capture_output=True, text=True)
    return result.stdout.strip()


def test_managed_excludes_preserve_user_entries_and_are_idempotent(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    repo.mkdir()
    _git(repo, "init", "-b", "main")
    exclude = repo / ".git" / "info" / "exclude"
    exclude.write_text("# user entries\n*.local\n")

    runtime_paths = {
        ".opencode/tool/spawn-task.js",
        ".opencode/skills/agent-browser/SKILL.md",
    }
    install_runtime_git_excludes(repo, runtime_paths)
    first = exclude.read_text()
    install_runtime_git_excludes(
        repo,
        [
            ".opencode/tool/spawn-task.js",
            ".opencode/skills/agent-browser/SKILL.md",
        ],
    )

    assert exclude.read_text() == first
    assert first.startswith("# user entries\n*.local\n")
    assert first.count("# BEGIN Open-Inspect runtime assets") == 1
    assert "/.opencode/skills/agent-browser/SKILL.md" in first
    assert "/.opencode/tool/spawn-task.js" in first


def test_managed_excludes_hide_only_the_owned_runtime_paths(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    repo.mkdir()
    _git(repo, "init", "-b", "main")
    runtime_file = repo / ".opencode" / "tool" / "spawn-task.js"
    runtime_file.parent.mkdir(parents=True)
    runtime_file.write_text("// runtime\n")
    user_file = repo / ".opencode" / "command" / "review.md"
    user_file.parent.mkdir(parents=True)
    user_file.write_text("user-authored command\n")

    install_runtime_git_excludes(repo, {".opencode/tool/spawn-task.js"})

    assert _git(repo, "ls-files", "--others", "--exclude-standard") == (
        ".opencode/command/review.md"
    )
