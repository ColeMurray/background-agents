"""Behavior checks for the offline native Docker qualification gate."""

import asyncio
import importlib.util
import runpy
import sys
from pathlib import Path
from types import ModuleType, SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest

runtime_package = ModuleType("sandbox_runtime")
runtime_package.__path__ = []
runtime_module_names = (
    "sandbox_runtime",
    "sandbox_runtime.docker_service",
    "sandbox_runtime.process_output",
)
original_runtime_modules = {name: sys.modules.get(name) for name in runtime_module_names}
sys.modules.setdefault("sandbox_runtime", runtime_package)
sys.modules.setdefault("sandbox_runtime.docker_service", SimpleNamespace(DockerService=Mock()))
process_output_path = (
    Path(__file__).parents[2] / "sandbox-runtime/src/sandbox_runtime/process_output.py"
)
process_output_spec = importlib.util.spec_from_file_location(
    "sandbox_runtime.process_output", process_output_path
)
assert process_output_spec is not None and process_output_spec.loader is not None
process_output = importlib.util.module_from_spec(process_output_spec)
sys.modules["sandbox_runtime.process_output"] = process_output
process_output_spec.loader.exec_module(process_output)
docker_verification = runpy.run_path(str(Path(__file__).parents[1] / "verify/docker_smoke.py"))
for module_name, original_module in original_runtime_modules.items():
    if original_module is None:
        sys.modules.pop(module_name, None)
    else:
        sys.modules[module_name] = original_module


class FakeService:
    def __init__(self) -> None:
        self.start = AsyncMock()
        self.prepare_for_snapshot = AsyncMock()
        self.stop = AsyncMock()


def test_qualifies_container_buildx_and_compose_without_a_registry(monkeypatch):
    commands = []
    service = FakeService()

    async def fake_run(*command, **kwargs):
        commands.append(command)
        if command[1:3] == ("info", "--format"):
            return b"overlay2\n"
        if command[1] == "run":
            return b"compose-network-ok"
        return b""

    monkeypatch.setitem(
        docker_verification["main"].__globals__, "DockerService", lambda _log: service
    )
    monkeypatch.setitem(docker_verification["main"].__globals__, "run_command", fake_run)

    asyncio.run(docker_verification["main"]())

    assert any(command[1] == "import" for command in commands)
    assert any(
        command[1:3] == ("buildx", "build") and "--pull=false" in command and "--load" in command
        for command in commands
    )
    assert any(command[1] == "run" and "--pull=never" in command for command in commands)
    assert any(
        command[1:3] == ("compose", "--project-name") and "up" in command for command in commands
    )
    assert any(
        command[1:3] == ("compose", "--project-name") and "down" in command for command in commands
    )
    assert all(command[1] != "pull" for command in commands)
    service.prepare_for_snapshot.assert_awaited_once()
    service.stop.assert_awaited_once()


@pytest.mark.parametrize("failure_command", ["import", "buildx", "run", "compose"])
def test_failure_cleans_resources_and_stops_service_without_preparing_snapshot(
    monkeypatch, failure_command
):
    commands = []
    service = FakeService()

    async def fake_run(*command, **kwargs):
        commands.append(command)
        if command[1] == "info":
            return b"overlay2\n"
        if command[1] == failure_command or (
            failure_command == "compose" and command[1] == "compose" and "up" in command
        ):
            raise RuntimeError("qualification failed")
        if command[1] == "run":
            return b"compose-network-ok"
        return b""

    monkeypatch.setitem(
        docker_verification["main"].__globals__, "DockerService", lambda _log: service
    )
    monkeypatch.setitem(docker_verification["main"].__globals__, "run_command", fake_run)

    with pytest.raises(RuntimeError, match="qualification failed"):
        asyncio.run(docker_verification["main"]())

    assert any(command[1] == "compose" and "down" in command for command in commands)
    assert any(command[1:3] == ("rm", "--force") for command in commands)
    assert any(command[1:4] == ("image", "rm", "--force") for command in commands)
    service.prepare_for_snapshot.assert_not_awaited()
    service.stop.assert_awaited_once()


def test_command_timeout_terminates_child(monkeypatch):
    async def never_finishes():
        await asyncio.sleep(60)

    process = SimpleNamespace(
        returncode=None,
        communicate=AsyncMock(side_effect=never_finishes),
        terminate=Mock(),
        kill=Mock(),
        wait=AsyncMock(return_value=0),
    )
    create = AsyncMock(return_value=process)
    monkeypatch.setattr(asyncio, "create_subprocess_exec", create)
    monkeypatch.setitem(
        docker_verification["run_command"].__globals__, "COMMAND_TIMEOUT_SECONDS", 0.001
    )

    with pytest.raises(TimeoutError):
        asyncio.run(docker_verification["run_command"]("docker", "info"))

    process.terminate.assert_called_once()
    assert process.wait.await_count >= 1


def test_nonzero_command_exit_is_a_verification_failure(monkeypatch):
    process = SimpleNamespace(
        returncode=1,
        communicate=AsyncMock(return_value=(b"", b"")),
    )
    monkeypatch.setattr(asyncio, "create_subprocess_exec", AsyncMock(return_value=process))

    with pytest.raises(RuntimeError, match="Docker verification command failed: info"):
        asyncio.run(docker_verification["run_command"]("docker", "info"))


def test_required_cleanup_failure_blocks_qualification(monkeypatch, tmp_path):
    attempted = []

    async def fake_run(*command, check=True, **_kwargs):
        attempted.append(command)
        if "down" in command and check:
            raise RuntimeError("cleanup failed")
        return b""

    monkeypatch.setitem(docker_verification["_cleanup"].__globals__, "run_command", fake_run)

    with pytest.raises(RuntimeError, match="cleanup failed"):
        asyncio.run(
            docker_verification["_cleanup"](tmp_path / "compose.yaml", preserve_primary_error=False)
        )

    assert len(attempted) == 3
