"""ClaudeStager: staging only, no process, a handoff the bridge can read."""

import json
from pathlib import Path
from unittest.mock import MagicMock

import pytest

from sandbox_runtime.claude_stager import (
    ClaudeHarnessHandoff,
    ClaudeStager,
    resolve_claude_config_dir,
)
from sandbox_runtime.harness.base import HarnessProcessOwner
from sandbox_runtime.runtime_config import ClaudeStagerConfig


def _stager(tmp_path: Path, monkeypatch, **overrides) -> ClaudeStager:
    monkeypatch.setenv("OI_BIN_INSTALL_DIR", str(tmp_path / "bin"))
    skills = tmp_path / "bundled-skills"
    (skills / "review").mkdir(parents=True)
    (skills / "review" / "SKILL.md").write_text("# review")
    (skills / "not-a-skill").mkdir()
    config = ClaudeStagerConfig(
        has_repository=overrides.pop("has_repository", True),
        mcp_servers=overrides.pop(
            "mcp_servers", ({"name": "linear", "type": "remote", "url": "u"},)
        ),
    )
    return ClaudeStager(
        config,
        MagicMock(),
        config_dir=tmp_path / "claude-config",
        bundled_skills_path=skills,
        handoff_path=tmp_path / "handoff.json",
    )


def test_conforms_to_the_process_owner_protocol(tmp_path: Path, monkeypatch) -> None:
    stager = _stager(tmp_path, monkeypatch)
    assert isinstance(stager, HarnessProcessOwner)
    assert stager.exit_code() is None


@pytest.mark.asyncio
async def test_start_stages_config_dir_skills_and_handoff(tmp_path: Path, monkeypatch) -> None:
    stager = _stager(tmp_path, monkeypatch)
    workdir = tmp_path / "workspace" / "repo"
    workdir.mkdir(parents=True)

    await stager.start((), workdir)

    assert (tmp_path / "claude-config").is_dir()
    assert (tmp_path / "claude-config" / "skills" / "review" / "SKILL.md").read_text() == "# review"
    assert not (tmp_path / "claude-config" / "skills" / "not-a-skill").exists()
    handoff = ClaudeHarnessHandoff.read(tmp_path / "handoff.json")
    assert handoff.workdir == workdir
    assert handoff.config_dir == tmp_path / "claude-config"
    assert handoff.has_repository is True
    assert handoff.mcp_servers == ({"name": "linear", "type": "remote", "url": "u"},)
    # Still no process: the SDK child belongs to the bridge.
    assert stager.exit_code() is None
    await stager.stop()


@pytest.mark.asyncio
async def test_start_never_writes_into_the_repository(tmp_path: Path, monkeypatch) -> None:
    stager = _stager(tmp_path, monkeypatch)
    workdir = tmp_path / "workspace" / "repo"
    workdir.mkdir(parents=True)
    before = sorted(p.relative_to(workdir) for p in workdir.rglob("*"))

    await stager.start((), workdir)

    after = sorted(p.relative_to(workdir) for p in workdir.rglob("*"))
    assert before == after
    raw = json.loads((tmp_path / "handoff.json").read_text())
    assert "credential" not in json.dumps(raw).lower()


def test_config_dir_defaults_outside_every_repository(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.delenv("CLAUDE_CONFIG_DIR", raising=False)
    monkeypatch.setenv("HOME", str(tmp_path))
    assert resolve_claude_config_dir() == tmp_path / ".openinspect" / "claude"
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", "/elsewhere")
    assert resolve_claude_config_dir() == Path("/elsewhere")
