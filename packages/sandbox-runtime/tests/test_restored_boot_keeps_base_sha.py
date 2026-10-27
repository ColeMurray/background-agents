"""A restored boot keeps the session-start commits the first boot discovered."""

import json
from pathlib import Path
from unittest.mock import AsyncMock

from sandbox_runtime import repository_boot as repository_boot_module
from sandbox_runtime.repository_sync import RepositorySyncResult
from sandbox_runtime.runtime_config import BootMode
from tests.runtime_helpers import make_repository_boot

FIRST_BOOT_SHA = "a" * 40
ENV_SHA = "b" * 40
ENVIRONMENT = {"SANDBOX_ID": "sb-1", "REPO_OWNER": "acme", "REPO_NAME": "repo"}


def _manifest_path() -> Path:
    # The autouse fixture points the module constant at a per-test file.
    return Path(repository_boot_module.REPO_MANIFEST_FILE_PATH)


def _write_manifest(base_sha: str) -> None:
    _manifest_path().write_text(
        json.dumps(
            {
                "repositories": [
                    {
                        "owner": "acme",
                        "name": "repo",
                        "branch": "main",
                        "path": "/workspace/repo",
                        "baseSha": base_sha,
                    }
                ]
            }
        )
    )


def _stub_boot_steps(boot) -> None:
    boot.synchronizer.ensure_credentials_configured = AsyncMock()
    boot.synchronizer.sync = AsyncMock(
        side_effect=lambda repos, _mode: RepositorySyncResult(
            repositories=tuple(repos), outcomes=()
        )
    )
    boot.hooks.run_setup = AsyncMock(return_value=True)
    boot.hooks.run_start = AsyncMock(return_value=True)
    boot.tunnel_environment.wait_until_ready = AsyncMock()


def test_a_repository_without_a_commit_takes_the_persisted_one(tmp_path):
    _write_manifest(FIRST_BOOT_SHA)
    boot = make_repository_boot(ENVIRONMENT, workspace_path=tmp_path)
    assert boot.repositories[0].base_sha is None

    boot._adopt_persisted_base_shas()

    assert boot.repositories[0].base_sha == FIRST_BOOT_SHA


def test_a_commit_from_the_session_config_is_kept(tmp_path):
    _write_manifest(FIRST_BOOT_SHA)
    boot = make_repository_boot(
        {**ENVIRONMENT, "SESSION_CONFIG": json.dumps({"base_sha": ENV_SHA})},
        workspace_path=tmp_path,
    )

    boot._adopt_persisted_base_shas()

    assert boot.repositories[0].base_sha == ENV_SHA


def test_nothing_changes_without_a_persisted_manifest(tmp_path):
    boot = make_repository_boot(ENVIRONMENT, workspace_path=tmp_path)

    boot._adopt_persisted_base_shas()

    assert boot.repositories[0].base_sha is None


async def test_a_restored_boot_writes_the_commit_back_and_a_fresh_boot_leaves_it(tmp_path):
    for mode, expected in ((BootMode.SNAPSHOT_RESTORE, FIRST_BOOT_SHA), (BootMode.FRESH, None)):
        _write_manifest(FIRST_BOOT_SHA)
        boot = make_repository_boot(ENVIRONMENT, workspace_path=tmp_path)
        _stub_boot_steps(boot)

        result = await boot.boot(mode, [])

        assert result.repositories[0].base_sha == expected, mode
        written = json.loads(_manifest_path().read_text())["repositories"][0]
        assert written.get("baseSha") == expected, mode
