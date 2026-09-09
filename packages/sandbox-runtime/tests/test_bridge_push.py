"""Transport contract for local push results."""

from unittest.mock import AsyncMock, patch

import pytest

from sandbox_runtime.bridge import AgentBridge
from sandbox_runtime.push_operation import PushRequest, PushResult


@pytest.mark.parametrize(
    "metadata,error",
    [
        ({"targetBranch": "feature/test"}, None),
        ({"targetBranch": "feature/test", "repoOwner": "group/sub", "repoName": "repo"}, None),
        ({"targetBranch": "feature/test", "repoOwner": "group/sub", "repoName": "repo"}, "failed"),
        ({"targetBranch": "", "repoOwner": "group/sub"}, "missing branch"),
        ({"repoName": "repo"}, "partial identity"),
        ({}, ""),
    ],
)
async def test_push_dispatch_emits_one_result(metadata, error):
    bridge = AgentBridge("sandbox", "session", "http://localhost:8787", "token")
    bridge._send_event = AsyncMock()
    raw_spec = {"opaque": "passed unchanged"}
    result = PushResult(
        PushRequest(
            metadata.get("targetBranch", ""),
            metadata.get("repoOwner", ""),
            metadata.get("repoName", ""),
            "",
            "",
            "",
            False,
        ),
        error,
    )

    with (
        patch("sandbox_runtime.bridge.PushOperation") as operation,
        patch("sandbox_runtime.bridge.time.time", return_value=123.5) as clock,
    ):
        operation.return_value.execute = AsyncMock(return_value=result)
        await bridge._handle_command({"type": "push", "pushSpec": raw_spec})

    operation.assert_called_once_with(
        repo_path=bridge.repo_path, manifest_path=bridge.repo_manifest_path, logger=bridge.log
    )
    operation.return_value.execute.assert_awaited_once_with(raw_spec)
    assert operation.return_value.execute.await_args.args[0] is raw_spec
    clock.assert_called_once_with()
    bridge._send_event.assert_awaited_once_with(
        {
            "type": "push_complete" if error is None else "push_error",
            "branchName": metadata.get("targetBranch", ""),
            **{key: metadata[key] for key in ("repoOwner", "repoName") if key in metadata},
            **({"error": error} if error is not None else {}),
            "timestamp": 123.5,
        }
    )


@pytest.mark.parametrize("cmd", [{"type": "push"}, {"type": "push", "pushSpec": ["invalid"]}])
async def test_push_passes_missing_or_invalid_spec_to_operation(cmd):
    bridge = AgentBridge("sandbox", "session", "http://localhost:8787", "token")
    bridge._send_event = AsyncMock()
    with patch("sandbox_runtime.bridge.PushOperation") as operation:
        operation.return_value.execute = AsyncMock(
            return_value=PushResult(PushRequest("", "", "", "", "", "", False), "missing spec")
        )
        await bridge._handle_command(cmd)
    operation.return_value.execute.assert_awaited_once_with(cmd.get("pushSpec"))
    bridge._send_event.assert_awaited_once()
