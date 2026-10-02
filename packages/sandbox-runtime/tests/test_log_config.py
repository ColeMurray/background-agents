"""Unit tests for structured logging."""

import json
import logging
from io import StringIO

import pytest

from sandbox_runtime.log_config import (
    JSONFormatter,
    StructuredLogger,
    configure_logging,
    get_logger,
)
from sandbox_runtime.log_safety import (
    MAX_LOG_JSON_BYTES,
    MAX_LOG_TEXT_CHARS,
    REDACTED,
    TRUNCATED,
    register_log_secret,
)


@pytest.fixture(autouse=True)
def _reset_root_logger():
    """Reset root logger after each test."""
    original_handlers = logging.root.handlers[:]
    original_level = logging.root.level
    yield
    logging.root.handlers = original_handlers
    logging.root.level = original_level


def _capture_log(logger: StructuredLogger, level: str = "info", **kwargs) -> dict:
    """Capture a single log record as parsed JSON."""
    stream = StringIO()
    handler = logging.StreamHandler(stream)
    handler.setFormatter(JSONFormatter())
    py_logger = logging.getLogger(logger._component)
    py_logger.addHandler(handler)
    py_logger.setLevel(logging.DEBUG)
    try:
        getattr(logger, level)("test.event", **kwargs)
        output = stream.getvalue().strip()
        return json.loads(output)
    finally:
        py_logger.removeHandler(handler)


class TestJSONFormatter:
    def test_aggregate_json_byte_bound_and_cycles(self):
        record = logging.LogRecord("bounded", logging.INFO, __file__, 1, "test.bound", (), None)
        record.payload = {f"field-{i}": "\x00😀" * 10_000 for i in range(100)}
        record.payload["cycle"] = record.payload
        record.message_id = "m1"
        rendered = JSONFormatter().format(record)
        assert len(rendered.encode("utf-8")) <= MAX_LOG_JSON_BYTES
        assert json.loads(rendered)["event"] == "test.bound"
        assert json.loads(rendered)["message_id"] == "m1"
        assert TRUNCATED in rendered

    def test_oversized_correlation_ids_do_not_displace_envelope(self):
        record = _capture_log(
            get_logger("id-budget"),
            sandbox_id="x" * 10_000,
            session_id="x" * 10_000,
            message_id="x" * 10_000,
            agent_session_id="x" * 10_000,
            call_id="x" * 10_000,
            ack_id="x" * 10_000,
        )
        assert record["level"] == "info"
        assert record["event"] == "test.event"
        assert record["component"] == "id-budget"
        assert isinstance(record["ts"], int)

    def test_formatter_failure_never_exposes_raw_record_data(self):
        class BrokenMapping(dict):
            def items(self):
                raise RuntimeError("private failure detail")

        record = logging.LogRecord(
            "bad", logging.INFO, __file__, 1, "raw private payload", (), None
        )
        record.payload = BrokenMapping(secret="raw secret")
        rendered = JSONFormatter().format(record)
        assert json.loads(rendered)["event"] == "log.format_failed"
        assert "private" not in rendered and "raw" not in rendered and "secret" not in rendered

    def test_bad_message_str_does_not_break_formatter(self):
        class BadMessage:
            def __str__(self):
                raise RuntimeError("bad str")

        record = logging.LogRecord("bad", logging.INFO, __file__, 1, BadMessage(), (), None)
        assert json.loads(JSONFormatter().format(record))["event"] == "log.unformattable_message"

    def test_formatter_redacts_all_fields_including_exceptions(self, monkeypatch):
        monkeypatch.setenv("SANDBOX_AUTH_TOKEN", "formatter-env-secret")
        register_log_secret("formatter-brokered-secret")
        record = _capture_log(
            get_logger("safe-formatter"),
            level="error",
            exc=ValueError("formatter-env-secret formatter-brokered-secret"),
            args_preview={"api_key": "unknown-key", "command": "formatter-env-secret"},
            output="x" * (MAX_LOG_TEXT_CHARS + 100),
        )
        serialized = json.dumps(record)
        for secret in ("formatter-env-secret", "formatter-brokered-secret", "unknown-key"):
            assert secret not in serialized
        assert record["args_preview"]["api_key"] == REDACTED
        assert record["output"].endswith(TRUNCATED)
        assert record["error_type"] == "ValueError"

    def test_third_party_python_logs_use_the_same_redaction(self, monkeypatch):
        monkeypatch.setenv("PROVIDER_SECRET", "third-party-secret")
        record = logging.LogRecord(
            "third-party",
            logging.WARNING,
            __file__,
            1,
            "failure: %s",
            ("third-party-secret",),
            None,
        )
        rendered = json.loads(JSONFormatter().format(record))
        assert rendered["event"] == f"failure: {REDACTED}"

    def test_exception_secret_is_redacted_before_stack_truncation(self, monkeypatch):
        secret = "unique-exception-credential-material" * 150
        monkeypatch.setenv("LONG_SECRET", secret)
        record = _capture_log(get_logger("stack-safety"), level="error", exc=ValueError(secret))
        assert "unique-exception-credential-material" not in json.dumps(record)
        assert record["error_message"] == REDACTED

    def test_basic_fields(self):
        log = get_logger("test-component")
        record = _capture_log(log)
        assert record["level"] == "info"
        assert record["service"] == "modal-infra"
        assert record["component"] == "test-component"
        assert record["event"] == "test.event"
        assert isinstance(record["ts"], int)

    def test_extra_fields_included(self):
        log = get_logger("test")
        record = _capture_log(log, sandbox_id="sb-123", duration_ms=42)
        assert record["sandbox_id"] == "sb-123"
        assert record["duration_ms"] == 42

    def test_exception_fields(self):
        log = get_logger("test")
        stream = StringIO()
        handler = logging.StreamHandler(stream)
        handler.setFormatter(JSONFormatter())
        py_logger = logging.getLogger("test")
        py_logger.addHandler(handler)
        py_logger.setLevel(logging.DEBUG)
        try:
            exc = ValueError("something broke")
            log.error("test.error", exc=exc, extra_field="val")
            output = stream.getvalue().strip()
            record = json.loads(output)
            assert record["level"] == "error"
            assert record["error_type"] == "ValueError"
            assert record["error_message"] == "something broke"
            assert "error_stack" in record
            assert record["extra_field"] == "val"
        finally:
            py_logger.removeHandler(handler)

    def test_output_is_single_line_json(self):
        log = get_logger("test-json")
        stream = StringIO()
        handler = logging.StreamHandler(stream)
        handler.setFormatter(JSONFormatter())
        py_logger = logging.getLogger("test-json")
        py_logger.addHandler(handler)
        py_logger.setLevel(logging.DEBUG)
        try:
            log.info("test.event", key="value")
            output = stream.getvalue().strip()
            assert "\n" not in output
            json.loads(output)  # should not raise
        finally:
            py_logger.removeHandler(handler)

    def test_default_str_serialization(self):
        """json.dumps(default=str) handles non-serializable types."""
        from pathlib import Path

        log = get_logger("test-ser")
        stream = StringIO()
        handler = logging.StreamHandler(stream)
        handler.setFormatter(JSONFormatter())
        py_logger = logging.getLogger("test-ser")
        py_logger.addHandler(handler)
        py_logger.setLevel(logging.DEBUG)
        try:
            log.info("test.event", path=Path("/tmp/foo"))
            output = stream.getvalue().strip()
            record = json.loads(output)
            assert record["path"] == "/tmp/foo"
        finally:
            py_logger.removeHandler(handler)


