from __future__ import annotations

import asyncio
import os
import time
from typing import TYPE_CHECKING, Any

from .process_output import (
    finish_cancellation_cleanup,
    spawn_owned_subprocess,
    terminate_owned_subprocess,
    wait_for_process_exit,
)

if TYPE_CHECKING:
    from .repo_config import RepoEntry
    from .runtime_config import BootMode


class RepositoryHooks:
    SETUP_SCRIPT_PATH = ".openinspect/setup.sh"
    START_SCRIPT_PATH = ".openinspect/start.sh"

    def __init__(self, log: Any) -> None:
        self.log = log

    async def _terminate(self, process: asyncio.subprocess.Process) -> None:
        await terminate_owned_subprocess(process, kill_process_group=os.killpg)

    async def _run(
        self,
        repo: RepoEntry,
        boot_mode: BootMode,
        *,
        hook_name: str,
        relative_script_path: str,
    ) -> bool:
        """Run one repository hook; True when it succeeded or there was no script."""
        script_path = repo.path / relative_script_path
        start_time = time.time()
        if not script_path.exists():
            self.log.debug(
                f"{hook_name}.skip",
                reason="no_script",
                path=str(script_path),
                boot_mode=boot_mode.value,
            )
            return True
        self.log.info(
            f"{hook_name}.start",
            script=str(script_path),
            repo_owner=repo.owner,
            repo_name=repo.name,
            boot_mode=boot_mode.value,
        )
        process: asyncio.subprocess.Process | None = None
        try:
            env = os.environ.copy()
            env["OPENINSPECT_BOOT_MODE"] = boot_mode.value
            process = await spawn_owned_subprocess(
                asyncio.create_subprocess_exec(
                    "bash",
                    str(script_path),
                    cwd=repo.path,
                    stdout=asyncio.subprocess.DEVNULL,
                    stderr=asyncio.subprocess.STDOUT,
                    env=env,
                    start_new_session=True,
                ),
                kill_process_group=os.killpg,
            )
            await wait_for_process_exit(process)
            fields: dict[str, Any] = {
                "exit_code": process.returncode,
                "script": str(script_path),
                "duration_ms": int((time.time() - start_time) * 1000),
                "boot_mode": boot_mode.value,
            }
            if process.returncode == 0:
                self.log.info(f"{hook_name}.complete", **fields)
                return True
            await self._terminate(process)
            self.log.error(f"{hook_name}.failed", **fields)
            return False
        except asyncio.CancelledError:

            async def cleanup_cancelled_hook() -> None:
                if process is not None:
                    await self._terminate(process)

            cleanup = asyncio.create_task(cleanup_cancelled_hook())
            await finish_cancellation_cleanup(cleanup)
            self.log.info(
                f"{hook_name}.cancelled",
                reason="outer_operation_cancelled",
                script=str(script_path),
                boot_mode=boot_mode.value,
                duration_ms=int((time.time() - start_time) * 1000),
            )
            raise
        except Exception as error:
            if process is not None:
                await self._terminate(process)
            self.log.error(
                f"{hook_name}.error",
                exc=error,
                script=str(script_path),
                duration_ms=int((time.time() - start_time) * 1000),
                boot_mode=boot_mode.value,
            )
            return False

    async def run_setup(self, repo: RepoEntry, boot_mode: BootMode) -> bool:
        return await self._run(
            repo,
            boot_mode,
            hook_name="setup",
            relative_script_path=self.SETUP_SCRIPT_PATH,
        )

    async def run_start(self, repo: RepoEntry, boot_mode: BootMode) -> bool:
        return await self._run(
            repo,
            boot_mode,
            hook_name="start",
            relative_script_path=self.START_SCRIPT_PATH,
        )
