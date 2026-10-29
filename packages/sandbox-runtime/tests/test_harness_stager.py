"""Shared staging behavior must stay identical across the vendor entry points."""

import json
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock

import pytest

from sandbox_runtime.claude_stager import ClaudeHarnessHandoff, ClaudeStager
from sandbox_runtime.codex_stager import CodexHarnessHandoff, CodexStager
from sandbox_runtime.constants import (
    BIN_INSTALL_DIR_ENV_VAR,
    CLAUDE_HARNESS_FILE_PATH,
    CODEX_HARNESS_FILE_PATH,
)
from sandbox_runtime.harness.base import HarnessProcessOwner
from sandbox_runtime.harness_stager import HarnessStager
from sandbox_runtime.runtime_config import ClaudeStagerConfig, CodexStagerConfig


@pytest.mark.parametrize(
    "handoff_type,default_path",
    [
        (ClaudeHarnessHandoff, CLAUDE_HARNESS_FILE_PATH),
        (CodexHarnessHandoff, CODEX_HARNESS_FILE_PATH),
    ],
)
@pytest.mark.parametrize("has_repository", [True, False])
def test_handoff_round_trip_with_vendor_default_path(
    tmp_path, monkeypatch, handoff_type, default_path, has_repository
):
    assert handoff_type.default_path == Path(default_path)
    path = tmp_path / "handoff.json"
    monkeypatch.setattr(handoff_type, "default_path", path)
    handoff = handoff_type(tmp_path / "work", tmp_path / "config", has_repository)

    handoff.write()

    assert handoff_type.read() == handoff
    assert type(handoff_type.read()) is handoff_type
    assert json.loads(path.read_text()) == {
        "workdir": str(handoff.workdir),
        "configDir": str(handoff.config_dir),
        "hasRepository": has_repository,
    }
    assert path.stat().st_mode & 0o777 == 0o600
    assert not path.with_name("handoff.json.tmp").exists()


@pytest.fixture(
    params=[(ClaudeStager, ClaudeStagerConfig), (CodexStager, CodexStagerConfig)],
    ids=["claude", "codex"],
)
def stager(request, tmp_path, monkeypatch) -> HarnessStager:
    monkeypatch.setenv(BIN_INSTALL_DIR_ENV_VAR, str(tmp_path / "bin"))
    stager_type, config_type = request.param
    return stager_type(
        config_type(has_repository=False, mcp_servers=()),
        MagicMock(),
        config_dir=tmp_path / "config",
        bundled_skills_path=tmp_path / "bundled",
        handoff_path=tmp_path / "handoff.json",
        mcp_packages=MagicMock(install=AsyncMock()),
    )


async def test_bundled_skills_merge_preserving_links_and_ignoring_artifacts(stager, tmp_path):
    skill = stager.bundled_skills_path / "review"
    skill.mkdir(parents=True)
    (skill / "SKILL.md").write_text("# Review")
    (skill / "guide.md").symlink_to("SKILL.md")
    (skill / "__pycache__").mkdir()
    (skill / "__pycache__" / "cached.pyc").write_bytes(b"cached")
    (skill / "cached.pyc").write_bytes(b"cached")
    (skill / ".DS_Store").write_bytes(b"metadata")
    (stager.bundled_skills_path / "not-a-skill").mkdir()
    (stager.bundled_skills_path / "loose.md").write_text("not a skill directory")
    destination = stager.skills_dir / "review"
    destination.mkdir(parents=True)
    (destination / "SKILL.md").write_text("outdated")
    (destination / "managed.md").write_text("keep me")

    await stager.start((), tmp_path)

    assert (destination / "SKILL.md").read_text() == "# Review"
    assert (destination / "managed.md").read_text() == "keep me"
    assert (destination / "guide.md").is_symlink()
    assert (destination / "guide.md").readlink() == Path("SKILL.md")
    assert not (destination / "__pycache__").exists()
    assert not (destination / "cached.pyc").exists()
    assert not (destination / ".DS_Store").exists()
    assert not (stager.skills_dir / "not-a-skill").exists()
    assert not (stager.skills_dir / "loose.md").exists()


async def test_missing_skills_and_failed_mcp_preinstall_do_not_block_staging(stager, tmp_path):
    error = RuntimeError("MCP unavailable")
    stager._mcp_packages.install.side_effect = error
    assert isinstance(stager, HarnessProcessOwner)
    assert stager.started is False
    assert not stager.bundled_skills_path.exists()

    await stager.start((), tmp_path)

    assert stager.started is True
    assert stager.config_dir.is_dir()
    assert not stager.skills_dir.exists()
    prefix = "claude" if isinstance(stager, ClaudeStager) else "codex"
    stager.log.warn.assert_called_once_with(f"{prefix}.mcp_preinstall_failed", exc=error)
    assert json.loads(stager.handoff_path.read_text())["hasRepository"] is False
    assert stager.exit_code() is None
    await stager.stop()
