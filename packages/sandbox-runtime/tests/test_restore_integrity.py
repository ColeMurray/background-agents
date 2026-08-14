import json
import os
import subprocess
from dataclasses import replace
from pathlib import Path
from unittest.mock import AsyncMock, patch

import pytest

from sandbox_runtime.runtime_config import BootMode


def _git(repo: Path, *args: str) -> str:
    return subprocess.run(
        ["git", *args], cwd=repo, check=True, capture_output=True, text=True
    ).stdout.strip()


@pytest.mark.asyncio
async def test_snapshot_restore_preserves_head_index_and_worktree(tmp_path: Path) -> None:
    repo = tmp_path / "viewer"
    repo.mkdir()
    _git(repo, "init", "-b", "main")
    _git(repo, "config", "user.name", "Restore Test")
    _git(repo, "config", "user.email", "restore@example.com")
    (repo / "tracked.txt").write_text("baseline\n")
    _git(repo, "add", "tracked.txt")
    _git(repo, "commit", "-m", "baseline")
    baseline_sha = _git(repo, "rev-parse", "HEAD")
    _git(repo, "checkout", "-b", "feature/session-work")
    (repo / "committed.txt").write_text("committed\n")
    _git(repo, "add", "committed.txt")
    _git(repo, "commit", "-m", "session commit")
    feature_sha = _git(repo, "rev-parse", "HEAD")
    (repo / "staged.txt").write_text("staged\n")
    _git(repo, "add", "staged.txt")
    (repo / "tracked.txt").write_text("dirty\n")
    (repo / "untracked.txt").write_text("untracked\n")
    _git(repo, "update-ref", "refs/remotes/origin/main", baseline_sha)

    environment = {
        "SANDBOX_ID": "sandbox-1",
        "REPO_OWNER": "open-inspect",
        "REPO_NAME": "viewer",
        "RESTORED_FROM_SNAPSHOT": "true",
        "SESSION_CONFIG": json.dumps(
            {
                "session_id": "session-1",
                "repositories": [
                    {
                        "repo_owner": "open-inspect",
                        "repo_name": "viewer",
                        "branch": "main",
                    }
                ],
            }
        ),
    }
    with patch.dict(os.environ, environment, clear=False):
        from tests.runtime_helpers import make_repository_boot

        supervisor = make_repository_boot()
    supervisor.repositories = [replace(supervisor.repositories[0], path=repo)]
    supervisor.synchronizer._ensure_plain_origin = AsyncMock(return_value=True)
    supervisor.synchronizer._fetch_branch = AsyncMock(return_value=True)

    result = await supervisor.synchronizer.sync(supervisor.repositories, BootMode.SNAPSHOT_RESTORE)

    assert result.failures == ()
    assert _git(repo, "rev-parse", "HEAD") == feature_sha
    assert _git(repo, "branch", "--show-current") == "feature/session-work"
    assert "staged.txt" in _git(repo, "diff", "--cached", "--name-only")
    assert "tracked.txt" in _git(repo, "diff", "--name-only")
    assert (repo / "untracked.txt").read_text() == "untracked\n"
