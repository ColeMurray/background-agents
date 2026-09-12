"""Real hook failures preserve boot policy only after child provisioning stops."""

import asyncio
import json
import shlex
import sys
from unittest.mock import AsyncMock

import pytest

from sandbox_runtime.repository_sync import (
    RepositorySyncOutcome,
    RepositorySyncResult,
    RepositorySyncStatus,
)
from sandbox_runtime.runtime_config import BootMode
from tests.runtime_helpers import make_repository_boot

RUNTIME_BOOT_MODES = [BootMode.FRESH, BootMode.REPO_IMAGE, BootMode.SNAPSHOT_RESTORE]


def _repository_boot(tmp_path, names):
    repository = make_repository_boot(
        {
            "SANDBOX_ID": "hook-policy-test",
            "REPO_OWNER": "acme",
            "REPO_NAME": names[0],
            "SESSION_CONFIG": json.dumps(
                {"repositories": [{"repo_owner": "acme", "repo_name": name} for name in names]}
            ),
        },
        workspace_path=tmp_path,
    )
    for repo in repository.repositories:
        (repo.path / ".openinspect").mkdir(parents=True)
    repository.synchronizer.ensure_credentials_configured = AsyncMock()
    repository.synchronizer.sync = AsyncMock(
        return_value=RepositorySyncResult(
            tuple(repository.repositories),
            tuple(
                RepositorySyncOutcome(repo, RepositorySyncStatus.SUCCEEDED)
                for repo in repository.repositories
            ),
        )
    )
    return repository


def _python(code):
    return f"{shlex.quote(sys.executable)} -c {shlex.quote(code)}"


def _write_hook(repo, hook, script):
    (repo.path / ".openinspect" / f"{hook}.sh").write_text(script)


def _failing_provisioner(repo, hook):
    # The launcher waits for the child's sentinel, so nonzero exit cannot race
    # a child that was never actually started. It then leaves inherited output
    # open while the child attempts a delayed provisioning mutation.
    child = _python(
        "import os,time; from pathlib import Path; "
        "Path('child.pid').write_text(str(os.getpid())); "
        "time.sleep(.3); Path('late-write').write_text('leaked provisioning'); "
        "time.sleep(60)"
    )
    _write_hook(
        repo,
        hook,
        f"{child} &\nwhile [ ! -f child.pid ]; do sleep .01; done\nexit 2\n",
    )


def _observing_start(repo, failed_repo):
    _write_hook(
        repo,
        "start",
        _python(
            "import time; from pathlib import Path; "
            "Path('start-began').write_text('started'); "
            "time.sleep(.5); "
            f"assert not Path({str(failed_repo.path / 'late-write')!r}).exists(); "
            "Path('start-completed').write_text('completed')"
        ),
    )


def _warnings(tmp_path):
    return [
        json.loads(line) for line in (tmp_path / "oi-boot-warnings.jsonl").read_text().splitlines()
    ]


async def test_fresh_setup_warning_cannot_keep_provisioning_during_start(tmp_path):
    repository = _repository_boot(tmp_path, ["primary"])
    primary = repository.repositories[0]
    _failing_provisioner(primary, "setup")
    _observing_start(primary, primary)

    try:
        async with asyncio.timeout(3):
            result = await repository.boot(BootMode.FRESH, [])

        assert result.setup_success is False
        assert result.start_success is True
        assert (primary.path / "child.pid").exists()
        assert (primary.path / "start-completed").exists()
        assert not (primary.path / "late-write").exists()
        assert _warnings(tmp_path) == [
            {
                "scope": "setup",
                "message": "setup.sh failed for acme/primary; the session continues without it.",
                "repoOwner": "acme",
                "repoName": "primary",
            }
        ]
    finally:
        await repository.hooks.shutdown()


@pytest.mark.parametrize("boot_mode", RUNTIME_BOOT_MODES)
async def test_secondary_start_warning_cleans_children_before_next_hook(tmp_path, boot_mode):
    repository = _repository_boot(tmp_path, ["primary", "secondary", "next"])
    primary, secondary, next_repo = repository.repositories
    _write_hook(primary, "start", "printf started > primary-started\n")
    _failing_provisioner(secondary, "start")
    _observing_start(next_repo, secondary)

    try:
        async with asyncio.timeout(3):
            result = await repository.boot(boot_mode, [])

        assert result.start_success is False
        assert (primary.path / "primary-started").exists()
        assert (secondary.path / "child.pid").exists()
        assert (next_repo.path / "start-completed").exists()
        assert not (secondary.path / "late-write").exists()
        assert _warnings(tmp_path) == [
            {
                "scope": "start",
                "message": "start.sh failed for acme/secondary; the session continues without it.",
                "repoOwner": "acme",
                "repoName": "secondary",
            }
        ]
    finally:
        await repository.hooks.shutdown()


@pytest.mark.parametrize("boot_mode", RUNTIME_BOOT_MODES)
async def test_primary_start_failure_stops_children_and_prevents_later_hooks(tmp_path, boot_mode):
    repository = _repository_boot(tmp_path, ["primary", "secondary"])
    primary, secondary = repository.repositories
    _failing_provisioner(primary, "start")
    _write_hook(secondary, "start", "printf started > secondary-started\n")

    try:
        async with asyncio.timeout(3):
            with pytest.raises(RuntimeError, match="start hook failed for acme/primary"):
                await repository.boot(boot_mode, [])

        assert (primary.path / "child.pid").exists()
        assert not (secondary.path / "secondary-started").exists()
        assert not (tmp_path / "oi-boot-warnings.jsonl").exists()
        await asyncio.sleep(0.5)
        assert not (primary.path / "late-write").exists()
    finally:
        await repository.hooks.shutdown()
