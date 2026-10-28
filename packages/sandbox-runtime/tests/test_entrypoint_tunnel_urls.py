"""Tests for RepositoryBoot tunnel-env-file handling.

RepositoryBoot owns the tunnel env file lifecycle from inside the sandbox:
- at boot, keeps a file the manager already wrote for THIS sandbox (the
  manager's write can land before the entrypoint runs) and clears anything
  else as a snapshot/image leftover
- blocks `start.sh` until fresh URLs are visible, fetching them from the
  control plane when the manager's file write is not visible (bounded)
"""

import asyncio
import json
import shlex
from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import pytest

from sandbox_runtime.constants import (
    EXPECTED_TUNNEL_PORTS_ENV_VAR,
    TUNNEL_ENV_FILE_PATH,
    TUNNEL_ENV_SANDBOX_ID_KEY,
)
from sandbox_runtime.entrypoint import build_supervisor
from sandbox_runtime.repository_boot import RepositoryBoot
from sandbox_runtime.repository_sync import (
    RepositorySyncOutcome,
    RepositorySyncResult,
    RepositorySyncStatus,
)
from sandbox_runtime.runtime_config import BootMode
from sandbox_runtime.tunnel_environment import MAX_TUNNEL_RESPONSE_BYTES, TunnelEnvironment
from tests.runtime_helpers import make_repository_boot, make_runtime_config


def _make_repository_boot() -> RepositoryBoot:
    """Create a RepositoryBoot with minimal stable env.

    Env vars read live (like EXPECTED_TUNNEL_PORTS) must be patched in the test
    body, not here — this helper only stabilizes the constructor.
    """
    base_env = {
        "SANDBOX_ID": "test-sandbox",
        "CONTROL_PLANE_URL": "https://cp.example.com",
        "SANDBOX_AUTH_TOKEN": "tok",
        "REPO_OWNER": "acme",
        "REPO_NAME": "app",
    }
    with patch.dict("os.environ", base_env, clear=True):
        return make_repository_boot()


@pytest.mark.parametrize("boot_mode", [BootMode.SNAPSHOT_RESTORE, BootMode.REPO_IMAGE])
async def test_restored_start_hook_sources_tunnels_without_modal_file_write(
    tmp_path, monkeypatch, boot_mode
):
    """Only the control-plane response reaches the restored filesystem."""
    tunnel_file = tmp_path / ".tunnels.env"
    tunnel_file.write_text(
        f"{TUNNEL_ENV_SANDBOX_ID_KEY}=previous-sandbox\nTUNNEL_3000=https://stale.example.com\n"
    )
    monkeypatch.setenv(EXPECTED_TUNNEL_PORTS_ENV_VAR, "3000,5173")
    monkeypatch.setenv("TUNNEL_WAIT_TIMEOUT_SECONDS", "0.1")
    monkeypatch.setattr("sandbox_runtime.tunnel_environment.TUNNEL_ENV_FILE_PATH", str(tunnel_file))
    config = make_runtime_config(
        {
            "SANDBOX_ID": "restored-sandbox",
            "REPO_OWNER": "acme",
            "REPO_NAME": "app",
            "CONTROL_PLANE_URL": "https://cp.example.com/",
            "SANDBOX_AUTH_TOKEN": "test-token",
            "SESSION_CONFIG": json.dumps({"session_id": "session-123"}),
        },
        workspace_path=tmp_path,
    )
    with patch("sandbox_runtime.entrypoint.RuntimeConfig.from_env", return_value=config):
        boot = build_supervisor(asyncio.Event()).repository_boot
    boot.synchronizer.ensure_credentials_configured = AsyncMock()
    boot.synchronizer.sync = AsyncMock(
        return_value=RepositorySyncResult(
            tuple(boot.repositories),
            tuple(
                RepositorySyncOutcome(repo, RepositorySyncStatus.SUCCEEDED)
                for repo in boot.repositories
            ),
        )
    )
    boot.tunnel_environment.WAIT_POLL_INTERVAL_SECONDS = 0.01
    hook_path = tmp_path / "app/.openinspect/start.sh"
    hook_path.parent.mkdir(parents=True)
    hook_path.write_text(
        f"set -eu\nsource {shlex.quote(str(tunnel_file))}\n"
        f'test "${TUNNEL_ENV_SANDBOX_ID_KEY}" = restored-sandbox\n'
        "test \"$TUNNEL_3000\" = 'https://fresh.example.com/?one=1&two=2'\n"
        'test "$TUNNEL_5173" = https://other.example.com\n'
    )
    requests = []

    def handle(request):
        requests.append(request)
        assert request.method == "GET"
        assert str(request.url) == "https://cp.example.com/sessions/session-123/tunnel-urls"
        assert request.headers["Authorization"] == "Bearer test-token"
        return httpx.Response(
            200,
            json={
                "tunnelUrls": {
                    "3000": "https://fresh.example.com/?one=1&two=2",
                    "5173": "https://other.example.com",
                }
            },
        )

    ports = boot.prepare_tunnel_environment(boot_mode)
    assert not tunnel_file.exists()
    original_client = httpx.AsyncClient

    def client_factory(**kwargs):
        return original_client(**{**kwargs, "transport": httpx.MockTransport(handle)})

    with patch("httpx.AsyncClient", client_factory):
        result = await boot.boot(boot_mode, ports)

    assert result.start_success is True
    assert len(requests) == 1


