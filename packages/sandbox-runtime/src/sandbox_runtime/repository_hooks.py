from __future__ import annotations

import asyncio
import os
import time
from typing import TYPE_CHECKING, Any

from .process_output import communicate_owned_subprocess, terminate_owned_subprocess
from .runtime_config import BootMode

if TYPE_CHECKING:
    from .repo_config import RepoEntry


class RepositoryHooks:
    SETUP_SCRIPT_PATH = ".openinspect/setup.sh"
    START_SCRIPT_PATH = ".openinspect/start.sh"
    DEFAULT_SETUP_TIMEOUT_SECONDS = 300
    DEFAULT_START_TIMEOUT_SECONDS = 120

    def __init__(self, log: Any) -> None:
        self.log = log

    async def _terminate(self, process: asyncio.subprocess.Process) -> None:
        await terminate_owned_subprocess(process, kill_process_group=os.killpg)

    async def _communicate(self, process: asyncio.subprocess.Process) -> tuple[bytes, bytes]:
        return await communicate_owned_subprocess(process, kill_process_group=os.killpg)

    async def _run(
        self,
        repo: RepoEntry,
        boot_mode: BootMode,
        *,
        hook_name: str,
        relative_script_path: str,
        timeout_env_var: str,
        default_timeout_seconds: int,
    ) -> bool:
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
        try:
            timeout_seconds = int(os.environ.get(timeout_env_var, str(default_timeout_seconds)))
        except ValueError:
            timeout_seconds = default_timeout_seconds
        self.log.info(
            f"{hook_name}.start",
            script=str(script_path),
            repo_owner=repo.owner,
            repo_name=repo.name,
            timeout_seconds=timeout_seconds,
            boot_mode=boot_mode.value,
        )
        try:
            env = os.environ.copy()
            env["OPENINSPECT_BOOT_MODE"] = boot_mode.value
            process = await asyncio.create_subprocess_exec(
                "bash",
                str(script_path),
                cwd=repo.path,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.STDOUT,
                env=env,
                start_new_session=True,
            )
            try:
                stdout, _ = await asyncio.wait_for(
                    self._communicate(process), timeout=timeout_seconds
                )
            except TimeoutError:
                if process.returncode is None:
                    await self._terminate(process)
                stdout = await process.stdout.read() if process.stdout else b""
                fields: dict[str, object] = {
                    "timeout_seconds": timeout_seconds,
                    "script": str(script_path),
                    "duration_ms": int((time.time() - start_time) * 1000),
                    "boot_mode": boot_mode.value,
                }
                if boot_mode is not BootMode.BUILD:
                    fields["output_tail"] = "\n".join(
                        stdout.decode(errors="replace").splitlines()[-50:]
                    )
                self.log.error(f"{hook_name}.timeout", **fields)
                return False
            output_tail = "\n".join(stdout.decode(errors="replace").splitlines()[-50:])
            fields = {
                "exit_code": process.returncode,
                "script": str(script_path),
                "duration_ms": int((time.time() - start_time) * 1000),
                "boot_mode": boot_mode.value,
            }
            if process.returncode == 0:
                self.log.info(f"{hook_name}.complete", **fields)
                return True
            if boot_mode is not BootMode.BUILD:
                fields["output_tail"] = output_tail
            self.log.error(f"{hook_name}.failed", **fields)
            return False
        except Exception as error:
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
            timeout_env_var="SETUP_TIMEOUT_SECONDS",
            default_timeout_seconds=self.DEFAULT_SETUP_TIMEOUT_SECONDS,
        )

    async def run_start(self, repo: RepoEntry, boot_mode: BootMode) -> bool:
        return await self._run(
            repo,
            boot_mode,
            hook_name="start",
            relative_script_path=self.START_SCRIPT_PATH,
            timeout_env_var="START_TIMEOUT_SECONDS",
            default_timeout_seconds=self.DEFAULT_START_TIMEOUT_SECONDS,
        )
