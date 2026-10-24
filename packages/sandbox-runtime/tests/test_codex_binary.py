import asyncio
import os
from unittest.mock import AsyncMock, MagicMock

import pytest

from sandbox_runtime.harness.base import HarnessStartError, PromptLimits
from sandbox_runtime.harness.codex import CodexHarness, CodexHarnessConfig
from sandbox_runtime.harness.codex import env as codex_env
from sandbox_runtime.harness.codex.env import CODEX_VERSION, verify_codex_binary


def fake_binary(tmp_path, body):
    path = tmp_path / "codex"
    path.write_text(f"#!/bin/sh\n{body}\n")
    path.chmod(0o755)
    return str(path)


def test_launches_the_pinned_install_not_a_substrate_link():
    assert codex_env.CODEX_BINARY == "/opt/openinspect/codex/bin/codex"


async def test_pinned_version_is_accepted(tmp_path):
    await verify_codex_binary(fake_binary(tmp_path, f"echo 'codex-cli {CODEX_VERSION}'"))


async def test_missing_binary_asks_for_an_image_rebuild(tmp_path):
    with pytest.raises(HarnessStartError, match="rebuild the sandbox image"):
        await verify_codex_binary(str(tmp_path / "absent"))


@pytest.mark.parametrize(
    "body",
    [
        "echo 'codex-cli 0.1.0'",
        f"echo 'codex-cli {CODEX_VERSION}'; exit 1",
        f"echo 'codex-cli {CODEX_VERSION}-boat'",
        "echo unexpected",
    ],
)
async def test_unpinned_binary_asks_for_an_image_rebuild(tmp_path, body):
    with pytest.raises(HarnessStartError, match="rebuild the sandbox image"):
        await verify_codex_binary(fake_binary(tmp_path, body))


def hanging_binary(tmp_path):
    pid_file = tmp_path / "pid"
    return fake_binary(tmp_path, f"echo $$ > {pid_file}; exec sleep 30"), pid_file


def assert_reaped(pid_file):
    with pytest.raises(ProcessLookupError):
        os.kill(int(pid_file.read_text()), 0)


async def test_hung_binary_is_killed(tmp_path, monkeypatch):
    monkeypatch.setattr(codex_env, "CODEX_VERSION_TIMEOUT_SECONDS", 0.1)
    binary, pid_file = hanging_binary(tmp_path)
    with pytest.raises(HarnessStartError, match="did not report its version"):
        await verify_codex_binary(binary)
    assert_reaped(pid_file)


async def test_cancelled_check_kills_its_process(tmp_path):
    binary, pid_file = hanging_binary(tmp_path)
    task = asyncio.create_task(verify_codex_binary(binary))
    while not pid_file.exists() or not pid_file.read_text():
        await asyncio.sleep(0.01)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert_reaped(pid_file)


def build(tmp_path, verify_binary):
    client = MagicMock()
    client.running = True
    client.open = AsyncMock()
    client.close = AsyncMock(return_value=True)
    client.notify = AsyncMock()
    client.request = AsyncMock(return_value={"account": {"type": "apiKey"}})
    harness = CodexHarness(
        config=CodexHarnessConfig(tmp_path, tmp_path / "native", "gpt-6.1-sol", False),
        log=MagicMock(),
        limits=PromptLimits(1, 30, 5),
        client_factory=MagicMock(return_value=client),
        environ={"OPENAI_API_KEY": "fixture"},
        verify_binary=verify_binary,
    )
    return harness, client


async def test_rejected_binary_is_never_launched(tmp_path):
    verify = AsyncMock(side_effect=HarnessStartError("rebuild the sandbox image"))
    harness, client = build(tmp_path, verify)
    with pytest.raises(HarnessStartError, match="rebuild the sandbox image"):
        await harness.open()
    harness._factory.assert_not_called()
    client.open.assert_not_called()


async def test_stop_during_verification_prevents_the_launch(tmp_path):
    async def stopped_while_verifying():
        assert await harness.stop_execution(1)

    harness, _ = build(tmp_path, AsyncMock(side_effect=stopped_while_verifying))
    with pytest.raises(HarnessStartError, match="stopped while starting"):
        await harness.open()
    harness._factory.assert_not_called()


async def test_binary_is_verified_once_per_harness(tmp_path):
    verify = AsyncMock()
    harness, client = build(tmp_path, verify)
    await harness.open()
    client.running = False
    await harness.open()
    assert harness._factory.call_count == 2
    verify.assert_awaited_once()
    await harness.close()
