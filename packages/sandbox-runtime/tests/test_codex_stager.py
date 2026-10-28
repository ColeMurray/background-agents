"""Codex boot stages decisions/skills, never native auth or MCP secrets."""

import asyncio
import json
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from sandbox_runtime.codex_stager import CodexHarnessHandoff, CodexStager
from sandbox_runtime.constants import BIN_INSTALL_DIR_ENV_VAR
from sandbox_runtime.entrypoint import build_supervisor
from sandbox_runtime.runtime_config import CodexStagerConfig


@pytest.mark.asyncio
async def test_stages_private_handoff_without_credentials_or_repository_writes(
    tmp_path, monkeypatch
):
    monkeypatch.setenv(BIN_INSTALL_DIR_ENV_VAR, str(tmp_path / "bin"))
    workdir = tmp_path / "repo"
    workdir.mkdir()
    skills = tmp_path / "bundled" / "review"
    skills.mkdir(parents=True)
    (skills / "SKILL.md").write_text("# Review")
    packages = MagicMock(install=AsyncMock())
    servers = (
        {
            "name": "fixture",
            "type": "remote",
            "url": "https://mcp.example",
            "headers": {"Authorization": "fixture-secret"},
        },
    )
    stager = CodexStager(
        CodexStagerConfig(has_repository=True, mcp_servers=servers),
        MagicMock(),
        config_dir=tmp_path / "codex-home",
        bundled_skills_path=skills.parent,
        handoff_path=tmp_path / "handoff.json",
        mcp_packages=packages,
    )
    await stager.start((), workdir)
    assert list(workdir.iterdir()) == []
    assert (stager.skills_dir / "review" / "SKILL.md").read_text() == "# Review"
    handoff = CodexHarnessHandoff.read(tmp_path / "handoff.json")
    assert handoff == CodexHarnessHandoff(workdir, stager.config_dir, True)
    assert stager.config_dir.stat().st_mode & 0o777 == 0o700
    assert (tmp_path / "handoff.json").stat().st_mode & 0o777 == 0o600
    assert "fixture-secret" not in (tmp_path / "handoff.json").read_text()
    assert not (stager.config_dir / "auth.json").exists()
    assert not (stager.config_dir / "config.toml").exists()
    packages.install.assert_awaited_once_with(list(servers))
    assert stager.exit_code() is None
    await stager.stop()


def test_boot_and_managed_skills_share_owned_home_ignoring_user_codex_home(tmp_path: Path):
    environment = {
        "HOME": str(tmp_path / "home"),
        "CONTROL_PLANE_URL": "https://control.example",
        "REPO_OWNER": "acme",
        "REPO_NAME": "repo",
        "SESSION_CONFIG": json.dumps({"session_id": "session-1", "harness": "codex"}),
        "CODEX_HOME": "/workspace/repo/.codex",
    }
    with patch.dict("os.environ", environment, clear=True):
        supervisor = build_supervisor(asyncio.Event())
    decided = tmp_path / "home" / ".openinspect" / "codex"
    assert isinstance(supervisor.harness_process, CodexStager)
    assert supervisor.harness_process.config_dir == decided
    assert supervisor.managed_skills is not None
    assert supervisor.managed_skills.destination == decided / "skills"
