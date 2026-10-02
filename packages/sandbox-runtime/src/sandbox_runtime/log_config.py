"""
Structured JSON logging for Open-Inspect modal-infra.

Uses Python's standard logging module with a custom JSONFormatter and a thin
StructuredLogger wrapper for a clean call-site API. Third-party library logs
(httpx, websockets) automatically flow through the same JSON pipeline.

Usage:
    from .log_config import configure_logging, get_logger

    configure_logging()  # call once at process startup
    log = get_logger("bridge", sandbox_id="sb-123")
    log.info("bridge.connect", ws_url="wss://...")
    log.error("bridge.error", exc=e, attempt=3)
"""

import contextlib
import json
import logging
import sys
from typing import Any

from .log_safety import MAX_LOG_JSON_BYTES, TRUNCATED, sanitize_log_value

# Standard LogRecord attributes to exclude from extra fields.
# Built from a blank LogRecord's __dict__ plus our custom underscore-prefixed attrs.
_STANDARD_ATTRS = {
    "args",
    "created",
    "exc_info",
    "exc_text",
    "filename",
    "funcName",
    "levelname",
    "levelno",
    "lineno",
    "message",
    "module",
    "msecs",
    "msg",
    "name",
    "pathname",
    "process",
    "processName",
    "relativeCreated",
    "stack_info",
    "taskName",
    "thread",
    "threadName",
    # Our internal attributes (prefixed with _)
    "_component",
    "_service",
}
_CORRELATION_FIELDS = (
    "sandbox_id",
    "session_id",
    "message_id",
    "agent_session_id",
    "call_id",
    "ack_id",
)
_ENVELOPE_FIELDS = ("level", "service", "component", "event", "ts")


class JSONFormatter(logging.Formatter):
    """Formats log records as single-line JSON with envelope fields."""

    def format(self, record: logging.LogRecord) -> str:
        try:
            return self._format(record)
        except Exception:
            # Never let logging.handleError print raw message/args when a
            # hostile payload or formatter fails. This fallback contains no
            # data from the failing record.
            return '{"level":"error","service":"sandbox-runtime","component":"logging","event":"log.format_failed"}'

    def _format(self, record: logging.LogRecord) -> str:
        try:
            event = record.getMessage()
        except Exception:
            event = "log.unformattable_message"
        output: dict[str, Any] = {
            "level": record.levelname.lower(),
            "service": getattr(record, "_service", "modal-infra"),
            "component": getattr(record, "_component", record.name),
            "event": event,
            "ts": int(record.created * 1000),
        }
        # Merge extra fields from record.__dict__ (skip standard attrs)
        for key, value in record.__dict__.items():
            if key not in _STANDARD_ATTRS and key not in output and not key.startswith("_"):
                output[key] = value
        # Extract exception info
        if record.exc_info and record.exc_info[1]:
            exc = record.exc_info[1]
            output["error_type"] = type(exc).__qualname__
            try:
                output["error_message"] = str(exc)
                output["error_stack"] = self.formatException(record.exc_info)
            except Exception:
                output["error_message"] = "<unformattable exception>"
        # Keep the envelope first, then IDs, then potentially enormous payloads.
        priority = _ENVELOPE_FIELDS + _CORRELATION_FIELDS
        output = {**{key: output[key] for key in priority if key in output}, **output}
        safe = sanitize_log_value(output)
        rendered = json.dumps(safe, ensure_ascii=False)
        # Enforce a final byte ceiling too (JSON escaping and large numeric
        # payloads need not match the text budget). Preserve correlation fields.
        if len(rendered.encode("utf-8")) > MAX_LOG_JSON_BYTES:
            kept = {key: value for key, value in safe.items() if key in priority}
            kept["log_payload"] = TRUNCATED
            rendered = json.dumps(sanitize_log_value(kept), ensure_ascii=False)
        return rendered


def configure_logging() -> None:
    """Configure root logger with JSON output to stdout.

    Call once at process startup (entrypoint, bridge, web_api module load).
    Replaces any existing handlers on the root logger.
    """
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(JSONFormatter())
    logging.root.handlers = [handler]
    logging.root.setLevel(logging.INFO)


class StructuredLogger:
    """Thin wrapper over logging.Logger providing a clean structured API.

    Uses standard logging infrastructure underneath -- all output goes
    through Python's logging handlers/formatters.

    Usage:
        log = StructuredLogger("bridge", context={"sandbox_id": "sb-123"})
        log.info("bridge.connect", ws_url="wss://...")
        log.bind(opencode_session_id="ses_abc")
        child = log.child(message_id="msg-1")
    """

    def __init__(
        self,
        component: str,
        service: str = "modal-infra",
        context: dict[str, Any] | None = None,
    ):
        self._component = component
        self._service = service
        self._context: dict[str, Any] = dict(context) if context else {}
        self._logger = logging.getLogger(component)

    def bind(self, **ctx: Any) -> None:
        """Mutate context in-place (e.g., for late-bound correlation IDs)."""
        self._context.update(ctx)

    def child(self, **ctx: Any) -> "StructuredLogger":
        """Create a new logger with merged context."""
        merged = {**self._context, **ctx}
        return StructuredLogger(self._component, self._service, context=merged)

    def debug(self, event: str, **kw: Any) -> None:
        self._log(logging.DEBUG, event, **kw)

    def info(self, event: str, **kw: Any) -> None:
        self._log(logging.INFO, event, **kw)

    def warn(self, event: str, **kw: Any) -> None:
        self._log(logging.WARNING, event, **kw)

    def error(self, event: str, exc: BaseException | None = None, **kw: Any) -> None:
        self._log(logging.ERROR, event, exc=exc, **kw)

    def _log(
        self,
        level: int,
        event: str,
        exc: BaseException | None = None,
        **kw: Any,
    ) -> None:
        extra = {
            **self._context,
            **kw,
            "_component": self._component,
            "_service": self._service,
        }
        # A broken handler must not break sandbox execution. No raw fallback.
        with contextlib.suppress(Exception):
            self._logger.log(
                level,
                event,
                extra=extra,
                exc_info=(type(exc), exc, exc.__traceback__) if exc else None,
            )


def get_logger(component: str, **context: Any) -> StructuredLogger:
    """Factory function to create a structured logger.

    Args:
        component: Logger component name (e.g., "bridge", "manager", "supervisor")
        **context: Initial context fields (e.g., sandbox_id="sb-123")
    """
    return StructuredLogger(component, context=context if context else None)
