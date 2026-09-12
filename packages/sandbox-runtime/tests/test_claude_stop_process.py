"""Pinned SDK cleanup against a local CLI fixture with a real tool descendant.

No model requests or credentials are used. These tests exercise the SDK's actual
subprocess/control protocol, including parent death without descendant death.
"""

from __future__ import annotations

import asyncio
import os
import signal
import sys
from contextlib import suppress
from typing import TYPE_CHECKING, Any
from unittest.mock import MagicMock

import pytest

from sandbox_runtime.harness import HarnessPrompt
from sandbox_runtime.harness.claude import ClaudeHarness, ClaudeHarnessConfig

if TYPE_CHECKING:
    from pathlib import Path


@pytest.mark.skipif(sys.platform == "win32", reason="The runtime owns POSIX subprocesses")
@pytest.mark.asyncio
@pytest.mark.parametrize(
    "mode",
    ["graceful", "rejected", "hung_disconnect", "surviving_descendant", "result_with_active_agent"],
)
async def test_sdk_cleanup_never_mistakes_parent_exit_or_ack_for_tool_cessation(
    tmp_path: Path, mode: str
) -> None:
    child_pid_path = tmp_path / "child.pid"
    mutations_path = tmp_path / "tool-mutations"
    binary = tmp_path / "fixture-cli"
    child_source = (
        "import pathlib,sys,time\n"
        "path = pathlib.Path(sys.argv[1])\n"
        "while True:\n"
        "    path.write_text(str(time.monotonic_ns()))\n"
        "    time.sleep(0.01)\n"
    )
    binary.write_text(
        f"#!{sys.executable}\n"
        "import json,pathlib,subprocess,sys,time\n"
        "if '--version' in sys.argv:\n"
        "    print('2.1.0')\n"
        "    sys.exit(0)\n"
        f"mode = {mode!r}\n"
        "child = None\n"
        "for line in sys.stdin:\n"
        "    message = json.loads(line)\n"
        "    if message['type'] == 'control_request':\n"
        "        interrupt = message['request']['subtype'] == 'interrupt'\n"
        "        if interrupt and mode == 'graceful':\n"
        "            child.terminate()\n"
        "            child.wait()\n"
        "        rejected = interrupt and mode == 'rejected'\n"
        "        response = {'subtype': 'error' if rejected else 'success',\n"
        "                    'request_id': message['request_id'], 'response': {}}\n"
        "        if rejected:\n"
        "            response['error'] = 'interrupt rejected'\n"
        "        print(json.dumps({'type': 'control_response', 'response': response}), flush=True)\n"
        "    elif message['type'] == 'user':\n"
        f"        child = subprocess.Popen([sys.executable, '-c', {child_source!r},\n"
        f"                                  {str(mutations_path)!r}],\n"
        "                                 stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,\n"
        "                                 stderr=subprocess.DEVNULL, start_new_session=True)\n"
        f"        pathlib.Path({str(child_pid_path)!r}).write_text(str(child.pid))\n"
        "        background_agent = mode == 'result_with_active_agent'\n"
        "        print(json.dumps({'type': 'assistant', 'message': {'model': 'fixture',\n"
        "              'content': [{'type': 'tool_use', 'id': 'active',\n"
        "                           'name': 'Agent' if background_agent else 'Bash',\n"
        "                           'input': {'run_in_background': background_agent}}]}}), flush=True)\n"
        "        if background_agent:\n"
        "            print(json.dumps({'type': 'system', 'subtype': 'task_started',\n"
        "                'task_id': 'agent', 'task_type': 'local_agent', 'tool_use_id': 'active',\n"
        "                'description': 'fixture agent', 'uuid': 'uuid', 'session_id': 'sess'}),\n"
        "                flush=True)\n"
        "            print(json.dumps({'type': 'user', 'message': {'role': 'user',\n"
        "                'content': [{'type': 'tool_result', 'tool_use_id': 'active',\n"
        "                             'content': 'agent launched'}]}}), flush=True)\n"
        "            print(json.dumps({'type': 'result', 'subtype': 'success', 'is_error': False,\n"
        "                'duration_ms': 1, 'duration_api_ms': 1, 'num_turns': 1,\n"
        "                'session_id': 'sess', 'total_cost_usd': 0.25}), flush=True)\n"
        "if mode == 'hung_disconnect':\n"
        "    time.sleep(60)\n"
    )
    binary.chmod(0o700)
    harness = ClaudeHarness(
        config=ClaudeHarnessConfig(
            workdir=tmp_path,
            config_dir=tmp_path / "claude",
            mcp_servers=(),
            default_model="claude-sonnet-4-6",
            oauth_managed=False,
        ),
        log=MagicMock(),
        environ={"ANTHROPIC_API_KEY": "unused-fixture-key"},
        binary=binary,
    )
    started = asyncio.Event()

    async def emit(event: dict[str, Any]) -> None:
        if event["type"] == "tool_call":
            started.set()

    await harness.open()
    await harness.create_session()
    turn = asyncio.create_task(harness.run_prompt(HarnessPrompt("turn", "run tool"), emit))
    process = None
    try:
        await asyncio.wait_for(started.wait(), 5)
        # The real SDK owns this process. Retain it for fixture teardown after
        # the harness deliberately keeps uncertain execution quarantined.
        process = harness._client._transport._process
        if mode == "result_with_active_agent":
            outcome = await asyncio.wait_for(turn, 5)
            assert outcome.success is True
            assert outcome.execution_stopped is False
            assert outcome.message_cost_usd == 0.25
        else:
            turn.cancel()
            with pytest.raises(asyncio.CancelledError):
                await turn
        deadline_monotonic = asyncio.get_running_loop().time() + 0.25
        assert await harness.stop(deadline_monotonic) is False
        if mode == "hung_disconnect":
            assert process.returncode is None
        else:
            assert process.returncode == 0
        if mode != "graceful":
            child_pid = int(child_pid_path.read_text())
            os.kill(child_pid, 0)
            async with asyncio.timeout(2):
                while not mutations_path.exists():
                    await asyncio.sleep(0.01)
                previous = mutations_path.read_text()
                while mutations_path.read_text() == previous:
                    await asyncio.sleep(0.01)
            # Even after dropping the SDK transport, repeated Stop cannot
            # convert surviving, mutating tool execution into reusable state.
            assert await harness.stop(asyncio.get_running_loop().time() + 0.1) is False
    finally:
        turn.cancel()
        await asyncio.gather(turn, return_exceptions=True)
        if child_pid_path.exists():
            with suppress(ProcessLookupError):
                os.kill(int(child_pid_path.read_text()), signal.SIGKILL)
        if process is not None and process.returncode is None:
            process.kill()
            await asyncio.wait_for(process.wait(), 2)
        await asyncio.wait_for(harness.close(), 2)
