from pathlib import Path
from unittest.mock import MagicMock

import httpx
import pytest

from sandbox_runtime.memories import MemoryMaterializer, append_memory, memory_text


def materializer(path: Path, handler: object) -> MemoryMaterializer:
    return MemoryMaterializer(
        "https://control.test",
        "session/a",
        "test-token",
        path,
        MagicMock(),
        transport=httpx.MockTransport(handler),
    )


@pytest.mark.asyncio
async def test_authenticated_fetch_replaces_stale_memory(tmp_path: Path) -> None:
    (tmp_path / "oi-memory.md").write_text("stale")

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.raw_path == b"/sessions/session%2Fa/sandbox-memory"
        assert request.headers["Authorization"] == "Bearer test-token"
        return httpx.Response(200, json={"schemaVersion": 1, "rendered": "exact rendered text\n"})

    await materializer(tmp_path, handler).materialize()
    assert memory_text(tmp_path) == "exact rendered text\n"
    assert (tmp_path / "oi-memory.md").stat().st_mode & 0o777 == 0o600
    assert append_memory("guidance", tmp_path) == "guidance\n\nexact rendered text\n"


@pytest.mark.asyncio
@pytest.mark.parametrize("status,body", [(404, {}), (200, {"schemaVersion": 1, "rendered": ""})])
async def test_empty_or_old_server_removes_restored_memory(
    tmp_path: Path, status: int, body: dict
) -> None:
    (tmp_path / "oi-memory.md").write_text("another session's memory")
    await materializer(tmp_path, lambda _: httpx.Response(status, json=body)).materialize()
    assert not (tmp_path / "oi-memory.md").exists()
    assert append_memory(None, tmp_path) is None
    assert append_memory("guidance", tmp_path) == "guidance"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "status,body",
    [
        (403, {}),
        (200, {"schemaVersion": 2, "rendered": "unsafe"}),
        (200, {"schemaVersion": 1, "rendered": []}),
    ],
)
async def test_invalid_or_unauthorized_response_never_keeps_stale_file(
    tmp_path: Path, status: int, body: dict
) -> None:
    (tmp_path / "oi-memory.md").write_text("stale")
    with pytest.raises(RuntimeError):
        await materializer(tmp_path, lambda _: httpx.Response(status, json=body)).materialize()
    assert not (tmp_path / "oi-memory.md").exists()


@pytest.mark.asyncio
async def test_both_claude_tools_use_session_bound_transport(tmp_path: Path) -> None:
    from sandbox_runtime.harness.claude_tools import (
        ControlPlaneToolClient,
        ToolServerConfig,
        build_tools,
    )

    requests = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(200, json={"status": "proposed"})

    config = ToolServerConfig(
        "https://control.test", "session", "token", tmp_path / "repos.json", False, False
    )
    client = ControlPlaneToolClient(
        config, MagicMock(), httpx.AsyncClient(transport=httpx.MockTransport(handler))
    )
    tools = {entry.name: entry for entry in build_tools(client)}
    await tools["memory_read"].handler({"memoryId": "mem/a"})
    await tools["memory_write"].handler(
        {
            "scope": "personal",
            "memoryType": "fact",
            "title": "Fact",
            "description": "Useful fact",
            "content": "Body",
            "ownerUserId": "attacker",
        }
    )
    assert requests[0].url.raw_path.endswith(b"/sandbox-memory/mem%2Fa")
    assert requests[1].headers["Authorization"] == "Bearer token"
    assert b"attacker" not in requests[1].content
    assert b'"type":"personal"' in requests[1].content
    await client.aclose()


@pytest.mark.asyncio
@pytest.mark.parametrize("text", ["", "# Memory\n\nA pinned directive\n"])
async def test_both_harnesses_receive_exact_memory_and_empty_parity(tmp_path, monkeypatch, text):
    import json
    from unittest.mock import AsyncMock, patch

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


@pytest.mark.asyncio
@pytest.mark.parametrize("unavailable", [False, True])
async def test_claude_memory_tool_reports_server_errors(tmp_path: Path, unavailable: bool) -> None:
    from sandbox_runtime.harness.claude_tools import ControlPlaneToolClient, ToolServerConfig
    from sandbox_runtime.harness.memory_tools import build_memory_tools

    def handler(request: httpx.Request) -> httpx.Response:
        if unavailable:
            raise httpx.ConnectError("private transport details", request=request)
        return httpx.Response(403, json={"error": "Personal memory is excluded from this session"})

    client = ControlPlaneToolClient(
        ToolServerConfig(
            "https://control.test", "session", "token", tmp_path / "repos.json", False, False
        ),
        MagicMock(),
        httpx.AsyncClient(transport=httpx.MockTransport(handler)),
    )
    try:
        result = await build_memory_tools(client)[0].handler({"memoryId": "mem_denied"})
        assert result["isError"] is True
        assert result["content"][0]["text"] == (
            "Memory request failed (unavailable)"
            if unavailable
            else "Memory request failed (403: Personal memory is excluded from this session)"
        )
    finally:
        await client.aclose()


def test_opencode_tools_use_session_transport_and_strip_caller_identity():
    import json
    import os
    import shutil
    import subprocess

    binary = shutil.which("node")
    if not binary:
        pytest.skip("node is required for OpenCode tool transport")
    module = Path(__file__).parents[1] / "src/sandbox_runtime/tools/_memory.js"
    script = """
      const requests = [];
      globalThis.fetch = async (url, init) => {
        requests.push({ url, authorization: init.headers.get("Authorization"), body: init.body });
        return Response.json({ status: "proposed" });
      };
      const { readMemory, writeMemory } = await import(process.argv[1]);
      await readMemory({ memoryId: "mem/a" });
      await writeMemory({ scope: "repository", repoOwner: "group/subgroup", repoName: "api", memoryType: "fact", title: "Test setup", description: "Start the database", content: "Body", ownerUserId: "attacker", sessionId: "other" });
      console.log(JSON.stringify(requests));
    """
    result = subprocess.run(
        [binary, "--input-type=module", "-e", script, module.as_uri()],
        capture_output=True,
        text=True,
        check=True,
        timeout=10,
        env={
            **os.environ,
            "CONTROL_PLANE_URL": "https://control.test",
            "SANDBOX_AUTH_TOKEN": "test-token",
            "SESSION_CONFIG": '{"session_id":"bound-session"}',
        },
    )
    requests = json.loads(result.stdout)
    assert (
        requests[0]["url"] == "https://control.test/sessions/bound-session/sandbox-memory/mem%2Fa"
    )
    assert requests[1]["authorization"] == "Bearer test-token"
    body = json.loads(requests[1]["body"])
    assert body["scope"] == {"type": "repository", "repoOwner": "group/subgroup", "repoName": "api"}
    assert "ownerUserId" not in body and "sessionId" not in body
