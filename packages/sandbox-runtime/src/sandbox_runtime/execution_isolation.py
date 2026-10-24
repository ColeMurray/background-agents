"""Host checks for the privileged execution bridge / unprivileged command split."""

from __future__ import annotations

import ctypes
import json
import os
import pwd
import shutil
from pathlib import Path

from .runtime_manifest import RUNTIME_MANIFEST

_MANIFEST = json.loads(Path(__file__).with_name("execution_artifact_manifest.json").read_text())
if _MANIFEST["runtimeGeneration"] != RUNTIME_MANIFEST["generation"]:
    raise RuntimeError("Execution artifact and runtime generations disagree")
EXECUTION_USER = "openinspect-exec"
EXECUTION_UID = int(_MANIFEST["commandUid"])
EXECUTION_GID = int(_MANIFEST["commandGid"])
PR_SET_DUMPABLE = 4


class ExecutionIsolationError(RuntimeError):
    pass


_FORBIDDEN_ENV_PREFIXES = (
    "ANTHROPIC_",
    "CLAUDE_",
    "CODEX_",
    "GITHUB_",
    "GITLAB_",
    "MCP_",
    "OPENAI_",
    "VCS_",
    "XAI_",
    "OI_SCM_",
)
_FORBIDDEN_ENV_KEYS = {
    "SANDBOX_AUTH_TOKEN",
    "FROM_REPO_IMAGE",
    "RESTORED_FROM_SNAPSHOT",
    "REPO_IMAGE_SHA",
    "IMAGE_BUILD_MODE",
}


def validate_execution_environment(environment: dict[str, str]) -> None:
    forbidden = sorted(
        key
        for key in environment
        if key in _FORBIDDEN_ENV_KEYS or key.startswith(_FORBIDDEN_ENV_PREFIXES)
    )
    if forbidden:
        raise ExecutionIsolationError(
            f"Execution environment contains forbidden authority: {', '.join(forbidden)}"
        )


def validate_execution_host(
    *,
    runtime_root: Path,
    workspace: Path,
    proc_mount_options: set[str],
    ptrace_scope: int,
    command_uid: int,
    command_gid: int,
) -> None:
    if runtime_root.is_symlink() or workspace.is_symlink():
        raise ExecutionIsolationError("Execution runtime and workspace cannot be symlinks")
    if command_uid in (0, os.geteuid()) or command_gid == 0:
        raise ExecutionIsolationError("Execution commands require a dedicated unprivileged UID/GID")
    if "hidepid=2" not in proc_mount_options:
        raise ExecutionIsolationError("Execution requires /proc mounted with hidepid=2")
    if f"gid={command_gid}" in proc_mount_options:
        raise ExecutionIsolationError("Execution command group cannot bypass /proc hidepid")
    if ptrace_scope < 2:
        raise ExecutionIsolationError("Execution requires kernel.yama.ptrace_scope >= 2")
    for path in (runtime_root, *runtime_root.rglob("*")):
        if path.is_symlink():
            continue
        stat = path.stat()
        if stat.st_uid != 0 or stat.st_mode & 0o022:
            raise ExecutionIsolationError(
                "Execution runtime installation must be root-owned and command-read-only"
            )
    workspace_stat = workspace.stat()
    if workspace_stat.st_uid != command_uid or workspace_stat.st_gid != command_gid:
        raise ExecutionIsolationError("Execution workspace ownership is invalid")
    if workspace_stat.st_mode & 0o077:
        raise ExecutionIsolationError("Execution workspace permissions must be 0700")


def prepare_execution_host(
    workspace: Path,
    *,
    runtime_root: Path = Path("/opt/openinspect"),
    proc_mounts: Path = Path("/proc/mounts"),
    ptrace_scope_path: Path = Path("/proc/sys/kernel/yama/ptrace_scope"),
) -> tuple[int, int, Path]:
    if os.geteuid() != 0:
        raise ExecutionIsolationError("Execution supervisor must start as root")
    account = pwd.getpwnam(EXECUTION_USER)
    if account.pw_uid != EXECUTION_UID or account.pw_gid != EXECUTION_GID:
        raise ExecutionIsolationError("Execution command account identity is invalid")
    workspace.mkdir(parents=True, exist_ok=True)
    os.chown(workspace, EXECUTION_UID, EXECUTION_GID)
    workspace.chmod(0o700)
    _clear_execution_state(workspace, Path(account.pw_dir))
    proc_options = _proc_mount_options(proc_mounts)
    ptrace_scope = int(ptrace_scope_path.read_text().strip())
    validate_execution_host(
        runtime_root=runtime_root,
        workspace=workspace,
        proc_mount_options=proc_options,
        ptrace_scope=ptrace_scope,
        command_uid=account.pw_uid,
        command_gid=account.pw_gid,
    )
    if ctypes.CDLL(None).prctl(PR_SET_DUMPABLE, 0, 0, 0, 0) != 0:
        raise ExecutionIsolationError("Could not disable supervisor process dumping")
    return account.pw_uid, account.pw_gid, Path(account.pw_dir)


def _clear_execution_state(workspace: Path, home: Path) -> None:
    for path in (
        home / ".cache",
        home / ".npm",
        home / ".config",
        workspace / ".cache",
        workspace / ".npm",
        workspace / ".netrc",
        workspace / ".git-credentials",
        Path("/tmp/oi"),
        Path("/run/open-inspect"),
    ):
        if path.is_symlink() or path.is_file():
            path.unlink()
        elif path.is_dir():
            shutil.rmtree(path)
    cache = home / ".cache"
    cache.mkdir(parents=True, mode=0o700)
    os.chown(cache, EXECUTION_UID, EXECUTION_GID)
    Path("/run/open-inspect").mkdir(mode=0o700)


def _proc_mount_options(path: Path) -> set[str]:
    for line in path.read_text().splitlines():
        fields = line.split()
        if len(fields) >= 4 and fields[1] == "/proc":
            return set(fields[3].split(","))
    raise ExecutionIsolationError("Execution /proc mount is unavailable")
