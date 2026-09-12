from __future__ import annotations

import asyncio
import contextlib
import os
import signal
import time
from pathlib import Path
from typing import TYPE_CHECKING, Any

from .hook_logs import HookLogs
from .hook_process import GuardedHookProcess, HookCleanupError, create_hook_process
from .runtime_config import BootMode

if TYPE_CHECKING:
    from .repo_config import RepoEntry


HOOK_CLEANUP_TIMEOUT_SECONDS = 5.0
HOOK_CLEANUP_POLL_SECONDS = 0.05


def _group_running(process_group_id: int) -> bool:
    try:
        os.killpg(process_group_id, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        # Some hosts briefly return EPERM while an orphaned group is reaped.
        # This is uncertainty, never evidence of cessation; retry within budget.
        return True
    # Orphan zombies cannot execute but may persist under container PID 1.
    # Do not make their reaping a prerequisite for stopping active work.
    proc_root = Path("/proc")
    if proc_root.is_dir():
        for entry in proc_root.iterdir():
            if not entry.name.isdigit():
                continue
            try:
                fields = (entry / "stat").read_text().rsplit(")", 1)[1].split()
                if int(fields[2]) == process_group_id and fields[0] not in ("Z", "X"):
                    return True
            except FileNotFoundError:
                continue
        return False
    return True


class RepositoryHooks:
    SETUP_SCRIPT_PATH = ".openinspect/setup.sh"
    START_SCRIPT_PATH = ".openinspect/start.sh"
    DEFAULT_SETUP_TIMEOUT_SECONDS = 300
    DEFAULT_START_TIMEOUT_SECONDS = 120

    def __init__(self, log: Any) -> None:
        self.log = log
        self.logs: HookLogs | None = None
        self._processes: set[asyncio.subprocess.Process | GuardedHookProcess] = set()

    async def _terminate(self, process: asyncio.subprocess.Process | GuardedHookProcess) -> None:
        """Kill the owned group, even when its launcher already exited."""
        try:
            if isinstance(process, GuardedHookProcess):
                await process.stop(HOOK_CLEANUP_TIMEOUT_SECONDS)
                self._processes.discard(process)
                return
            async with asyncio.timeout(HOOK_CLEANUP_TIMEOUT_SECONDS):
                if isinstance(process.pid, int):
                    with contextlib.suppress(ProcessLookupError, PermissionError):
                        os.killpg(process.pid, signal.SIGKILL)
                elif process.returncode is None:
                    process.kill()
                await process.wait()
                if isinstance(process.pid, int):
                    while _group_running(process.pid):
                        with contextlib.suppress(ProcessLookupError, PermissionError):
                            os.killpg(process.pid, signal.SIGKILL)
                        await asyncio.sleep(HOOK_CLEANUP_POLL_SECONDS)
        except (TimeoutError, OSError, RuntimeError) as error:
            raise HookCleanupError(
                "hook execution cleanup could not be confirmed; repository boot stopped"
            ) from error
        self._processes.discard(process)

    async def discard_logs(self) -> None:
        if self.logs:
            await self.logs.discard()
        os.environ.pop("OPENINSPECT_HOOK_LOG_DIR", None)

    async def shutdown(self) -> None:
        try:
            outcomes = await asyncio.gather(
                *(self._terminate(process) for process in tuple(self._processes)),
                return_exceptions=True,
            )
        finally:
            if self.logs:
                await self.logs.close()
            os.environ.pop("OPENINSPECT_HOOK_LOG_DIR", None)
        for outcome in outcomes:
            if isinstance(outcome, BaseException):
                raise outcome

    def diagnostic_context(self) -> str:
        if self.logs is None:
            return ""
        return (
            f"Repository hook diagnostics for this boot: {self.logs.path}/<encoded-owner>/<repo-name>/"
            "setup.log and start.log (only for hooks that ran). These are private, "
            "best-effort bounded logs, discarded before snapshots. A successful launcher "
            "exit does not establish background service health."
        )

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
        start_time = time.monotonic()
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
            timeout_source = timeout_env_var if timeout_env_var in os.environ else "default"
        except ValueError:
            timeout_seconds = default_timeout_seconds
            timeout_source = "default"
        self.log.info(
            f"{hook_name}.start",
            script=str(script_path),
            repo_owner=repo.owner,
            repo_name=repo.name,
            timeout_seconds=timeout_seconds,
            setting_source=timeout_source,
            boot_mode=boot_mode.value,
        )
        process: asyncio.subprocess.Process | GuardedHookProcess | None = None
        try:
            output_policy = os.environ.get("HOOK_LOG_MODE", "file")
            if output_policy not in ("file", "discard"):
                raise ValueError("HOOK_LOG_MODE must be file or discard")
            # Memory checkpoints can retain live writers and their unlinked
            # descriptors. Until a provider can exclude those, discard raw
            # runtime output explicitly. Build snapshots remain filesystem-only.
            if boot_mode is BootMode.BUILD:
                output_policy = "file"
            log_fields: dict[str, object] = {"output_policy": output_policy}
            if output_policy == "file":
                if self.logs is None:
                    self.logs = HookLogs(repo.path.parent, self.log)
                log_path, log_fd = self.logs.open(repo.owner, repo.name, hook_name)
                os.environ["OPENINSPECT_HOOK_LOG_DIR"] = str(self.logs.path)
                log_fields.update(log_path=str(log_path), boot_id=self.logs.boot_id)
            else:
                log_fd = asyncio.subprocess.DEVNULL
                os.environ.pop("OPENINSPECT_HOOK_LOG_DIR", None)
            env = os.environ.copy()
            env["OPENINSPECT_BOOT_MODE"] = boot_mode.value
            spawn_task = asyncio.create_task(
                create_hook_process(
                    script_path,
                    cwd=repo.path,
                    stdout=log_fd,
                    env=env,
                )
            )
            try:
                process = await asyncio.shield(spawn_task)
            except asyncio.CancelledError:
                # Keep ownership if cancellation races OS process creation.
                process = await spawn_task
                self._processes.add(process)
                raise
            self._processes.add(process)
            self.log.info(f"{hook_name}.log", **log_fields)
            try:
                await asyncio.wait_for(process.wait(), timeout=timeout_seconds)
            except TimeoutError:
                await self._terminate(process)
                fields: dict[str, object] = {
                    "timeout_seconds": timeout_seconds,
                    "script": str(script_path),
                    "duration_ms": int((time.monotonic() - start_time) * 1000),
                    "boot_mode": boot_mode.value,
                    "setting_source": timeout_source,
                    "cleanup_outcome": "descendants_stopped"
                    if isinstance(process, GuardedHookProcess)
                    else "process_group_stopped",
                    **log_fields,
                }
                self.log.error(f"{hook_name}.timeout", **fields)
                return False
            if self.logs:
                self.logs.trim()
            fields = {
                "exit_code": process.returncode,
                "script": str(script_path),
                "duration_ms": int((time.monotonic() - start_time) * 1000),
                "boot_mode": boot_mode.value,
                **log_fields,
            }
            if process.returncode == 0:
                self.log.info(f"{hook_name}.complete", **fields)
                return True
            await self._terminate(process)
            fields["cleanup_outcome"] = (
                "descendants_stopped"
                if isinstance(process, GuardedHookProcess)
                else "process_group_stopped"
            )
            self.log.error(f"{hook_name}.failed", **fields)
            return False
        except asyncio.CancelledError:
            if process is not None:
                cleanup = asyncio.create_task(self._terminate(process))
                try:
                    await asyncio.shield(cleanup)
                except asyncio.CancelledError:
                    await cleanup
                self.log.info(
                    f"{hook_name}.cancelled",
                    reason="outer_operation_cancelled",
                    script=str(script_path),
                    boot_mode=boot_mode.value,
                    timeout_seconds=timeout_seconds,
                    setting_source=timeout_source,
                    duration_ms=int((time.monotonic() - start_time) * 1000),
                    cleanup_outcome="descendants_stopped"
                    if isinstance(process, GuardedHookProcess)
                    else "process_group_stopped",
                )
            raise
        except HookCleanupError:
            raise
        except Exception as error:
            if process is not None:
                await self._terminate(process)
            self.log.error(
                f"{hook_name}.error",
                exc=error,
                script=str(script_path),
                duration_ms=int((time.monotonic() - start_time) * 1000),
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
