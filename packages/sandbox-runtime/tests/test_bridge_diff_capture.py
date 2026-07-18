import asyncio
import json
from pathlib import Path

import httpx
import pytest

from sandbox_runtime.bridge import AgentBridge
from sandbox_runtime.diff_capture import SessionDiffRefreshWorker
from sandbox_runtime.repo_config import RepoEntry, dump_repo_manifest


def _bridge() -> AgentBridge:
    return AgentBridge(
        sandbox_id="sandbox-1",
        session_id="session-1",
        control_plane_url="https://control.example.com",
        auth_token="sandbox-token",
    )


def _bundle(trigger_message_id: str | None) -> dict[str, object]:
    return {
        "version": 1,
        "triggerMessageId": trigger_message_id,
        "capturedAt": 100,
        "repositories": [
            {
                "status": "ready",
                "position": 0,
                "repoOwner": "open-inspect",
                "repoName": "viewer",
                "baseSha": "a" * 40,
                "headSha": "b" * 40,
                "truncated": False,
                "omittedFileCount": 0,
                "files": [],
            }
        ],
    }


def test_ready_event_reports_fixed_baselines_without_a_capability_gate(tmp_path: Path) -> None:
    manifest = tmp_path / "repositories.json"
    manifest.write_text(
        dump_repo_manifest(
            [
                RepoEntry(
                    owner="open-inspect",
                    name="viewer",
                    branch="main",
                    path=tmp_path / "viewer",
                    base_sha="a" * 40,
                )
            ]
        )
    )
    bridge = _bridge()
    bridge.repo_manifest_path = manifest

    assert bridge._build_ready_event() == {
        "type": "ready",
        "sandboxId": "sandbox-1",
        "opencodeSessionId": None,
        "repositories": [
            {
                "position": 0,
                "repoOwner": "open-inspect",
                "repoName": "viewer",
                "baseSha": "a" * 40,
            }
        ],
    }


