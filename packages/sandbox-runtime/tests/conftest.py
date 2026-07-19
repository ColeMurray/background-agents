"""Shared test fixtures and utilities for sandbox-runtime tests."""

from typing import TYPE_CHECKING, Any

import httpx
import pytest

from sandbox_runtime.opencode_client import OpenCodeClient

if TYPE_CHECKING:
    from sandbox_runtime.bridge import AgentBridge


@pytest.fixture(autouse=True)
def _isolated_supervisor_lock(tmp_path, monkeypatch):
    """Point the single-supervisor lock at a per-test file.

    Without this, every test that drives SandboxSupervisor.run() contends for
    the real SUPERVISOR_LOCK_FILE_PATH within one pytest process, and the
    duplicate-supervisor guard makes later tests exit early.
    """
    monkeypatch.setattr(
        "sandbox_runtime.entrypoint.SUPERVISOR_LOCK_FILE_PATH",
        str(tmp_path / "oi-supervisor.lock"),
    )


def wire_opencode_transport(bridge: "AgentBridge", http_client: Any) -> Any:
    """Point a bridge's OpenCode client at a fake HTTP transport (test seam).

    Rebuilds ``bridge.opencode_client`` around the fake, resets the lazily
    built prompt stream so it rebinds to the new client, and stashes the fake
    on ``bridge.http_client`` so tests can read it back to script responses.
    Returns the fake for convenience.
    """
    bridge.opencode_client = OpenCodeClient(
        base_url=bridge.opencode_base_url,
        log=bridge.log,
        http_client=http_client,
    )
    bridge._prompt_stream = None
    bridge.http_client = http_client
    return http_client


class MockResponse:
    """Mock HTTP response for testing."""

    def __init__(self, status_code: int, json_data: Any = None, text: str = ""):
        self.status_code = status_code
        self._json_data = json_data
        self.text = text

    def json(self) -> Any:
        return self._json_data

    def raise_for_status(self) -> None:
        if self.status_code >= 400:
            raise httpx.HTTPStatusError(
                f"HTTP {self.status_code}",
                request=httpx.Request("GET", "http://test"),
                response=httpx.Response(self.status_code),
            )
