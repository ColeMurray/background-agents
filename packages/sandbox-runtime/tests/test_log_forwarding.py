"""Tests for SandboxSupervisor log-forwarding resilience.

A child process emitting one pathological line (larger than the stream buffer,
or containing undecodable bytes) must not silence the forwarder for the rest of
the process's life. These exercise the shared ``_iter_process_lines`` generator
that every ``_forward_*_logs`` method now reads through.
"""

from unittest.mock import MagicMock, patch

from sandbox_runtime.entrypoint import _TRUNCATED_LINE_NOTICE, SandboxSupervisor


def _make_supervisor() -> SandboxSupervisor:
    """Create a SandboxSupervisor with env vars stubbed out."""
    with patch.dict(
        "os.environ",
        {
            "SANDBOX_ID": "test-sandbox",
            "CONTROL_PLANE_URL": "https://cp.example.com",
            "SANDBOX_AUTH_TOKEN": "tok",
            "REPO_OWNER": "acme",
            "REPO_NAME": "app",
        },
    ):
        return SandboxSupervisor()


class _ScriptedStream:
    """Minimal asyncio.StreamReader stand-in exposing only readline().

    Each step is either bytes to return or an exception to raise, letting a test
    reproduce ``readline`` overflow (ValueError) or an abrupt reader failure
    without wiring up a real subprocess.
    """

    def __init__(self, steps: list) -> None:
        self._steps = list(steps)

    async def readline(self) -> bytes:
        if not self._steps:
            return b""
        step = self._steps.pop(0)
        if isinstance(step, Exception):
            raise step
        return step


async def _collect(sup: SandboxSupervisor, stream: _ScriptedStream) -> list[str]:
    return [
        line async for line in sup._iter_process_lines(stream, error_event="test.forward_error")
    ]


async def test_oversized_line_does_not_stop_forwarding() -> None:
    """A line over the buffer limit is noted, and later lines still forward."""
    sup = _make_supervisor()
    stream = _ScriptedStream(
        [
            b"before\n",
            ValueError("Separator is found, but chunk is longer than limit"),
            b"after\n",
        ]
    )

    assert await _collect(sup, stream) == ["before", _TRUNCATED_LINE_NOTICE, "after"]


async def test_undecodable_bytes_are_replaced_not_fatal() -> None:
    """Invalid UTF-8 is replaced rather than killing the forwarder."""
    sup = _make_supervisor()
    stream = _ScriptedStream([b"\xff\xfe partial\n", b"next\n"])

    lines = await _collect(sup, stream)

    assert lines[-1] == "next"
    assert "partial" in lines[0]


async def test_unexpected_reader_error_is_logged_once() -> None:
    """A non-overflow reader failure ends forwarding after logging it once."""
    sup = _make_supervisor()
    sup.log = MagicMock()
    stream = _ScriptedStream([b"one\n", RuntimeError("transport closed")])

    lines = await _collect(sup, stream)

    assert lines == ["one"]
    sup.log.warn.assert_called_once()


async def test_clean_eof_forwards_all_lines() -> None:
    """The common path: every line is forwarded, decoded and stripped."""
    sup = _make_supervisor()
    stream = _ScriptedStream([b"alpha\n", b"beta\n"])

    assert await _collect(sup, stream) == ["alpha", "beta"]
