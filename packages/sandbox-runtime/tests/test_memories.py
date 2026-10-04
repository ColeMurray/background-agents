import json
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock

import httpx
import pytest

from sandbox_runtime.harness.claude_tools import (
    ControlPlaneToolClient,
    ToolServerConfig,
    build_tools,
)
from sandbox_runtime.memories import (
    MemoryMaterializer,
    RenderedSessionMemory,
    SessionMemoryClient,
    append_memory,
    memory_text,
)
from sandbox_runtime.memory_contract import MEMORY_TOOL_SPECS, RENDERED_MEMORY_MAX_CHARS

MANIFEST_SHA256 = "a" * 64


def rendered_response(rendered: object) -> dict:
    return {"schemaVersion": 1, "manifestSha256": MANIFEST_SHA256, "rendered": rendered}


def materializer(path: Path, handler: object) -> MemoryMaterializer:
    client = SessionMemoryClient(
        "https://control.test",
        "session/a",
        "test-token",
        transport=httpx.MockTransport(handler),
    )
    return MemoryMaterializer(client, path / "oi-memory.md", MagicMock())


def tool_client(tmp_path: Path, handler: object) -> ControlPlaneToolClient:
    return ControlPlaneToolClient(
        ToolServerConfig(
            "https://control.test", "session", "token", tmp_path / "repos.json", False, False
        ),
        MagicMock(),
        httpx.AsyncClient(transport=httpx.MockTransport(handler)),
    )


async def test_authenticated_fetch_replaces_stale_memory(tmp_path: Path) -> None:
    (tmp_path / "oi-memory.md").write_text("stale")

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.raw_path == b"/sessions/session%2Fa/sandbox-memory"
        assert request.headers["Authorization"] == "Bearer test-token"
        return httpx.Response(200, json=rendered_response("exact rendered text\n"))

    await materializer(tmp_path, handler).materialize()
    assert memory_text(tmp_path) == "exact rendered text\n"
    assert (tmp_path / "oi-memory.md").stat().st_mode & 0o777 == 0o600
    assert append_memory("guidance", tmp_path) == "guidance\n\nexact rendered text\n"


async def test_empty_memory_removes_restored_memory_and_staging(tmp_path: Path) -> None:
    (tmp_path / "oi-memory.md").write_text("another session's memory")
    (tmp_path / ".oi-memory.md-abandoned.tmp").write_text("stale private memory")
    await materializer(
        tmp_path, lambda _: httpx.Response(200, json=rendered_response(""))
    ).materialize()
    assert not (tmp_path / "oi-memory.md").exists()
    assert not list(tmp_path.glob("*.tmp"))
    assert append_memory(None, tmp_path) is None
    assert append_memory("guidance", tmp_path) == "guidance"


@pytest.mark.parametrize(
    "status,body",
    [
        (404, {"error": "Not found"}),
        (403, {"error": "Forbidden"}),
        (200, {**rendered_response("unsafe"), "schemaVersion": 2}),
        (200, rendered_response([])),
        (200, {"schemaVersion": 1, "rendered": "no manifest"}),
        (200, rendered_response("x" * (RENDERED_MEMORY_MAX_CHARS + 1))),
    ],
)
async def test_failed_or_invalid_response_never_keeps_stale_file(
    tmp_path: Path, status: int, body: dict
) -> None:
    (tmp_path / "oi-memory.md").write_text("stale")
    requests = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(status, json=body)

    with pytest.raises(RuntimeError):
        await materializer(tmp_path, handler).materialize()
    assert not (tmp_path / "oi-memory.md").exists()
    assert len(requests) == 1


async def test_transient_failures_retry_with_the_shared_policy(tmp_path: Path, monkeypatch) -> None:
    statuses = iter([408, 503])

    def handler(_request: httpx.Request) -> httpx.Response:
        status = next(statuses, 200)
        return httpx.Response(status, json=rendered_response("recovered") if status == 200 else {})

    sleep = AsyncMock()
    monkeypatch.setattr("sandbox_runtime.control_plane_fetch.asyncio.sleep", sleep)
    await materializer(tmp_path, handler).materialize()
    assert memory_text(tmp_path) == "recovered"
    assert [call.args[0] for call in sleep.await_args_list] == [0.25, 0.5]


