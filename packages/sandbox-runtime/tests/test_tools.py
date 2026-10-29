"""Shared sandbox tool definitions and vendor-neutral handlers."""

import json
import subprocess
from pathlib import Path
from unittest.mock import MagicMock

import httpx
import pytest

from sandbox_runtime.event_size import MAX_EVENT_BYTES, event_size_bytes
from sandbox_runtime.harness.tool_results import ToolResult
from sandbox_runtime.harness.tools import (
    PULL_REQUEST_TIMEOUT_SECONDS,
    ControlPlaneToolClient,
    OpenInspectTools,
    ToolServerConfig,
    build_tools,
)
from tests.event_forwarder_fakes import make_forwarder, open_ws, sent_events


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


def _text(result: ToolResult) -> str:
    return result.text


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
    envelope = json.loads(_text(await tools.get_child_status({})))
    assert envelope["version"] == 1
    assert envelope["kind"] == "list"
    assert [child["id"] for child in envelope["children"]] == ["c1", "c2"]
    text = envelope["agentMessage"]
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
    envelope = json.loads(text)
    assert envelope["version"] == 1
    assert envelope["kind"] == "detail"
    assert envelope["session"]["repoOwner"] == "acme"
    assert envelope["finalResponse"] == {"success": True, "textContent": "done"}
    assert envelope["hasUnfinishedPrompt"] is False
    text = envelope["agentMessage"]
    assert seen[0].url.raw_path.startswith(b"/sessions/s1/children/c%201")
    assert seen[0].url.params["include"] == "result,trajectory"
    assert seen[0].url.params["trajectoryLimit"] == "5"
    assert "  Status: DONE" in text
    assert "  Title: one" in text
    assert "  Branch: feature/x" in text
    assert "  Sandbox: stopped" in text
    assert "PR: https://gh/pr/7" in text
    assert "Final response:" in text
    assert "(see finalResponse.textContent)" in text
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
    assert "Trajectory (1 events):" in json.loads(text)["agentMessage"]
    assert "trajectoryCursor=" not in text


@pytest.mark.asyncio
async def test_create_pull_request_targets_the_manifest_repository(
    tmp_path: Path, monkeypatch
) -> None:
    monkeypatch.setattr("sandbox_runtime.harness.tools._current_branch", lambda _p: "feature/x")
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

    monkeypatch.setattr("sandbox_runtime.harness.tools._current_branch", current_branch)
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
    monkeypatch.setattr("sandbox_runtime.harness.tools._current_branch", lambda _p: None)
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

    seen.clear()
    text = _text(await tools.upload_media({**video, "hasAudio": True}))
    assert "do not support audio" in text
    assert seen == []


@pytest.mark.asyncio
async def test_upload_media_rejects_unsupported_files(tmp_path: Path) -> None:
    doc = tmp_path / "notes.txt"
    doc.write_text("x")
    tools, seen = _tools(tmp_path, lambda _r: httpx.Response(200, json={}))
    assert "only supports" in _text(await tools.upload_media({"filePath": str(doc)}))
    assert seen == []


def test_build_tools_registers_the_gated_tools(tmp_path: Path) -> None:
    def names(**overrides) -> set[str]:
        tools, _ = _tools(tmp_path, lambda _r: httpx.Response(200), **overrides)
        return {tool.name for tool in build_tools(tools.client)}

    everything = names(has_repository=True, slack_notify_enabled=True)
    assert {"spawn-child", "send-child-prompt", "cancel-child", "get-child-status"} <= everything
    assert {"create-pull-request", "slack-notify", "upload-media"} <= everything
    minimal = names(has_repository=False, slack_notify_enabled=False)
    assert "create-pull-request" not in minimal
    assert "slack-notify" not in minimal


