"""The Open Inspect tools the Claude harness serves in-process."""

import json
from pathlib import Path
from unittest.mock import MagicMock

import httpx
import pytest

from sandbox_runtime.harness.claude_tools import (
    PULL_REQUEST_TIMEOUT_SECONDS,
    ControlPlaneToolClient,
    OpenInspectTools,
    ToolServerConfig,
    build_tool_server,
    build_tools,
)


def _tools(tmp_path: Path, handler, **config_overrides):
    seen: list[httpx.Request] = []

    def transport_handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return handler(request)

    manifest = tmp_path / "manifest.json"
    manifest.write_text(
        json.dumps(
            {
                "repositories": [
                    {"owner": "acme", "name": "web", "path": str(tmp_path / "web")},
                ]
            }
        )
    )
    config = ToolServerConfig(
        control_plane_url="https://cp.example",
        session_id="s1",
        auth_token="tok",
        repo_manifest_path=manifest,
        has_repository=config_overrides.get("has_repository", True),
        slack_notify_enabled=config_overrides.get("slack_notify_enabled", False),
    )
    client = ControlPlaneToolClient(
        config, MagicMock(), httpx.AsyncClient(transport=httpx.MockTransport(transport_handler))
    )
    return OpenInspectTools(client), seen


def _text(result: dict) -> str:
    return result["content"][0]["text"]


@pytest.mark.asyncio
async def test_spawn_child_posts_to_children_with_the_sandbox_token(tmp_path: Path) -> None:
    tools, seen = _tools(tmp_path, lambda _r: httpx.Response(201, json={"sessionId": "child-1"}))
    result = await tools.spawn_child({"title": "t", "prompt": "p", "reasoning": "high"})

    request = seen[0]
    assert str(request.url) == "https://cp.example/sessions/s1/children"
    assert request.headers["Authorization"] == "Bearer tok"
    assert json.loads(request.content) == {"title": "t", "prompt": "p", "reasoningEffort": "high"}
    assert "Child ID: child-1" in _text(result)


@pytest.mark.asyncio
async def test_spawn_child_explains_a_depth_limit(tmp_path: Path) -> None:
    tools, _ = _tools(tmp_path, lambda _r: httpx.Response(403, json={"error": "depth exceeded"}))
    assert "depth exceeded" in _text(await tools.spawn_child({"title": "t", "prompt": "p"}))


@pytest.mark.asyncio
async def test_get_child_status_lists_children(tmp_path: Path) -> None:
    tools, _ = _tools(
        tmp_path,
        lambda _r: httpx.Response(
            200,
            json={
                "children": [
                    {"id": "c1", "status": "active", "title": "one", "createdAt": 0},
                    {"id": "c2", "status": "completed", "title": None, "createdAt": 0},
                ]
            },
        ),
    )
    text = _text(await tools.get_child_status({}))
    assert text.startswith("2 child session(s): 1 running, 0 pending, 1 done, 0 failed")
    assert "[RUNNING] c1" in text
    assert "(untitled)" in text


@pytest.mark.asyncio
async def test_get_child_status_detail_builds_the_include_query(tmp_path: Path) -> None:
    tools, seen = _tools(
        tmp_path,
        # The ``ChildSessionDetail`` envelope the control plane returns.
        lambda _r: httpx.Response(
            200,
            json={
                "session": {
                    "id": "c 1",
                    "title": "one",
                    "status": "completed",
                    "repoOwner": "acme",
                    "repoName": "web",
                    "branchName": "feature/x",
                    "model": "anthropic/claude-sonnet-4-6",
                    "createdAt": 1_700_000_000_000,
                    "updatedAt": 1_700_000_060_000,
                },
                "sandbox": {"status": "stopped"},
                "artifacts": [{"type": "pr", "url": "https://gh/pr/7", "metadata": None}],
                "recentEvents": [
                    {"type": "token", "data": {"content": "hello"}, "createdAt": 1_700_000_000_000}
                ],
                "finalResponse": {"success": True, "textContent": "done"},
                "trajectory": {"events": [], "hasMore": True, "cursor": "abc"},
            },
        ),
    )
    text = _text(
        await tools.get_child_status(
            {
                "childId": "c 1",
                "includeResponse": True,
                "includeTrajectory": True,
                "trajectoryLimit": 5,
            }
        )
    )
    assert seen[0].url.raw_path.startswith(b"/sessions/s1/children/c%201")
    assert seen[0].url.params["include"] == "result,trajectory"
    assert seen[0].url.params["trajectoryLimit"] == "5"
    assert "  Status: DONE" in text
    assert "  Title: one" in text
    assert "  Branch: feature/x" in text
    assert "  Sandbox: stopped" in text
    assert "PR: https://gh/pr/7" in text
    assert "Final response:" in text
    assert "done" in text
    assert "Recent events:" in text and "token: hello" in text
    assert 'Re-run with trajectoryCursor="abc"' in text