async def test_exhausted_retries_and_oversized_responses_fail(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr("sandbox_runtime.control_plane_fetch.asyncio.sleep", AsyncMock())
    with pytest.raises(RuntimeError, match="could not be loaded"):
        await materializer(tmp_path, lambda _: httpx.Response(503)).materialize()
    monkeypatch.setattr("sandbox_runtime.memories.MAX_MEMORY_RESPONSE_BYTES", 10)
    with pytest.raises(RuntimeError, match="could not be loaded"):
        await materializer(
            tmp_path, lambda _: httpx.Response(200, json=rendered_response("too large"))
        ).materialize()


async def test_staging_symlinks_do_not_overwrite_their_targets(tmp_path: Path) -> None:
    target = tmp_path / "unrelated.txt"
    target.write_text("do not modify")
    (tmp_path / ".oi-memory.md-restored.tmp").symlink_to(target)
    await materializer(
        tmp_path, lambda _: httpx.Response(200, json=rendered_response("private"))
    ).materialize()
    assert target.read_text() == "do not modify"
    assert memory_text(tmp_path) == "private"
    assert not list(tmp_path.glob("*.tmp"))
    assert (tmp_path / "oi-memory.md").stat().st_mode & 0o777 == 0o600


async def test_failed_install_removes_private_staging_file(tmp_path: Path, monkeypatch) -> None:
    def fail_replace(self, destination):
        raise OSError("write failed")

    monkeypatch.setattr(Path, "replace", fail_replace)
    with pytest.raises(OSError, match="write failed"):
        await materializer(
            tmp_path, lambda _: httpx.Response(200, json=rendered_response("private"))
        ).materialize()
    assert not list(tmp_path.glob("*.tmp"))
    assert memory_text(tmp_path) is None


def test_memory_is_disabled_without_a_control_plane_session(tmp_path: Path) -> None:
    from sandbox_runtime.entrypoint import _build_memory

    log = MagicMock()
    config = MagicMock(control_plane_url="", session_id="session")
    assert _build_memory(config, tmp_path, log) is None
    log.info.assert_called_once_with("memory.disabled", reason="no_control_plane_session")


async def test_claude_memory_tools_are_the_generated_specs(tmp_path: Path) -> None:
    client = tool_client(tmp_path, lambda _: httpx.Response(200))
    try:
        tools = build_tools(client)
    finally:
        await client.aclose()
    memory_tools = tools[-len(MEMORY_TOOL_SPECS) :]
    assert [(tool.name, tool.description, tool.input_schema) for tool in memory_tools] == [
        (spec["name"], spec["description"], spec["inputSchema"]) for spec in MEMORY_TOOL_SPECS
    ]


@pytest.mark.parametrize(
    "selector",
    [
        {"scopeType": "personal"},
        {"scopeType": "environment"},
        {"scopeType": "repository", "repoOwner": "group/subgroup", "repoName": "api"},
    ],
)
async def test_claude_write_sends_flat_arguments_without_caller_identity(
    tmp_path: Path, selector: dict
) -> None:
    content = {
        "memoryType": "fact",
        "title": "Test setup",
        "description": "Start the database",
        "content": "Body",
    }
    sent = []

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.method == "POST"
        assert request.url.raw_path == b"/sessions/session/sandbox-memory"
        assert request.headers["Authorization"] == "Bearer token"
        sent.append(json.loads(request.content))
        return httpx.Response(201, json={"status": "proposed"})

    client = tool_client(tmp_path, handler)
    try:
        write = {tool.name: tool for tool in build_tools(client)}["memory_write"]
        result = await write.handler(
            {
                **selector,
                **content,
                "environmentId": "attacker",
                "ownerUserId": "attacker",
                "sessionId": "other",
            }
        )
    finally:
        await client.aclose()
    assert sent == [{**selector, **content}]
    assert "is_error" not in result
    assert json.loads(result["content"][0]["text"]) == {"status": "proposed"}


async def test_claude_read_fills_the_encoded_path_parameter(tmp_path: Path) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.method == "GET"
        assert request.url.raw_path == b"/sessions/session/sandbox-memory/mem%2Fa"
        assert request.content == b""
        return httpx.Response(200, json={"content": "Fact body"})

    client = tool_client(tmp_path, handler)
    try:
        read = {tool.name: tool for tool in build_tools(client)}["memory_read"]
        result = await read.handler({"memoryId": "mem/a"})
    finally:
        await client.aclose()
    assert json.loads(result["content"][0]["text"]) == {"content": "Fact body"}


async def test_claude_search_strips_caller_identity(tmp_path: Path) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.raw_path == b"/sessions/session/sandbox-memory/search"
        assert json.loads(request.content) == {"query": "billing webhook", "limit": 5}
        return httpx.Response(200, json={"results": [], "hasMore": False})

    client = tool_client(tmp_path, handler)
    try:
        search = {tool.name: tool for tool in build_tools(client)}["memory_search"]
        result = await search.handler(
            {
                "query": "billing webhook",
                "limit": 5,
                "ownerUserId": "attacker",
                "environmentId": "other",
                "sessionId": "other",
            }
        )
    finally:
        await client.aclose()
    assert json.loads(result["content"][0]["text"]) == {"results": [], "hasMore": False}


@pytest.mark.parametrize("unavailable", [False, True])
async def test_claude_memory_tool_reports_failures(tmp_path: Path, unavailable: bool) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if unavailable:
            raise httpx.ConnectError("private transport details", request=request)
        return httpx.Response(403, json={"error": "Personal memory is excluded from this session"})

    client = tool_client(tmp_path, handler)
    try:
        read = {tool.name: tool for tool in build_tools(client)}["memory_read"]
        result = await read.handler({"memoryId": "mem_denied"})
    finally:
        await client.aclose()
    assert result["is_error"] is True
    assert result["content"][0]["text"] == (
        "memory_read failed (unavailable)"
        if unavailable
        else "memory_read failed (403): Personal memory is excluded from this session"
    )


@pytest.mark.parametrize("text", ["", "# Memory\n\nA pinned directive\n"])
async def test_both_harnesses_receive_exact_memory_and_empty_parity(tmp_path, monkeypatch, text):
    from unittest.mock import patch

    from sandbox_runtime.claude_stager import ClaudeHarnessHandoff
    from sandbox_runtime.harness import BridgeIdentity, build_agent_harness
    from sandbox_runtime.harness.base import HarnessId, PromptLimits
    from tests.runtime_helpers import make_opencode_server

    config_dir = tmp_path / "config"
    config_dir.mkdir()
    if text:
        (config_dir / "oi-memory.md").write_text(text)
    (tmp_path / "AGENTS.md").write_text("Repository guidance")
    monkeypatch.setattr(
        "sandbox_runtime.opencode_server.resolve_opencode_global_config_dir", lambda: config_dir
    )
    server = make_opencode_server({}, workspace_path=tmp_path)
    with (
        patch.object(server, "_setup_managed_oauth"),
        patch.object(server, "_prepare_opencode_filesystem", return_value=set()),
        patch.object(server, "_wait_for_health", new_callable=AsyncMock),
        patch(
            "sandbox_runtime.opencode_server.asyncio.create_subprocess_exec",
            new_callable=AsyncMock,
            return_value=MagicMock(stdout=None),
        ) as spawn,
        patch(
            "sandbox_runtime.opencode_server.asyncio.create_task",
            side_effect=lambda coro: coro.close(),
        ),
    ):
        await server.start((), tmp_path)
    config = json.loads(spawn.call_args.kwargs["env"]["OPENCODE_CONFIG_CONTENT"])
    if text:
        assert [Path(path).read_text() for path in config["instructions"]] == [text]
    else:
        assert "instructions" not in config
    with (
        patch(
            "sandbox_runtime.harness.ClaudeHarnessHandoff.read",
            return_value=ClaudeHarnessHandoff(tmp_path, config_dir, False),
        ),
        patch("sandbox_runtime.harness.ClaudeHarness") as claude,
    ):
        build_agent_harness(
            HarnessId.CLAUDE,
            identity=BridgeIdentity(
                "sandbox", "session", "https://control.test", "token", tmp_path / "repos.json"
            ),
            attachment_processor=MagicMock(),
            log=MagicMock(),
            limits=PromptLimits(60, 120, 10),
            opencode_port=4096,
        )
    assert claude.call_args.kwargs[
        "config"
    ].system_prompt_append == "Workspace guidance (AGENTS.md):\n\nRepository guidance" + (
        "\n\n" + text if text else ""
    )


class FakeInstallationSource:
    def __init__(self, result: RenderedSessionMemory | Exception) -> None:
        self.result = result

    async def fetch_rendered(self) -> RenderedSessionMemory:
        if isinstance(self.result, Exception):
            raise self.result
        return self.result


async def test_materializer_installs_from_any_injected_source(tmp_path: Path) -> None:
    destination = tmp_path / "oi-memory.md"
    destination.write_text("stale")
    log = MagicMock()
    source = FakeInstallationSource(RenderedSessionMemory(MANIFEST_SHA256, "pinned\n"))
    await MemoryMaterializer(source, destination, log).materialize()
    assert destination.read_text() == "pinned\n"
    log.info.assert_called_once_with(
        "memory.materialized", manifest_sha256=MANIFEST_SHA256, rendered_chars=7
    )

    destination.write_text("stale")
    failing = FakeInstallationSource(RuntimeError("Session memory could not be loaded"))
    with pytest.raises(RuntimeError):
        await MemoryMaterializer(failing, destination, log).materialize()
    assert not destination.exists()
