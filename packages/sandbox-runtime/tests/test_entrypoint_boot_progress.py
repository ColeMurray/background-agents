"""Tests for the supervisor's boot-progress pings.

During boot the supervisor POSTs /sessions/{id}/boot-progress so the control
plane's connecting watchdog measures silence instead of wall-clock boot time
(cold multi-repo clones legitimately exceed any fixed deadline). Pings are
best-effort: a network error must not kill the ping loop.
"""

import asyncio
import json
from unittest.mock import patch

import httpx
import pytest

from sandbox_runtime.entrypoint import SandboxSupervisor


def _make_supervisor() -> SandboxSupervisor:
    base_env = {
        "SANDBOX_ID": "test-sandbox",
        "CONTROL_PLANE_URL": "https://cp.example.com",
        "SANDBOX_AUTH_TOKEN": "tok",
        "REPO_OWNER": "acme",
        "REPO_NAME": "app",
        "SESSION_CONFIG": json.dumps({"session_id": "session-1"}),
    }
    with patch.dict("os.environ", base_env, clear=True):
        return SandboxSupervisor()


async def _run_pings(supervisor: SandboxSupervisor, handler, ping_count: int) -> None:
    """Run the ping loop against a mock transport until ``ping_count`` requests land."""
    supervisor.BOOT_PROGRESS_INTERVAL_SECONDS = 0.01
    done = asyncio.Event()
    calls = 0

    def counting_handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        if calls >= ping_count:
            done.set()
        return handler(request)

    real_client = httpx.AsyncClient
    transport = httpx.MockTransport(counting_handler)
    with patch(
        "sandbox_runtime.entrypoint.httpx.AsyncClient",
        lambda **kwargs: real_client(transport=transport, **kwargs),
    ):
        task = asyncio.create_task(supervisor._post_boot_progress())
        try:
            await asyncio.wait_for(done.wait(), timeout=5.0)
        finally:
            task.cancel()


@pytest.mark.asyncio
async def test_pings_carry_sandbox_bearer_auth():
    supervisor = _make_supervisor()
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(200, json={"status": "ok"})

    await _run_pings(supervisor, handler, ping_count=2)

    assert len(requests) >= 2
    assert str(requests[0].url) == "https://cp.example.com/sessions/session-1/boot-progress"
    assert requests[0].method == "POST"
    assert requests[0].headers["Authorization"] == "Bearer tok"


@pytest.mark.asyncio
async def test_pings_survive_network_errors():
    supervisor = _make_supervisor()
    calls = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        if calls == 1:
            raise httpx.ConnectError("boom", request=request)
        return httpx.Response(200, json={"status": "ok"})

    # A second request arriving proves the loop outlived the first failure.
    await _run_pings(supervisor, handler, ping_count=2)


@pytest.mark.asyncio
async def test_pings_skip_without_session_context():
    base_env = {"SANDBOX_ID": "test-sandbox"}
    with patch.dict("os.environ", base_env, clear=True):
        supervisor = SandboxSupervisor()

    # No control plane URL / session id: the coroutine returns immediately.
    await asyncio.wait_for(supervisor._post_boot_progress(), timeout=1.0)