@pytest.mark.asyncio
async def test_get_child_status_detail_forwards_the_cursor_and_ends_when_none_remains(
    tmp_path: Path,
) -> None:
    tools, seen = _tools(
        tmp_path,
        lambda _r: httpx.Response(
            200,
            json={
                "session": {"id": "c1", "status": "active"},
                "artifacts": [],
                "recentEvents": [],
                "trajectory": {"events": [{"type": "tool_call", "createdAt": 0}], "hasMore": False},
            },
        ),
    )
    text = _text(
        await tools.get_child_status(
            {"childId": "c1", "includeTrajectory": True, "trajectoryCursor": "abc"}
        )
    )
    assert seen[0].url.params["trajectoryCursor"] == "abc"
    assert "Trajectory (1 events):" in text
    assert "trajectoryCursor=" not in text


@pytest.mark.asyncio
async def test_create_pull_request_targets_the_manifest_repository(
    tmp_path: Path, monkeypatch
) -> None:
    monkeypatch.setattr(
        "sandbox_runtime.harness.claude_tools._current_branch", lambda _p: "feature/x"
    )
    tools, seen = _tools(
        tmp_path,
        lambda _r: httpx.Response(
            200,
            json={
                "prNumber": 7,
                "prUrl": "https://gh/pr/7",
                "headBranch": "feature/x",
                "baseBranch": "main",
            },
        ),
    )
    result = json.loads(
        _text(await tools.create_pull_request({"title": "T", "body": "B", "repo": "ACME/web"}))
    )
    body = json.loads(seen[0].content)
    assert seen[0].url.path == "/sessions/s1/pr"
    assert body["repoOwner"] == "acme" and body["repoName"] == "web"
    assert body["headBranch"] == "feature/x"
    assert result["kind"] == "created" and result["prNumber"] == 7


@pytest.mark.asyncio
async def test_create_pull_request_reads_the_branch_from_the_sole_checkout(
    tmp_path: Path, monkeypatch
) -> None:
    asked: list[Path | None] = []

    def current_branch(path: Path | None) -> str:
        asked.append(path)
        return "feature/y"

    monkeypatch.setattr("sandbox_runtime.harness.claude_tools._current_branch", current_branch)
    tools, seen = _tools(
        tmp_path, lambda _r: httpx.Response(200, json={"prNumber": 1, "prUrl": "u"})
    )
    await tools.create_pull_request({"title": "T", "body": "B"})

    # The bridge's own cwd is the workspace root, not the checkout.
    assert asked == [tmp_path / "web"]
    body = json.loads(seen[0].content)
    assert body["headBranch"] == "feature/y"
    # Absent optionals are absent, never JSON null: the route rejects null.
    assert set(body) == {"title", "body", "headBranch", "timestamp"}
    # A pull request waits for the push; the tool must outlast the server's budget.
    assert seen[0].extensions["timeout"]["read"] == PULL_REQUEST_TIMEOUT_SECONDS
    assert PULL_REQUEST_TIMEOUT_SECONDS > 360