@pytest.fixture
def recovery_environment(monkeypatch):
    monkeypatch.setenv("TUNNEL_WAIT_TIMEOUT_SECONDS", "0.05")

    def make(handler, **overrides):
        environment = TunnelEnvironment(
            "test-sandbox",
            MagicMock(),
            **{
                "control_plane_url": "https://cp.example.com",
                "session_id": "session-123",
                "sandbox_token": "test-token",
                "transport": httpx.MockTransport(handler),
                **overrides,
            },
        )
        environment.WAIT_POLL_INTERVAL_SECONDS = 0.005
        return environment

    return make


async def test_recovery_retries_empty_and_partial_maps(recovery_environment, tmp_path):
    responses = iter(
        [
            {},
            {"3000": "https://fresh.example.com"},
            {
                "3000": "https://fresh.example.com",
                "5173": "https://other.example.com",
                "9999": "https://unrequested.example.com",
            },
        ]
    )
    requests = []

    def handle(request):
        requests.append(request)
        assert not (tmp_path / ".tunnels.env").exists()
        return httpx.Response(200, json={"tunnelUrls": next(responses)})

    environment = recovery_environment(handle)
    environment.FETCH_RETRY_INTERVAL_SECONDS = 0.005
    assert await environment.wait_until_ready([3000, 5173]) is True
    assert len(requests) == 3
    assert (tmp_path / ".tunnels.env").read_text().splitlines() == [
        f"{TUNNEL_ENV_SANDBOX_ID_KEY}=test-sandbox",
        "TUNNEL_3000=https://fresh.example.com",
        "TUNNEL_5173=https://other.example.com",
    ]


async def test_recovery_spaces_remote_fetches_while_urls_are_unavailable(recovery_environment):
    handler = MagicMock(return_value=httpx.Response(200, json={"tunnelUrls": {}}))
    environment = recovery_environment(handler)

    assert await environment.wait_until_ready([3000]) is False
    assert handler.call_count == 1


async def test_recovery_keeps_polling_local_file_between_remote_fetches(
    recovery_environment, tmp_path, monkeypatch
):
    monkeypatch.setenv("TUNNEL_WAIT_TIMEOUT_SECONDS", "1")
    handler = MagicMock(return_value=httpx.Response(200, json={"tunnelUrls": {}}))
    environment = recovery_environment(handler)
    environment.FETCH_RETRY_INTERVAL_SECONDS = 10

    async def write_file():
        await asyncio.sleep(0.02)
        (tmp_path / ".tunnels.env").write_text("TUNNEL_3000=https://fresh.example.com\n")

    writer = asyncio.create_task(write_file())
    try:
        assert await environment.wait_until_ready([3000]) is True
    finally:
        await writer
    assert handler.call_count == 1