@pytest.mark.parametrize(
    "name,args",
    [
        ("spawn-child", {"title": "t", "prompt": "p"}),
        ("send-child-prompt", {"childId": "child", "prompt": "p"}),
        ("cancel-child", {"childId": "child"}),
        ("get-child-status", {}),
        ("get-child-status", {"childId": "child"}),
        ("create-pull-request", {"title": "T", "body": "B"}),
        ("slack-notify", {"channel": "ops", "text": "hi"}),
        ("upload-media", {"filePath": "shot.png"}),
        ("memory_read", {"memoryId": "mem"}),
        ("memory_search", {"query": "deploy"}),
        (
            "memory_write",
            {
                "memoryType": "fact",
                "title": "t",
                "description": "d",
                "content": "c",
                "scopeType": "personal",
            },
        ),
    ],
)
@pytest.mark.parametrize("unavailable", [False, True])
async def test_shared_handlers_flag_http_and_transport_failures(tmp_path, name, args, unavailable):
    def handle(request):
        if unavailable:
            raise httpx.ConnectError("unavailable", request=request)
        return httpx.Response(403, json={"error": "forbidden"})

    (tmp_path / "shot.png").write_bytes(b"\x89PNG")
    if name == "upload-media":
        args = {"filePath": str(tmp_path / "shot.png")}
    handlers, seen = _tools(tmp_path, handle, slack_notify_enabled=True)
    try:
        tools = {tool.name: tool for tool in build_tools(handlers.client)}
        result = await tools[name].handler(args)
    finally:
        await handlers.client.aclose()
    assert isinstance(result, ToolResult)
    assert result.is_error is True
    assert result.text
    assert len(seen) == 1


@pytest.mark.parametrize("collection", ["fileArtifacts", "mediaArtifacts"])
def test_child_formatter_renders_protected_completion_references(collection):
    files = [
        {"id": "shot-1", "type": "screenshot", "caption": "Dashboard"},
        {"id": "video-1", "type": "video", "caption": "Walkthrough"},
        {
            "id": "csv-1",
            "type": "file",
            "available": True,
            "metadata": {
                "filename": "report.csv",
                "caption": "Revenue",
                "objectKey": "sessions/private/files/csv-1",
            },
        },
        {"id": "missing-1", "type": "file", "available": False},
    ]
    output = OpenInspectTools._format_child_detail(
        {"finalResponse": {"success": True, collection: files}}, "c1", {"includeResponse": True}
    )
    for text in [
        "shot-1",
        "screenshot",
        "Dashboard",
        "video-1",
        "Walkthrough",
        "csv-1",
        "report.csv",
        "Revenue",
        "missing-1",
        "unavailable",
    ]:
        assert text in output
    assert "sessions/private" not in output


def test_child_formatter_prefers_empty_canonical_collection():
    output = OpenInspectTools._format_child_detail(
        {
            "finalResponse": {
                "fileArtifacts": [],
                "mediaArtifacts": [{"id": "shot-1", "type": "screenshot"}],
            }
        },
        "c1",
        {"includeResponse": True},
    )
    assert "shot-1" not in output


def test_child_formatter_renders_ordinary_output_summary():
    output = OpenInspectTools._format_child_detail(
        {
            "fileArtifacts": [
                {"id": "shot-1", "type": "screenshot", "caption": "Dashboard"},
                {"id": "csv-1", "type": "file", "filename": "report.csv", "available": True},
            ]
        },
        "c1",
        {},
    )
    for text in ["shot-1", "screenshot", "Dashboard", "csv-1", "report.csv"]:
        assert text in output


@pytest.mark.asyncio
async def test_child_status_envelope_omits_private_metadata(tmp_path: Path) -> None:
    detail = {
        "session": {"id": "c1", "status": "active", "secret": "private"},
        "hasUnfinishedPrompt": True,
        "finalResponse": {
            "success": False,
            "textContent": "## Result",
            "error": "Tests failed",
            "eventCount": 1000,
            "eventLimitReached": True,
            "fileArtifacts": [
                {
                    "id": "f1",
                    "type": "file",
                    "available": True,
                    "metadata": {"filename": "result.csv", "objectKey": "sessions/private/output"},
                }
            ],
        },
    }
    tools, _ = _tools(tmp_path, lambda _r: httpx.Response(200, json=detail))
    raw = _text(await tools.get_child_status({"childId": "c1", "includeResponse": True}))
    envelope = json.loads(raw)
    assert envelope["hasUnfinishedPrompt"] is True
    assert envelope["finalResponse"] == {
        "success": False,
        "textContent": "## Result",
        "error": "Tests failed",
        "eventCount": 1000,
        "eventLimitReached": True,
    }
    assert "Latest completed response" in envelope["agentMessage"]
    assert "result.csv" in envelope["agentMessage"]
    assert "objectKey" not in raw and "sessions/private" not in raw and "secret" not in raw