@pytest.mark.asyncio
async def test_create_pull_request_forwards_explicit_optionals(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr("sandbox_runtime.harness.claude_tools._current_branch", lambda _p: None)
    tools, seen = _tools(tmp_path, lambda _r: httpx.Response(200, json={"prNumber": 1}))
    await tools.create_pull_request(
        {"title": "T", "body": "B", "baseBranch": "develop", "draft": False}
    )
    body = json.loads(seen[0].content)
    assert body["baseBranch"] == "develop" and body["draft"] is False
    assert "headBranch" not in body


@pytest.mark.asyncio
async def test_create_pull_request_rejects_an_unknown_repo(tmp_path: Path) -> None:
    tools, seen = _tools(tmp_path, lambda _r: httpx.Response(200, json={}))
    result = json.loads(
        _text(await tools.create_pull_request({"title": "T", "body": "B", "repo": "x/y"}))
    )
    assert result["kind"] == "failure"
    assert "not part of this session" in result["message"]
    assert seen == []


@pytest.mark.asyncio
async def test_slack_notify_maps_status_to_reason(tmp_path: Path) -> None:
    tools, _ = _tools(tmp_path, lambda _r: httpx.Response(404, json={"message": "no channel"}))
    envelope = json.loads(_text(await tools.slack_notify({"channel": "ops", "text": "hi"})))
    assert envelope["ok"] is False
    assert envelope["reason"] == "channel_not_found_or_forbidden"
    assert "no channel" in envelope["agentMessage"]


@pytest.mark.asyncio
async def test_upload_media_posts_multipart(tmp_path: Path) -> None:
    shot = tmp_path / "shot.png"
    shot.write_bytes(b"\x89PNG")
    tools, seen = _tools(tmp_path, lambda _r: httpx.Response(200, json={"artifactId": "a1"}))
    text = _text(await tools.upload_media({"filePath": str(shot), "caption": "c"}))
    assert seen[0].url.path == "/sessions/s1/media"
    assert seen[0].headers["content-type"].startswith("multipart/form-data")
    assert b'name="artifactType"' in seen[0].content
    assert "a1" in text


def _multipart_fields(request: httpx.Request) -> dict[str, str]:
    boundary = request.headers["content-type"].split("boundary=")[1].encode()
    fields: dict[str, str] = {}
    for part in request.content.split(b"--" + boundary)[1:-1]:
        head, _, value = part.strip(b"\r\n").partition(b"\r\n\r\n")
        if b"filename=" in head:
            continue
        name = head.split(b'name="')[1].split(b'"')[0].decode()
        fields[name] = value.decode()
    return fields


@pytest.mark.asyncio
async def test_upload_media_sends_sizes_as_json_objects(tmp_path: Path) -> None:
    shot = tmp_path / "shot.png"
    shot.write_bytes(b"\x89PNG")
    tools, seen = _tools(tmp_path, lambda _r: httpx.Response(200, json={"artifactId": "a1"}))
    await tools.upload_media(
        {"filePath": str(shot), "viewport": {"width": 1280, "height": 720}, "fullPage": True}
    )
    fields = _multipart_fields(seen[0])
    assert json.loads(fields["viewport"]) == {"width": 1280, "height": 720}
    assert fields["fullPage"] == "true"


@pytest.mark.asyncio
async def test_upload_media_video_carries_every_required_field(tmp_path: Path) -> None:
    clip = tmp_path / "clip.mp4"
    clip.write_bytes(b"\x00\x00\x00\x18ftyp")
    tools, seen = _tools(tmp_path, lambda _r: httpx.Response(200, json={"artifactId": "v1"}))
    video = {
        "filePath": str(clip),
        "artifactType": "video",
        "caption": "Checkout flow",
        "durationMs": 4200,
        "recordingStartedAt": 1_700_000_000_000,
        "recordingEndedAt": 1_700_000_004_200,
        "dimensions": {"width": 1280, "height": 720},
    }
    text = _text(await tools.upload_media(video))
    fields = _multipart_fields(seen[0])
    assert fields["caption"] == "Checkout flow"
    assert fields["durationMs"] == "4200"
    assert json.loads(fields["dimensions"]) == {"width": 1280, "height": 720}
    assert fields["truncated"] == "false" and fields["hasAudio"] == "false"
    assert "v1" in text

    for missing in (
        "caption",
        "durationMs",
        "recordingStartedAt",
        "recordingEndedAt",
        "dimensions",
    ):
        seen.clear()
        args = {key: value for key, value in video.items() if key != missing}
        assert f"require {missing}" in _text(await tools.upload_media(args))
        assert seen == []


@pytest.mark.asyncio
async def test_upload_media_rejects_unsupported_files(tmp_path: Path) -> None:
    doc = tmp_path / "notes.txt"
    doc.write_text("x")
    tools, seen = _tools(tmp_path, lambda _r: httpx.Response(200, json={}))
    assert "only supports" in _text(await tools.upload_media({"filePath": str(doc)}))
    assert seen == []


def test_build_tool_server_registers_the_gated_tools(tmp_path: Path) -> None:
    def names(**overrides) -> set[str]:
        tools, _ = _tools(tmp_path, lambda _r: httpx.Response(200), **overrides)
        server = build_tool_server(tools.client)
        assert server["type"] == "sdk" and server["name"] == "oi"
        return {tool.name for tool in build_tools(tools.client)}

    everything = names(has_repository=True, slack_notify_enabled=True)
    assert {"spawn-child", "send-child-prompt", "cancel-child", "get-child-status"} <= everything
    assert {"create-pull-request", "slack-notify", "upload-media"} <= everything
    minimal = names(has_repository=False, slack_notify_enabled=False)
    assert "create-pull-request" not in minimal
    assert "slack-notify" not in minimal
