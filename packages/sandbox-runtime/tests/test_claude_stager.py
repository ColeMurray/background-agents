"""ClaudeStager: staging only, no process, a handoff the bridge can read."""

import asyncio
import json
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from sandbox_runtime.claude_stager import (
    ClaudeHarnessHandoff,
    ClaudeStager,
    isolated_claude_config_dir,
    resolve_claude_config_dir,
)
from sandbox_runtime.constants import BIN_INSTALL_DIR_ENV_VAR
from sandbox_runtime.entrypoint import build_supervisor
from sandbox_runtime.harness.base import HarnessProcessOwner
from sandbox_runtime.repo_config import RepoEntry
from sandbox_runtime.runtime_config import ClaudeStagerConfig, _freeze_json


class FakeMcpPackages:
    def __init__(self) -> None:
        self.installed: list[list] = []

    async def install(self, servers: list) -> None:
        self.installed.append(servers)


def _stager(tmp_path: Path, monkeypatch, **overrides) -> ClaudeStager:
    monkeypatch.setenv(BIN_INSTALL_DIR_ENV_VAR, str(tmp_path / "bin"))
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
        config_dir=overrides.pop("config_dir", tmp_path / "claude-config"),
        bundled_skills_path=skills,
        handoff_path=tmp_path / "handoff.json",
        mcp_packages=overrides.pop("mcp_packages", FakeMcpPackages()),
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


@pytest.mark.asyncio
async def test_handoff_carries_decisions_only_and_is_owner_readable(
    tmp_path: Path, monkeypatch
) -> None:
    """MCP configuration can hold credentials; it reaches the bridge through
    SESSION_CONFIG and never through a file a snapshot would keep."""
    stager = _stager(
        tmp_path,
        monkeypatch,
        mcp_servers=tuple(
            _freeze_json(
                [
                    {
                        "name": "linear",
                        "type": "remote",
                        "url": "u",
                        "headers": {"Authorization": "x"},
                    }
                ]
            )
        ),
    )
    workdir = tmp_path / "workspace" / "repo"
    workdir.mkdir(parents=True)

    await stager.start((), workdir)

    handoff_path = tmp_path / "handoff.json"
    raw = json.loads(handoff_path.read_text())
    assert set(raw) == {"workdir", "configDir", "hasRepository"}
    assert handoff_path.stat().st_mode & 0o777 == 0o600
    assert not handoff_path.with_name("handoff.json.tmp").exists()


@pytest.mark.asyncio
async def test_start_preinstalls_local_mcp_packages(tmp_path: Path, monkeypatch) -> None:
    packages = FakeMcpPackages()
    servers = ({"name": "fs", "type": "local", "command": ["npx", "-y", "fs-mcp"]},)
    stager = _stager(tmp_path, monkeypatch, mcp_servers=servers, mcp_packages=packages)
    workdir = tmp_path / "workspace" / "repo"
    workdir.mkdir(parents=True)

    await stager.start((), workdir)

    assert packages.installed == [list(servers)]


def test_config_dir_inside_the_workspace_or_a_checkout_falls_back_to_the_default(
    tmp_path: Path, monkeypatch
) -> None:
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    workspace = tmp_path / "workspace"
    repo = workspace / "repo"
    elsewhere = tmp_path / "elsewhere"
    entry = RepoEntry(owner="acme", name="repo", branch="main", path=repo)
    fallback = tmp_path / "home" / ".openinspect" / "claude"

    log = MagicMock()
    assert isolated_claude_config_dir(repo / ".claude", workspace, (entry,), log) == fallback
    assert isolated_claude_config_dir(workspace / ".claude", workspace, (entry,), log) == fallback
    assert isolated_claude_config_dir(workspace, workspace, (entry,), log) == fallback
    assert log.warn.call_count == 3
    assert isolated_claude_config_dir(elsewhere, workspace, (entry,), log) == elsewhere


def test_managed_skills_and_the_stager_share_the_decided_config_dir(
    tmp_path: Path, monkeypatch
) -> None:
    # Managed skills land before the stager runs, so a rejected override must
    # be replaced once, for both, not by the stager alone.
    environment = {
        "HOME": str(tmp_path / "home"),
        "CONTROL_PLANE_URL": "https://control.example",
        "REPO_OWNER": "acme",
        "REPO_NAME": "repo",
        "SESSION_CONFIG": json.dumps({"session_id": "session-1", "harness": "claude"}),
        "CLAUDE_CONFIG_DIR": "/workspace/repo/.claude",
    }
    with patch.dict("os.environ", environment, clear=True):
        supervisor = build_supervisor(asyncio.Event())

    decided = tmp_path / "home" / ".openinspect" / "claude"
    assert isinstance(supervisor.harness_process, ClaudeStager)
    assert supervisor.harness_process.config_dir == decided
    assert supervisor.managed_skills is not None
    assert supervisor.managed_skills.destination == decided / "skills"


def test_config_dir_defaults_outside_every_repository(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.delenv("CLAUDE_CONFIG_DIR", raising=False)
    monkeypatch.setenv("HOME", str(tmp_path))
    assert resolve_claude_config_dir() == tmp_path / ".openinspect" / "claude"
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", "/elsewhere")
    assert resolve_claude_config_dir() == Path("/elsewhere")