@pytest.mark.asyncio
async def test_refresh_request_returns_before_collection_and_uploads_one_bundle(
    tmp_path: Path,
) -> None:
    repository = RepoEntry("open-inspect", "viewer", "main", tmp_path / "viewer", base_sha="a" * 40)
    started = asyncio.Event()
    release = asyncio.Event()
    requests: list[httpx.Request] = []

    async def collect(_repositories, *, trigger_message_id, captured_at, limits):
        started.set()
        await release.wait()
        return _bundle(trigger_message_id)

    def respond(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(200)

    client = httpx.AsyncClient(transport=httpx.MockTransport(respond))
    bridge = _bridge()
    worker = SessionDiffRefreshWorker(
        session_id="session-1",
        control_plane_url="https://control.example.com",
        auth_token="sandbox-token",
        load_repositories=lambda: [repository],
        is_idle=lambda: True,
        get_http_client=lambda: client,
        log=bridge.log,
        collector=collect,
    )

    worker.request("message-1")
    await asyncio.wait_for(started.wait(), timeout=1)
    assert requests == []
    release.set()
    await worker.flush(timeout_seconds=1)
    await client.aclose()

    assert [request.method for request in requests] == ["PUT"]
    assert requests[0].url.path == "/sessions/session-1/diff"
    assert requests[0].headers["authorization"] == "Bearer sandbox-token"
    assert json.loads(requests[0].content)["triggerMessageId"] == "message-1"


@pytest.mark.asyncio
async def test_prompt_activity_discards_stale_collection_and_coalesces_to_latest_request(
    tmp_path: Path,
) -> None:
    repository = RepoEntry("open-inspect", "viewer", "main", tmp_path / "viewer", base_sha="a" * 40)
    idle = {"value": True}
    first_started = asyncio.Event()
    release_first = asyncio.Event()
    calls = 0
    uploads: list[httpx.Request] = []

    async def collect(_repositories, *, trigger_message_id, captured_at, limits):
        nonlocal calls
        calls += 1
        if calls == 1:
            first_started.set()
            await release_first.wait()
        return _bundle(trigger_message_id)

    client = httpx.AsyncClient(
        transport=httpx.MockTransport(
            lambda request: uploads.append(request) or httpx.Response(200)
        )
    )
    bridge = _bridge()
    worker = SessionDiffRefreshWorker(
        session_id="session-1",
        control_plane_url="https://control.example.com",
        auth_token="sandbox-token",
        load_repositories=lambda: [repository],
        is_idle=lambda: idle["value"],
        get_http_client=lambda: client,
        log=bridge.log,
        collector=collect,
        idle_poll_seconds=0,
    )

    worker.request("message-1")
    await asyncio.wait_for(first_started.wait(), timeout=1)
    idle["value"] = False
    worker.prompt_started()
    worker.request("message-2")
    release_first.set()
    await asyncio.sleep(0)
    assert uploads == []
    idle["value"] = True
    await worker.flush(timeout_seconds=1)
    await client.aclose()

    assert calls == 2
    assert len(uploads) == 1
    assert json.loads(uploads[0].content)["triggerMessageId"] == "message-2"


@pytest.mark.asyncio
async def test_refresh_failure_is_reported_without_terminating_future_requests(
    tmp_path: Path,
) -> None:
    repository = RepoEntry("open-inspect", "viewer", "main", tmp_path / "viewer", base_sha="a" * 40)
    calls = 0
    requests: list[httpx.Request] = []

    async def collect(_repositories, *, trigger_message_id, captured_at, limits):
        nonlocal calls
        calls += 1
        if calls == 1:
            raise RuntimeError("git timed out")
        return _bundle(trigger_message_id)

    client = httpx.AsyncClient(
        transport=httpx.MockTransport(
            lambda request: requests.append(request) or httpx.Response(204)
        )
    )
    bridge = _bridge()
    worker = SessionDiffRefreshWorker(
        session_id="session-1",
        control_plane_url="https://control.example.com",
        auth_token="sandbox-token",
        load_repositories=lambda: [repository],
        is_idle=lambda: True,
        get_http_client=lambda: client,
        log=bridge.log,
        collector=collect,
    )

    worker.request("message-1")
    await worker.flush(timeout_seconds=1)
    worker.request("message-2")
    await worker.flush(timeout_seconds=1)
    await client.aclose()

    assert [request.url.path for request in requests] == [
        "/sessions/session-1/diff/failure",
        "/sessions/session-1/diff",
    ]


@pytest.mark.asyncio
async def test_unsupported_control_plane_disables_refresh_without_failing_the_bridge(
    tmp_path: Path,
) -> None:
    repository = RepoEntry("open-inspect", "viewer", "main", tmp_path / "viewer", base_sha="a" * 40)
    requests: list[httpx.Request] = []

    async def collect(_repositories, *, trigger_message_id, captured_at, limits):
        return _bundle(trigger_message_id)

    client = httpx.AsyncClient(
        transport=httpx.MockTransport(
            lambda request: requests.append(request) or httpx.Response(404)
        )
    )
    bridge = _bridge()
    worker = SessionDiffRefreshWorker(
        session_id="session-1",
        control_plane_url="https://control.example.com",
        auth_token="sandbox-token",
        load_repositories=lambda: [repository],
        is_idle=lambda: True,
        get_http_client=lambda: client,
        log=bridge.log,
        collector=collect,
    )

    worker.request("message-1")
    await worker.flush(timeout_seconds=1)
    worker.request("message-2")
    await asyncio.sleep(0)
    await client.aclose()

    assert len(requests) == 1


@pytest.mark.asyncio
async def test_refresh_command_is_accepted_without_waiting_for_collection() -> None:
    bridge = _bridge()
    requested = []
    bridge.diff_refresh.request = requested.append

    result = await bridge._handle_command({"type": "refresh_diff"})

    assert result is None
    assert requested == [None]


@pytest.mark.asyncio
async def test_terminal_prompt_completion_schedules_refresh_without_blocking_command_loop() -> None:
    bridge = _bridge()
    requested = []
    prompt_started = []

    async def complete_prompt(_command):
        return None

    bridge._handle_prompt = complete_prompt
    bridge.diff_refresh.request = requested.append
    bridge.diff_refresh.prompt_started = lambda: prompt_started.append(True)

    result = await bridge._handle_command({"type": "prompt", "messageId": "message-1"})
    task = bridge._current_prompt_task
    assert result is None
    assert task is not None
    await task
    await asyncio.sleep(0)

    assert prompt_started == [True]
    assert requested == ["message-1"]


@pytest.mark.asyncio
async def test_timed_out_close_cancels_without_rescheduling_refresh(tmp_path: Path) -> None:
    repository = RepoEntry("open-inspect", "viewer", "main", tmp_path / "viewer", base_sha="a" * 40)
    started = asyncio.Event()
    cancelled = asyncio.Event()

    async def collect(_repositories, *, trigger_message_id, captured_at, limits):
        started.set()
        try:
            await asyncio.Event().wait()
        finally:
            cancelled.set()

    bridge = _bridge()
    worker = SessionDiffRefreshWorker(
        session_id="session-1",
        control_plane_url="https://control.example.com",
        auth_token="sandbox-token",
        load_repositories=lambda: [repository],
        is_idle=lambda: True,
        get_http_client=lambda: None,
        log=bridge.log,
        collector=collect,
    )

    worker.request("message-1")
    await asyncio.wait_for(started.wait(), timeout=1)
    await worker.close(timeout_seconds=0)
    await asyncio.wait_for(cancelled.wait(), timeout=1)
    await asyncio.sleep(0)

    assert worker._task is None
