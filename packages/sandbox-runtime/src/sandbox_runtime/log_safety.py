"""Bounded diagnostic copies; never mutate agent messages or their delivery payloads.

This is defense in depth, not a guarantee that arbitrary repository content is
secret-free. Known credentials and recognizable credential fields are redacted.
The formatter applies this to every record, including third-party exceptions.
"""

from __future__ import annotations

import os
import re
from collections import Counter
from collections.abc import Mapping
from pathlib import PurePath
from typing import Any

REDACTED = "[redacted]"
TRUNCATED = "[truncated]"
MAX_LOG_TEXT_CHARS = 2048
MAX_LOG_TOTAL_CHARS = 8192
MAX_LOG_ITEMS = 32
MAX_LOG_DEPTH = 6
MAX_LOG_NODES = 128
MAX_LOG_JSON_BYTES = 65536
_ENV_SECRET_NAME = re.compile(r"TOKEN|SECRET|KEY|PASS|CREDENTIAL|PRIVATE|AUTH|COOKIE|DSN", re.I)
_FIELD_SECRET_NAME = re.compile(
    r"(?:password|passwd|secret|token|apikey|authorization|cookie|privatekey|credentials?|accesskey)$|^(?:key|auth)$",
    re.I,
)
_BEARER = re.compile(r"\b(Bearer\s+)[^\s,;\"']+", re.I)
_URL_CREDENTIAL = re.compile(r"(https?://)[^/\s@]+@", re.I)
_TOKEN = re.compile(r"\b(?:sk-ant-[A-Za-z0-9_-]+|gh[pousr]_[A-Za-z0-9_]+)\b")
_ASSIGNMENT = re.compile(
    r"(?i)\b([\w-]*(?:token|secret|password|api[_-]?key|authorization)\s*[=:]\s*)"
    r"(?:\"[^\"]*\"|'[^']*'|[^\s,;]+)"
)
_PRIVATE_KEY = re.compile(
    r"-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----.*?(?:-----END (?:[A-Z]+ )?PRIVATE KEY-----|\Z)",
    re.S,
)
# Credentials brokered into memory need not appear in os.environ. Registration
# never writes them to a LogRecord or disk.
_registered_secrets: Counter[str] = Counter()


def register_log_secret(value: str) -> None:
    """Retain a known runtime credential only in process memory for redaction."""
    for candidate in (value, *value.splitlines()):
        if candidate:
            _registered_secrets[candidate] += 1


def unregister_log_secret(value: str) -> None:
    """Release a credential once its child and callbacks have been stopped."""
    for candidate in (value, *value.splitlines()):
        if candidate in _registered_secrets:
            _registered_secrets[candidate] -= 1
            if _registered_secrets[candidate] <= 0:
                del _registered_secrets[candidate]


def _known_secrets() -> tuple[str, ...]:
    secrets = set(_registered_secrets)
    for name, value in os.environ.items():
        if _ENV_SECRET_NAME.search(name):
            secrets.update(part for part in (value, *value.splitlines()) if len(part) >= 8)
    return tuple(sorted(secrets, key=len, reverse=True))


def _redact_text(text: str, secrets: tuple[str, ...]) -> str:
    # Redact before truncation: even a secret crossing the preview boundary
    # must not leave its prefix behind.
    for secret in secrets:
        text = text.replace(secret, REDACTED)
    text = _BEARER.sub(r"\1" + REDACTED, text)
    text = _URL_CREDENTIAL.sub(r"\1" + REDACTED + "@", text)
    text = _ASSIGNMENT.sub(r"\1" + REDACTED, text)
    text = _PRIVATE_KEY.sub(REDACTED, text)
    return _TOKEN.sub(REDACTED, text)


def sanitize_log_value(value: Any) -> Any:
    """Return a bounded JSON-safe copy, including nested credential fields.

    Shared character/node budgets prevent wide or cyclic payloads from doing
    unbounded work. Unknown objects are described by type, never by repr.
    """
    secrets = _known_secrets()
    secret_lookahead = max((len(secret) for secret in secrets), default=0)
    remaining_chars = MAX_LOG_TOTAL_CHARS
    remaining_nodes = MAX_LOG_NODES

    def text_preview(text: str) -> str:
        nonlocal remaining_chars
        limit = min(MAX_LOG_TEXT_CHARS, remaining_chars)
        # Look far enough past the preview boundary to redact any known
        # credential crossing it, without scanning a multi-megabyte tool result.
        scan_limit = limit + secret_lookahead
        redacted = _redact_text(text[:scan_limit], secrets)
        remaining_chars -= min(len(redacted), limit)
        if len(text) > scan_limit or len(redacted) > limit:
            return redacted[: max(0, limit - len(TRUNCATED))] + TRUNCATED
        return redacted

    def visit(item: Any, depth: int) -> Any:
        nonlocal remaining_nodes
        if remaining_nodes <= 0 or remaining_chars <= 0 or depth > MAX_LOG_DEPTH:
            return TRUNCATED
        remaining_nodes -= 1
        if isinstance(item, str):
            return text_preview(item)
        if isinstance(item, PurePath):
            return text_preview(str(item))
        if isinstance(item, int) and item.bit_length() > 256:
            return "<large integer>"
        if item is None or isinstance(item, (bool, int, float)):
            return item
        if isinstance(item, Mapping):
            result: dict[str, Any] = {}
            for index, (key, child) in enumerate(item.items()):
                if index >= MAX_LOG_ITEMS or remaining_nodes <= 0 or remaining_chars <= 0:
                    result[TRUNCATED] = True
                    break
                name = key if isinstance(key, str) else f"<{type(key).__name__}>"
                normalized = re.sub(r"[^a-z0-9]", "", name.lower())
                result[text_preview(name)] = (
                    REDACTED if _FIELD_SECRET_NAME.search(normalized) else visit(child, depth + 1)
                )
            return result
        if isinstance(item, (list, tuple)):
            entries: list[Any] = []
            for index, child in enumerate(item):
                if index >= MAX_LOG_ITEMS or remaining_nodes <= 0 or remaining_chars <= 0:
                    entries.append(TRUNCATED)
                    break
                entries.append(visit(child, depth + 1))
            return entries
        return f"<{type(item).__name__}>"

    return visit(value, 0)
