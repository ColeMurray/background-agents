"""Tests for shared child-process log decoding resilience."""

import json
import logging
from unittest.mock import MagicMock

from sandbox_runtime.log_config import JSONFormatter, get_logger
from sandbox_runtime.log_safety import REDACTED
from sandbox_runtime.opencode_server import OpenCodeServer
from sandbox_runtime.process_output import TRUNCATED_LINE_NOTICE, iter_process_lines


class _ScriptedStream:
    def __init__(self, steps: list) -> None:
        self._steps = list(steps)

    async def readline(self) -> bytes:
        if not self._steps:
            return b""
        step = self._steps.pop(0)
        if isinstance(step, Exception):
            raise step
        return step


async def _collect(log: MagicMock, stream: _ScriptedStream) -> list[str]:
    return [
        line
        async for line in iter_process_lines(
            stream,
            on_error=lambda error: log.warn("test.forward_error", exc=error),
        )
    ]


async def test_oversized_line_does_not_stop_forwarding() -> None:
    stream = _ScriptedStream(
        [
            b"before\n",
            ValueError("Separator is found, but chunk is longer than limit"),
            b"after\n",
        ]
    )

    assert await _collect(MagicMock(), stream) == [
        "before",
        TRUNCATED_LINE_NOTICE,
        "after",
    ]


async def test_undecodable_bytes_are_replaced_not_fatal() -> None:
    lines = await _collect(MagicMock(), _ScriptedStream([b"\xff\xfe partial\n", b"next\n"]))

    assert lines[-1] == "next"
    assert "partial" in lines[0]


async def test_unexpected_reader_error_is_logged_once() -> None:
    log = MagicMock()
    error = RuntimeError("transport closed")

    assert await _collect(log, _ScriptedStream([b"one\n", error])) == ["one"]
    log.warn.assert_called_once_with("test.forward_error", exc=error)


async def test_clean_eof_forwards_all_lines() -> None:
    assert await _collect(MagicMock(), _ScriptedStream([b"alpha\n", b"beta\n"])) == [
        "alpha",
        "beta",
    ]


async def test_opencode_lines_are_structured_correlated_and_redacted(monkeypatch, caplog):
    monkeypatch.setenv("SANDBOX_AUTH_TOKEN", "opencode-runtime-secret")
    server = object.__new__(OpenCodeServer)
    server.log = get_logger("oc-log-test", sandbox_id="sb", session_id="session")
    process = MagicMock()
    process.stdout = _ScriptedStream([b"native opencode-runtime-secret\n", b"\xff second\n"])
    server._opencode_process = process
    with caplog.at_level(logging.INFO, logger="oc-log-test"):
        await server._forward_opencode_logs()
    entries = [json.loads(JSONFormatter().format(record)) for record in caplog.records]
    assert len(entries) == 2
    assert all(entry["event"] == "opencode.output" for entry in entries)
    assert all(
        entry["sandbox_id"] == "sb" and entry["session_id"] == "session" for entry in entries
    )
    assert entries[0]["output"] == f"native {REDACTED}"
    assert entries[0]["harness"] == "opencode" and entries[0]["stream"] == "stdout+stderr"
    assert "second" in entries[1]["output"]


async def test_opencode_log_handler_failure_does_not_stop_pipe_drain():
    server = object.__new__(OpenCodeServer)
    server.log = MagicMock()
    server.log.info.side_effect = RuntimeError("handler failure")
    process = MagicMock()
    process.stdout = _ScriptedStream([b"one\n", b"two\n"])
    server._opencode_process = process
    await server._forward_opencode_logs()
    assert server.log.info.call_count == 2
    assert not process.stdout._steps


async def test_opencode_json_credential_fields_are_redacted_without_registered_values(caplog):
    server = object.__new__(OpenCodeServer)
    server.log = get_logger("oc-json-log-test", sandbox_id="sb", session_id="session")
    process = MagicMock()
    process.stdout = _ScriptedStream(
        [b'{"api_key":"unknown-json-credential","access_token":"unknown-json-token"}\n']
    )
    server._opencode_process = process
    with caplog.at_level(logging.INFO, logger="oc-json-log-test"):
        await server._forward_opencode_logs()
    entries = [JSONFormatter().format(record) for record in caplog.records]
    assert len(entries) == 1
    assert "unknown-json-credential" not in entries[0]
    assert "unknown-json-token" not in entries[0]
    assert REDACTED in entries[0]