@pytest.mark.parametrize(
    "response",
    [
        httpx.Response(403),
        httpx.Response(503),
        httpx.Response(200, content="not json"),
        httpx.Response(200, json=[]),
        httpx.Response(200, json={"tunnelUrls": []}),
        httpx.Response(200, json={"tunnelUrls": {"3000": None}}),
        httpx.Response(200, json={"tunnelUrls": {"3000": ""}}),
        httpx.Response(200, json={"tunnelUrls": {"3000": "not-a-url"}}),
        httpx.Response(200, json={"tunnelUrls": {"3000": "https://a.example\nBAD=value"}}),
        httpx.Response(200, content=b"x" * (MAX_TUNNEL_RESPONSE_BYTES + 1)),
    ],
    ids=[
        "forbidden",
        "unavailable",
        "json",
        "object",
        "map",
        "null",
        "empty",
        "url",
        "newline",
        "size",
    ],
)
async def test_recovery_never_writes_failed_or_invalid_responses(
    recovery_environment, tmp_path, response
):
    environment = recovery_environment(lambda _request: response)
    assert await environment.wait_until_ready([3000]) is False
    assert not (tmp_path / ".tunnels.env").exists()


async def test_recovery_respects_wait_budget(recovery_environment):
    cancelled = asyncio.Event()

    async def handle(_request):
        try:
            await asyncio.Event().wait()
        finally:
            cancelled.set()

    environment = recovery_environment(handle)
    async with asyncio.timeout(0.5):
        assert await environment.wait_until_ready([3000]) is False
    assert cancelled.is_set()


async def test_recovery_propagates_boot_cancellation(recovery_environment):
    started = asyncio.Event()

    async def handle(_request):
        started.set()
        await asyncio.Event().wait()

    environment = recovery_environment(handle)
    task = asyncio.create_task(environment.wait_until_ready([3000]))
    await started.wait()
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task


@pytest.mark.parametrize("missing", ["control_plane_url", "session_id", "sandbox_token"])
async def test_recovery_skips_network_without_session_credentials(recovery_environment, missing):
    handler = MagicMock()
    environment = recovery_environment(handler, **{missing: ""})
    assert await environment.wait_until_ready([3000]) is False
    handler.assert_not_called()


@pytest.mark.parametrize("expected_ports", [[], [3000]])
async def test_recovery_skips_network_when_file_is_ready(
    recovery_environment, tmp_path, expected_ports
):
    (tmp_path / ".tunnels.env").write_text("TUNNEL_3000=https://fresh.example.com\n")
    handler = MagicMock()
    environment = recovery_environment(handler)
    assert await environment.wait_until_ready(expected_ports) is True
    handler.assert_not_called()


async def test_recovery_file_write_error_stays_bounded(recovery_environment, tmp_path):
    environment = recovery_environment(
        lambda _request: httpx.Response(200, json={"tunnelUrls": {"3000": "https://a.example"}})
    )
    with patch("sandbox_runtime.tunnel_environment.atomic_write_private", side_effect=OSError):
        assert await environment.wait_until_ready([3000]) is False
    assert not (tmp_path / ".tunnels.env").exists()


class TestExpectedTunnelPorts:
    def test_returns_empty_list_when_env_var_unset(self, monkeypatch):
        monkeypatch.delenv(EXPECTED_TUNNEL_PORTS_ENV_VAR, raising=False)
        sup = _make_repository_boot()
        assert sup.tunnel_environment.expected_ports() == []

    def test_parses_single_port(self, monkeypatch):
        monkeypatch.setenv(EXPECTED_TUNNEL_PORTS_ENV_VAR, "3000")
        sup = _make_repository_boot()
        assert sup.tunnel_environment.expected_ports() == [3000]

    def test_parses_multiple_ports(self, monkeypatch):
        monkeypatch.setenv(EXPECTED_TUNNEL_PORTS_ENV_VAR, "3000,5173,8080")
        sup = _make_repository_boot()
        assert sup.tunnel_environment.expected_ports() == [3000, 5173, 8080]

    def test_tolerates_whitespace(self, monkeypatch):
        monkeypatch.setenv(EXPECTED_TUNNEL_PORTS_ENV_VAR, " 3000 , 5173 ")
        sup = _make_repository_boot()
        assert sup.tunnel_environment.expected_ports() == [3000, 5173]

    def test_skips_unparseable_entries(self, monkeypatch):
        monkeypatch.setenv(EXPECTED_TUNNEL_PORTS_ENV_VAR, "3000,not-a-port,5173")
        sup = _make_repository_boot()
        assert sup.tunnel_environment.expected_ports() == [3000, 5173]

    def test_empty_string_returns_empty(self, monkeypatch):
        monkeypatch.setenv(EXPECTED_TUNNEL_PORTS_ENV_VAR, "")
        sup = _make_repository_boot()
        assert sup.tunnel_environment.expected_ports() == []


