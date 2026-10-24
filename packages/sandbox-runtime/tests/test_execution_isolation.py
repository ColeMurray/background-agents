import io
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from sandbox_runtime.agent_bridge_process import AgentBridgeProcess
from sandbox_runtime.command_runner import CommandIdentity, CommandRunner
from sandbox_runtime.execution_auth import read_execution_auth_token
from sandbox_runtime.execution_isolation import (
    EXECUTION_GID,
    EXECUTION_UID,
    ExecutionIsolationError,
    validate_execution_environment,
    validate_execution_host,
)
from sandbox_runtime.runtime_config import BridgeProcessConfig, RuntimeMode


def test_execution_auth_is_bounded_and_never_uses_environment(monkeypatch):
    monkeypatch.setenv("SANDBOX_AUTH_TOKEN", "ambient-secret")

    assert read_execution_auth_token(io.BytesIO(b"execution-token\n")) == "execution-token"
    with pytest.raises(ValueError, match="too large"):
        read_execution_auth_token(io.BytesIO(b"x" * 4097))
    with pytest.raises(ValueError, match="newline"):
        read_execution_auth_token(io.BytesIO(b"unterminated"))


def test_execution_host_requires_proc_and_ptrace_isolation(tmp_path: Path):
    runtime = tmp_path / "runtime"
    workspace = tmp_path / "workspace"
    runtime.mkdir(mode=0o755)
    workspace.mkdir(mode=0o700)

    real_stat = type(runtime).stat

    def isolated_stat(path: Path, **kwargs):
        stat = real_stat(path, **kwargs)
        runtime_entry = path == runtime or runtime in path.parents
        return SimpleNamespace(
            st_mode=stat.st_mode,
            st_uid=0 if runtime_entry else EXECUTION_UID,
            st_gid=EXECUTION_GID if path == workspace else stat.st_gid,
        )

    with patch.object(type(runtime), "stat", isolated_stat):
        validate_execution_host(
            runtime_root=runtime,
            workspace=workspace,
            proc_mount_options={"rw", "hidepid=2"},
            ptrace_scope=2,
            command_uid=EXECUTION_UID,
            command_gid=EXECUTION_GID,
        )
        with pytest.raises(ExecutionIsolationError, match="hidepid=2"):
            validate_execution_host(
                runtime_root=runtime,
                workspace=workspace,
                proc_mount_options={"rw"},
                ptrace_scope=2,
                command_uid=EXECUTION_UID,
                command_gid=EXECUTION_GID,
            )
        with pytest.raises(ExecutionIsolationError, match="ptrace_scope"):
            validate_execution_host(
                runtime_root=runtime,
                workspace=workspace,
                proc_mount_options={"rw", "hidepid=2"},
                ptrace_scope=1,
                command_uid=EXECUTION_UID,
                command_gid=EXECUTION_GID,
            )
        with pytest.raises(ExecutionIsolationError, match="cannot bypass"):
            validate_execution_host(
                runtime_root=runtime,
                workspace=workspace,
                proc_mount_options={"rw", "hidepid=2", f"gid={EXECUTION_GID}"},
                ptrace_scope=2,
                command_uid=EXECUTION_UID,
                command_gid=EXECUTION_GID,
            )


def test_execution_environment_rejects_tokens_images_and_provider_authority():
    validate_execution_environment({"PATH": "/usr/bin", "SANDBOX_VERSION": "v78"})
    for key in (
        "SANDBOX_AUTH_TOKEN",
        "OPENAI_API_KEY",
        "XAI_API_KEY",
        "GITHUB_TOKEN",
        "VCS_CLONE_TOKEN",
        "MCP_SERVER_TOKEN",
        "RESTORED_FROM_SNAPSHOT",
        "FROM_REPO_IMAGE",
    ):
        with pytest.raises(ExecutionIsolationError, match=key):
            validate_execution_environment({key: "secret"})


@pytest.mark.asyncio
async def test_commands_drop_to_dedicated_identity_and_receive_no_bridge_secrets(tmp_path: Path):
    emit = AsyncMock()
    process = MagicMock(pid=123, returncode=0)
    process.stdout = None
    process.stderr = None
    process.wait = AsyncMock(return_value=0)
    runner = CommandRunner(
        tmp_path,
        emit,
        MagicMock(),
        environment={
            "PATH": "/usr/bin:/bin",
            "HOME": "/root",
            "SANDBOX_AUTH_TOKEN": "secret",
            "OPENAI_API_KEY": "secret",
        },
        identity=CommandIdentity(uid=EXECUTION_UID, gid=EXECUTION_GID, home=tmp_path),
    )

    with patch("asyncio.create_subprocess_exec", AsyncMock(return_value=process)) as spawn:
        await runner.execute(
            {
                "type": "command_execute",
                "effect": "sandbox_execution",
                "commandId": "cmd-isolated",
                "purpose": "test",
                "argv": ["python", "-c", "print('ok')"],
                "cwd": str(tmp_path),
                "timeoutMs": 1_000,
            }
        )

    kwargs = spawn.await_args.kwargs
    assert kwargs["user"] == EXECUTION_UID
    assert kwargs["group"] == EXECUTION_GID
    assert kwargs["extra_groups"] == []
    assert kwargs["env"] == {
        "HOME": str(tmp_path),
        "LOGNAME": "openinspect-exec",
        "PATH": "/usr/bin:/bin",
        "USER": "openinspect-exec",
    }
    assert "secret" not in repr(spawn.await_args)


def test_command_user_cannot_read_supervisor_or_cache_files(tmp_path: Path):
    supervisor = tmp_path / "supervisor"
    cache = tmp_path / "credential-cache"
    supervisor.write_text("bridge-state")
    cache.write_text("credential")
    supervisor.chmod(0o600)
    cache.chmod(0o600)

    assert supervisor.stat().st_mode & 0o077 == 0
    assert cache.stat().st_mode & 0o077 == 0


@pytest.mark.asyncio
async def test_legacy_subprocess_bridge_refuses_execution_tokens_in_argv():
    process = AgentBridgeProcess(
        BridgeProcessConfig(
            sandbox_id="sandbox-1",
            control_plane_url="https://control.example",
            sandbox_token="must-not-enter-argv",
            session_id="session-1",
            runtime_mode=RuntimeMode.EXECUTION,
            harness=None,
        ),
        MagicMock(),
    )

    with pytest.raises(RuntimeError, match="in-process bridge"):
        await process.start()
