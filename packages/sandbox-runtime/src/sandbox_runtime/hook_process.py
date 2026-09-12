"""Hook-shell observation and Linux descendant ownership.

One small subreaper belongs to each hook, not to the whole supervisor. Its
status pipe is private: only the guardian inherits it, never the hook shell.
Hook stdout/stderr remain regular files (or the explicit discard destination).
"""

from __future__ import annotations

import asyncio
import contextlib
import ctypes
import os
import signal
import subprocess
import sys
import time
from pathlib import Path

USE_SUBREAPER = sys.platform == "linux"
HOOK_PROCESS_POLL_SECONDS = 0.01
HOOK_GUARDIAN_START_TIMEOUT_SECONDS = 5.0
PR_SET_CHILD_SUBREAPER = 36


class HookCleanupError(RuntimeError):
    """Hook execution cessation is uncertain; boot must not continue."""


class GuardedHookProcess:
    """Separate the shell's exit from cessation of its complete descendant tree."""

    def __init__(self, guardian: asyncio.subprocess.Process, status_fd: int) -> None:
        self.guardian = guardian
        self.pid = guardian.pid
        self.returncode: int | None = None
        self._status_fd: int | None = status_fd
        self._status_buffer = bytearray()

    async def wait(self) -> int:
        if self.returncode is None:
            self.returncode = int(await self._read_status_line())
            self._close_status()
        return self.returncode

    async def ready(self) -> None:
        async with asyncio.timeout(HOOK_GUARDIAN_START_TIMEOUT_SECONDS):
            if await self._read_status_line() != "ready":
                raise RuntimeError("hook guardian did not establish descendant ownership")

    async def _read_status_line(self) -> str:
        while b"\n" not in self._status_buffer:
            if self._status_fd is None:
                raise RuntimeError("hook guardian did not report shell completion")
            try:
                chunk = os.read(self._status_fd, 32)
            except BlockingIOError:
                await asyncio.sleep(HOOK_PROCESS_POLL_SECONDS)
                continue
            if not chunk or len(self._status_buffer) + len(chunk) > 32:
                raise RuntimeError("hook guardian ended without valid shell-exit evidence")
            self._status_buffer.extend(chunk)
        line, _, remainder = self._status_buffer.partition(b"\n")
        self._status_buffer = bytearray(remainder)
        return line.decode("ascii")

    def _close_status(self) -> None:
        if self._status_fd is not None:
            os.close(self._status_fd)
            self._status_fd = None

    async def stop(self, timeout_seconds: float) -> None:
        # Do not SIGKILL the guardian: that would abandon its adopted children.
        # A stuck guardian retains ownership while the caller fails boot closed.
        with contextlib.suppress(ProcessLookupError):
            self.guardian.terminate()
        try:
            async with asyncio.timeout(timeout_seconds):
                exit_code = await self.guardian.wait()
            if exit_code != 0:
                raise RuntimeError(
                    f"hook guardian exited {exit_code} without confirmed descendant containment"
                )
        finally:
            if self.guardian.returncode is not None:
                self._close_status()


async def create_hook_process(
    script_path: Path,
    *,
    cwd: Path,
    stdout: int,
    env: dict[str, str],
) -> GuardedHookProcess | asyncio.subprocess.Process:
    if not USE_SUBREAPER:
        return await asyncio.create_subprocess_exec(
            "bash",
            str(script_path),
            cwd=cwd,
            stdout=stdout,
            stderr=asyncio.subprocess.STDOUT,
            env=env,
            start_new_session=True,
        )
    # Python creates non-inheritable descriptors; pass_fds below grants only
    # the guardian its write endpoint. Neither endpoint belongs to the shell.
    read_fd, write_fd = os.pipe()
    os.set_blocking(read_fd, False)
    try:
        guardian = await asyncio.create_subprocess_exec(
            sys.executable,
            "-I",
            str(Path(__file__).resolve()),
            "--status-fd",
            str(write_fd),
            "--parent-pid",
            str(os.getpid()),
            str(script_path),
            cwd=cwd,
            stdout=stdout,
            stderr=asyncio.subprocess.STDOUT,
            env=env,
            start_new_session=True,
            pass_fds=(write_fd,),
        )
    except BaseException:
        os.close(read_fd)
        raise
    finally:
        os.close(write_fd)
    process = GuardedHookProcess(guardian, read_fd)
    try:
        # Do not expose a guardian that could still have SIGTERM's default
        # disposition: immediate cancellation must request containment, not kill
        # the owner before it has established and announced its subreaper role.
        await process.ready()
    except BaseException:
        try:
            await process.stop(HOOK_GUARDIAN_START_TIMEOUT_SECONDS)
        except (TimeoutError, OSError, RuntimeError) as error:
            raise HookCleanupError(
                "hook guardian startup cleanup could not be confirmed"
            ) from error
        raise
    return process


def _run_guardian(script_path: str, status_fd: int, parent_pid: int) -> int:
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) != 0:
        raise OSError(ctypes.get_errno(), "cannot establish hook descendant ownership")
    stopping = False

    def request_stop(_signal: int, _frame: object) -> None:
        nonlocal stopping
        stopping = True

    signal.signal(signal.SIGTERM, request_stop)
    signal.signal(signal.SIGINT, request_stop)
    shell = subprocess.Popen(["bash", script_path], start_new_session=True, close_fds=True)
    os.write(status_fd, b"ready\n")
    shell_exit: int | None = None
    children_file = Path(f"/proc/self/task/{os.getpid()}/children")
    while True:
        if os.getppid() != parent_pid:
            stopping = True
        if stopping:
            # Killing direct children repeatedly adopts their surviving children
            # into this subreaper, even across setsid(), double forks, or another
            # child subreaper. PIDs cannot be reused before this owner reaps them.
            for raw_pid in children_file.read_text().split():
                with contextlib.suppress(ProcessLookupError):
                    os.kill(int(raw_pid), signal.SIGKILL)
        while True:
            try:
                child_pid, status = os.waitpid(-1, os.WNOHANG)
            except ChildProcessError:
                # ECHILD establishes that this guardian has no surviving child
                # roots, hence no descendant execution. Only this path exits 0.
                # Ignore a concurrent stop during interpreter finalization;
                # Python teardown must not turn verified containment into -TERM.
                signal.signal(signal.SIGTERM, signal.SIG_IGN)
                signal.signal(signal.SIGINT, signal.SIG_IGN)
                return 0 if shell_exit is not None else 1
            if child_pid == 0:
                break
            if child_pid == shell.pid:
                shell_exit = os.waitstatus_to_exitcode(status)
                shell.returncode = shell_exit
                try:
                    os.write(status_fd, f"{shell_exit}\n".encode("ascii"))
                except BrokenPipeError:
                    stopping = True
                finally:
                    os.close(status_fd)
                if shell_exit != 0:
                    stopping = True
        time.sleep(HOOK_PROCESS_POLL_SECONDS)


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="Own a hook shell and its descendants")
    parser.add_argument("--status-fd", type=int, required=True)
    parser.add_argument("--parent-pid", type=int, required=True)
    parser.add_argument("script")
    args = parser.parse_args()
    sys.exit(_run_guardian(args.script, args.status_fd, args.parent_pid))