class TestClearStaleTunnelEnvFile:
    def test_removes_untagged_file(self, tmp_path, monkeypatch):
        """A file with no sandbox-ID tag (pre-tag writer, or user-made) is stale."""
        stub_path = tmp_path / "tunnels.env"
        stub_path.write_text("TUNNEL_3000=https://stale.example.com\n")
        monkeypatch.setattr(
            "sandbox_runtime.tunnel_environment.TUNNEL_ENV_FILE_PATH", str(stub_path)
        )

        sup = _make_repository_boot()
        sup.tunnel_environment.clear_stale_file()

        assert not stub_path.exists()

    def test_keeps_file_tagged_with_own_sandbox_id(self, tmp_path, monkeypatch):
        """The manager's write can land before the entrypoint runs; keep it."""
        stub_path = tmp_path / "tunnels.env"
        content = (
            f"{TUNNEL_ENV_SANDBOX_ID_KEY}=test-sandbox\nTUNNEL_3000=https://fresh.example.com\n"
        )
        stub_path.write_text(content)
        monkeypatch.setattr(
            "sandbox_runtime.tunnel_environment.TUNNEL_ENV_FILE_PATH", str(stub_path)
        )

        sup = _make_repository_boot()
        sup.tunnel_environment.clear_stale_file()

        assert stub_path.read_text() == content

    def test_removes_file_tagged_with_other_sandbox_id(self, tmp_path, monkeypatch):
        """A snapshot/image leftover carries the previous sandbox's ID."""
        stub_path = tmp_path / "tunnels.env"
        stub_path.write_text(
            f"{TUNNEL_ENV_SANDBOX_ID_KEY}=previous-sandbox\nTUNNEL_3000=https://stale.example.com\n"
        )
        monkeypatch.setattr(
            "sandbox_runtime.tunnel_environment.TUNNEL_ENV_FILE_PATH", str(stub_path)
        )

        sup = _make_repository_boot()
        sup.tunnel_environment.clear_stale_file()

        assert not stub_path.exists()

    def test_removes_tagged_file_when_own_sandbox_id_unknown(self, tmp_path, monkeypatch):
        """Without a SANDBOX_ID identity, never trust a pre-existing file."""
        stub_path = tmp_path / "tunnels.env"
        stub_path.write_text(f"{TUNNEL_ENV_SANDBOX_ID_KEY}=unknown\n")
        monkeypatch.setattr(
            "sandbox_runtime.tunnel_environment.TUNNEL_ENV_FILE_PATH", str(stub_path)
        )

        base_env = {
            "CONTROL_PLANE_URL": "https://cp.example.com",
            "SANDBOX_AUTH_TOKEN": "tok",
            "REPO_OWNER": "acme",
            "REPO_NAME": "app",
        }
        with patch.dict("os.environ", base_env, clear=True):
            sup = make_repository_boot()
        sup.tunnel_environment.clear_stale_file()

        assert not stub_path.exists()

    def test_removes_dangling_symlink(self, tmp_path, monkeypatch):
        """exists() is False for a broken symlink, but it must still be cleared."""
        stub_path = tmp_path / "tunnels.env"
        stub_path.symlink_to(tmp_path / "missing-target")
        monkeypatch.setattr(
            "sandbox_runtime.tunnel_environment.TUNNEL_ENV_FILE_PATH", str(stub_path)
        )

        sup = _make_repository_boot()
        sup.tunnel_environment.clear_stale_file()

        assert not stub_path.is_symlink()
        assert not stub_path.exists()

    def test_no_op_when_file_missing(self, tmp_path, monkeypatch):
        stub_path = tmp_path / "tunnels.env"
        monkeypatch.setattr(
            "sandbox_runtime.tunnel_environment.TUNNEL_ENV_FILE_PATH", str(stub_path)
        )

        sup = _make_repository_boot()
        sup.tunnel_environment.clear_stale_file()  # must not raise


