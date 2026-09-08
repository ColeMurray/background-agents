"""Tests for shared child-process log decoding resilience."""

from unittest.mock import MagicMock

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
