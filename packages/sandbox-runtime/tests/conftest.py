"""Shared test fixtures and utilities for sandbox-runtime tests."""

from typing import TYPE_CHECKING, Any

import httpx
import pytest

from sandbox_runtime.opencode_client import OpenCodeClient

if TYPE_CHECKING:
    from sandbox_runtime.bridge import AgentBridge


@pytest.fixture(autouse=True)
def isolate_runtime_file_paths(tmp_path, monkeypatch):
    """Redirect the runtime's fixed file paths to per-test locations.

    This suite routinely runs inside a live Open-Inspect sandbox (agents
    dogfooding on this repo), where /tmp/oi-repo-manifest.json is the running
    session's real manifest. A test that drives a real SandboxSupervisor
    (e.g. ``await sup.run()``) would otherwise overwrite it with fixture
    repos, which breaks push targeting and PR creation for the live session —
    and likewise delete the live boot-warnings file or read the live
    tunnel-env file. Tests that care about a specific path still patch it
    themselves; this fixture is the backstop that keeps every other test off
    the real files.
    """
    manifest_path = str(tmp_path / "oi-repo-manifest.json")
    boot_warnings_path = str(tmp_path / "oi-boot-warnings.jsonl")
    tunnel_env_path = str(tmp_path / ".tunnels.env")
    monkeypatch.setattr("sandbox_runtime.entrypoint.REPO_MANIFEST_FILE_PATH", manifest_path)
    monkeypatch.setattr("sandbox_runtime.bridge.REPO_MANIFEST_FILE_PATH", manifest_path)
    monkeypatch.setattr("sandbox_runtime.entrypoint.BOOT_WARNINGS_FILE_PATH", boot_warnings_path)
    monkeypatch.setattr("sandbox_runtime.bridge.BOOT_WARNINGS_FILE_PATH", boot_warnings_path)
    monkeypatch.setattr("sandbox_runtime.entrypoint.TUNNEL_ENV_FILE_PATH", tunnel_env_path)


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