class TestWaitForTunnelEnvFile:
    @pytest.mark.asyncio
    async def test_returns_true_immediately_when_no_ports_expected(self):
        sup = _make_repository_boot()
        assert await sup.tunnel_environment.wait_until_ready([]) is True

    @pytest.mark.asyncio
    async def test_returns_true_when_file_already_present(self, tmp_path, monkeypatch):
        stub_path = tmp_path / "tunnels.env"
        stub_path.write_text("TUNNEL_3000=https://fresh.example.com\n")
        monkeypatch.setattr(
            "sandbox_runtime.tunnel_environment.TUNNEL_ENV_FILE_PATH", str(stub_path)
        )

        sup = _make_repository_boot()
        assert await sup.tunnel_environment.wait_until_ready([3000]) is True

    @pytest.mark.asyncio
    async def test_returns_true_for_all_expected_ports(self, tmp_path, monkeypatch):
        stub_path = tmp_path / "tunnels.env"
        stub_path.write_text(
            "TUNNEL_3000=https://a.example.com\nTUNNEL_5173=https://b.example.com\n"
        )
        monkeypatch.setattr(
            "sandbox_runtime.tunnel_environment.TUNNEL_ENV_FILE_PATH", str(stub_path)
        )

        sup = _make_repository_boot()
        assert await sup.tunnel_environment.wait_until_ready([3000, 5173]) is True

    @pytest.mark.asyncio
    async def test_returns_false_on_timeout_when_file_missing(self, tmp_path, monkeypatch):
        stub_path = tmp_path / "tunnels.env"
        monkeypatch.setattr(
            "sandbox_runtime.tunnel_environment.TUNNEL_ENV_FILE_PATH", str(stub_path)
        )
        monkeypatch.setenv("TUNNEL_WAIT_TIMEOUT_SECONDS", "0.05")

        sup = _make_repository_boot()
        sup.tunnel_environment.WAIT_POLL_INTERVAL_SECONDS = 0.01
        assert await sup.tunnel_environment.wait_until_ready([3000]) is False

    @pytest.mark.asyncio
    async def test_returns_false_when_only_partial_ports_resolve(self, tmp_path, monkeypatch):
        """If Modal only resolves a subset of ports, we time out and degrade."""
        stub_path = tmp_path / "tunnels.env"
        stub_path.write_text("TUNNEL_3000=https://a.example.com\n")
        monkeypatch.setattr(
            "sandbox_runtime.tunnel_environment.TUNNEL_ENV_FILE_PATH", str(stub_path)
        )
        monkeypatch.setenv("TUNNEL_WAIT_TIMEOUT_SECONDS", "0.05")

        sup = _make_repository_boot()
        sup.tunnel_environment.WAIT_POLL_INTERVAL_SECONDS = 0.01
        assert await sup.tunnel_environment.wait_until_ready([3000, 5173]) is False

    @pytest.mark.asyncio
    async def test_returns_true_when_file_appears_during_wait(self, tmp_path, monkeypatch):
        stub_path = tmp_path / "tunnels.env"
        monkeypatch.setattr(
            "sandbox_runtime.tunnel_environment.TUNNEL_ENV_FILE_PATH", str(stub_path)
        )
        monkeypatch.setenv("TUNNEL_WAIT_TIMEOUT_SECONDS", "1.0")

        sup = _make_repository_boot()
        sup.tunnel_environment.WAIT_POLL_INTERVAL_SECONDS = 0.02

        async def write_after_delay() -> None:
            await asyncio.sleep(0.05)
            stub_path.write_text("TUNNEL_3000=https://late.example.com\n")

        writer = asyncio.create_task(write_after_delay())
        try:
            assert await sup.tunnel_environment.wait_until_ready([3000]) is True
        finally:
            await writer


class TestConstantValue:
    """Sanity: the shared constant is the path we expect the manager to write."""

    def test_default_path(self):
        assert TUNNEL_ENV_FILE_PATH == "/workspace/.tunnels.env"