class TestStructuredLogger:
    def test_get_logger_factory(self):
        log = get_logger("my-component", sandbox_id="sb-1")
        assert isinstance(log, StructuredLogger)
        assert log._component == "my-component"
        assert log._context == {"sandbox_id": "sb-1"}

    def test_bind_mutates_context(self):
        log = get_logger("test")
        log.bind(session_id="ses-1")
        record = _capture_log(log)
        assert record["session_id"] == "ses-1"

    def test_child_creates_new_logger(self):
        log = get_logger("parent", sandbox_id="sb-1")
        child = log.child(message_id="msg-1")
        # Child has merged context
        assert child._context == {"sandbox_id": "sb-1", "message_id": "msg-1"}
        # Parent is unchanged
        assert "message_id" not in log._context

    def test_all_log_levels(self):
        for level in ("debug", "info", "warn", "error"):
            log = get_logger(f"test-{level}")
            stream = StringIO()
            handler = logging.StreamHandler(stream)
            handler.setFormatter(JSONFormatter())
            py_logger = logging.getLogger(f"test-{level}")
            py_logger.addHandler(handler)
            py_logger.setLevel(logging.DEBUG)
            try:
                if level == "error":
                    getattr(log, level)("test.event")
                else:
                    getattr(log, level)("test.event")
                output = stream.getvalue().strip()
                record = json.loads(output)
                expected_level = "warning" if level == "warn" else level
                assert record["level"] == expected_level
            finally:
                py_logger.removeHandler(handler)

    def test_context_fields_in_output(self):
        log = get_logger("ctx-test", sandbox_id="sb-1", session_id="ses-1")
        record = _capture_log(log)
        assert record["sandbox_id"] == "sb-1"
        assert record["session_id"] == "ses-1"

    def test_kwarg_overrides_context(self):
        log = get_logger("override-test", sandbox_id="sb-1")
        record = _capture_log(log, sandbox_id="sb-override")
        assert record["sandbox_id"] == "sb-override"


class TestConfigureLogging:
    def test_configures_root_logger(self):
        configure_logging()
        assert len(logging.root.handlers) == 1
        assert isinstance(logging.root.handlers[0].formatter, JSONFormatter)
        assert logging.root.level == logging.INFO

    def test_replaces_existing_handlers(self):
        logging.root.addHandler(logging.StreamHandler())
        logging.root.addHandler(logging.StreamHandler())
        assert len(logging.root.handlers) >= 2
        configure_logging()
        assert len(logging.root.handlers) == 1