@pytest.mark.asyncio
async def test_child_status_empty_list_and_error_fallback(tmp_path: Path) -> None:
    tools, _ = _tools(tmp_path, lambda _r: httpx.Response(200, json={"children": []}))
    assert json.loads(_text(await tools.get_child_status({}))) == {
        "version": 1,
        "kind": "list",
        "children": [],
        "agentMessage": "No child sessions found.",
    }
    tools, _ = _tools(tmp_path, lambda _r: httpx.Response(404, json={"error": "not found"}))
    result = await tools.get_child_status({"childId": "missing"})
    assert result.is_error
    assert 'Child "missing" not found' in result.text


@pytest.mark.asyncio
@pytest.mark.parametrize("producer", ["python", "opencode"])
@pytest.mark.parametrize(
    ("response_char", "response_chars"),
    [("x", MAX_EVENT_BYTES // 2), ("x", MAX_EVENT_BYTES - 20_000), ("🚀", 75_000)],
)
async def test_child_status_near_limit_response_survives_forwarding(
    tmp_path: Path, producer: str, response_char: str, response_chars: int
) -> None:
    text = response_char * response_chars
    detail = {
        "session": {"id": "c1", "title": "Large response", "status": "completed"},
        "finalResponse": {"success": True, "textContent": text},
    }
    args = {"childId": "c1", "includeResponse": True}
    if producer == "python":
        tools, _ = _tools(tmp_path, lambda _r: httpx.Response(200, json=detail))
        output = _text(await tools.get_child_status(args))
        legacy_output = tools._format_child_detail(detail, "c1", args)
    else:
        formatter = (
            Path(__file__).parents[1] / "src/sandbox_runtime/tools/get-child-status-format.js"
        ).as_uri()
        result = subprocess.run(
            [
                "node",
                "--input-type=module",
                "-e",
                f"""
                import {{ readFileSync }} from 'node:fs';
                import {{ childStatusDetailOutput, formatChildDetail }} from {json.dumps(formatter)};
                const detail = JSON.parse(readFileSync(0, 'utf8'));
                process.stdout.write(JSON.stringify([
                    childStatusDetailOutput(detail, 'c1', {{ includeResponse: true }}),
                    formatChildDetail(detail, 'c1', {{ includeResponse: true }}),
                ]));
            """,
            ],
            input=json.dumps(detail),
            text=True,
            capture_output=True,
            check=True,
        )
        output, legacy_output = json.loads(result.stdout)

    event = {
        "type": "tool_call",
        "tool": "get-child-status",
        "args": args,
        "messageId": "m1",
        "callId": "call-1",
        "status": "completed",
        "output": output,
    }
    assert event_size_bytes({**event, "output": legacy_output}) < MAX_EVENT_BYTES
    assert event_size_bytes(event) < MAX_EVENT_BYTES
    envelope = json.loads(output)
    assert envelope["finalResponse"]["textContent"] == text
    assert text not in envelope["agentMessage"]

    forwarder = make_forwarder()
    ws = open_ws()
    await forwarder.bind(ws)
    assert await forwarder.send(event)
    forwarded = sent_events(ws)[0]
    assert "truncated" not in forwarded
    assert json.loads(forwarded["output"])["finalResponse"]["textContent"] == text


@pytest.mark.asyncio
async def test_child_status_list_keeps_unicode_unescaped(tmp_path: Path) -> None:
    title = "日本語 🧪"
    tools, _ = _tools(
        tmp_path,
        lambda _r: httpx.Response(
            200, json={"children": [{"id": "c1", "title": title, "status": "active"}]}
        ),
    )
    output = _text(await tools.get_child_status({}))
    assert title in output
    assert json.loads(output)["children"][0]["title"] == title
