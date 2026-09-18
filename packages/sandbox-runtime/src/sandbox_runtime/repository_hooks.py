from __future__ import annotations

import asyncio
import os
import time
from typing import TYPE_CHECKING, Any

from .boot_events import OUTPUT_TAIL_MAX_LINES, bounded_output_tail, secret_values
from .process_output import (
    BoundedOutputCollector,
    finish_cancellation_cleanup,
    spawn_owned_subprocess,
    terminate_owned_subprocess,
    wait_for_process_exit,
)
from .runtime_config import BootMode

if TYPE_CHECKING:
    from .repo_config import RepoEntry


class RepositoryHooks:
    SETUP_SCRIPT_PATH = ".openinspect/setup.sh"
    START_SCRIPT_PATH = ".openinspect/start.sh"

    def __init__(self, log: Any) -> None:
        self.log = log
        self._output_collectors: set[BoundedOutputCollector] = set()
        # The bounded, redacted tail of each hook's most recent failed run,
        # keyed by repository and hook; cleared by a later success. Read by
        # the boot when a failure is fatal so the report can carry it.
        self._failure_tails: dict[tuple[str, str, str], tuple[str, ...]] = {}

    def failure_tail(self, repo: RepoEntry, hook_name: str) -> tuple[str, ...]:
        """Output tail of the hook's most recent failed run, empty if it succeeded."""
        return self._failure_tails.get((repo.owner, repo.name, hook_name), ())

    def _collect_output(self, process: asyncio.subprocess.Process) -> BoundedOutputCollector:
        if process.stdout is None:
            raise RuntimeError("hook process output pipe was not created")
        collector = BoundedOutputCollector(process.stdout)
        self._output_collectors.add(collector)
        collector.task.add_done_callback(lambda _task: self._output_collectors.discard(collector))
        return collector

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
        output: BoundedOutputCollector | None = None
        try:
            env = os.environ.copy()
            env["OPENINSPECT_BOOT_MODE"] = boot_mode.value
            process = await spawn_owned_subprocess(
                asyncio.create_subprocess_exec(
                    "bash",
                    str(script_path),
                    cwd=repo.path,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.STDOUT,
                    env=env,
                    start_new_session=True,
                ),
                kill_process_group=os.killpg,
            )
            output = self._collect_output(process)
            await wait_for_process_exit(process)
            fields = {
                "exit_code": process.returncode,
                "script": str(script_path),
                "duration_ms": int((time.time() - start_time) * 1000),
                "boot_mode": boot_mode.value,
            }
            tail_key = (repo.owner, repo.name, hook_name)
            if process.returncode == 0:
                output.discard_tail()
                self._failure_tails.pop(tail_key, None)
                self.log.info(f"{hook_name}.complete", **fields)
                return True
            await self._terminate(process)
            await output.shutdown()
            if boot_mode is not BootMode.BUILD:
                raw_tail = output.tail_lines(OUTPUT_TAIL_MAX_LINES)
                fields["output_tail"] = raw_tail
                self._failure_tails[tail_key] = tuple(
                    bounded_output_tail(raw_tail, secrets=secret_values(env))
                )
            self.log.error(f"{hook_name}.failed", **fields)
            return False
        except asyncio.CancelledError:

            async def cleanup_cancelled_hook() -> None:
                if process is not None:
                    await self._terminate(process)
                if output is not None:
                    await output.shutdown()

            cleanup = asyncio.create_task(cleanup_cancelled_hook())
            await finish_cancellation_cleanup(cleanup)
            if output is not None:
                output.discard_tail()
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
            if output is not None:
                await output.shutdown()
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
