"""Bounded diagnostic copies; never mutate agent messages or their delivery payloads.

This is defense in depth, not a guarantee that arbitrary repository content is
secret-free. Known credentials and recognizable credential fields are redacted.
The formatter applies this to every record, including third-party exceptions.
"""

from __future__ import annotations

import math
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
    r"(?i)\b((?:[\w-]*(?:token|secret|password|passwd|api[_-]?key|authorization|cookie|"
    r"private[_-]?key|credentials?|access[_-]?key)|key|auth)[\"']?\s*[=:]\s*)"
    r"(?:\"(?:\\[\s\S]|[^\"\\])*(?:\"|\\?\Z)|'(?:\\[\s\S]|[^'\\])*(?:'|\\?\Z)|"
    r"[{\[][\s\S]*\Z|[^\s,;}\]]+)"
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


def _redact_text(
    text: str,
    source_limit: int,
    secret_pattern: re.Pattern[str] | None,
    secret_lookahead: int,
) -> tuple[str, bool]:
    # Keep the cutoff in source coordinates. Replacing an earlier credential
    # must never pull partially scanned later credentials into the preview.
    parts: list[str] = []
    cursor = 0
    source_end = min(source_limit, len(text))
    if secret_pattern is not None:
        for match in secret_pattern.finditer(text[: source_limit + secret_lookahead]):
            if match.start() >= source_limit:
                break
            parts.extend((text[cursor : match.start()], REDACTED))
            cursor = match.end()
            source_end = max(source_end, cursor)
    parts.append(text[cursor:source_limit])
    preview = "".join(parts)
    preview = _BEARER.sub(r"\1" + REDACTED, preview)
    preview = _URL_CREDENTIAL.sub(r"\1" + REDACTED + "@", preview)
    preview = _ASSIGNMENT.sub(r"\1" + REDACTED, preview)
    preview = _PRIVATE_KEY.sub(REDACTED, preview)
    return _TOKEN.sub(REDACTED, preview), len(text) > source_end


def sanitize_log_value(value: Any) -> Any:
    """Return a bounded JSON-safe copy, including nested credential fields.

    Shared character/node budgets prevent wide or cyclic payloads from doing
    unbounded work. Unknown objects are described by type, never by repr.
    """
    secrets = _known_secrets()
    secret_lookahead = max((len(secret) for secret in secrets), default=0)
    secret_pattern = (
        re.compile("|".join(re.escape(secret) for secret in secrets)) if secrets else None
    )
    remaining_chars = MAX_LOG_TOTAL_CHARS
    remaining_nodes = MAX_LOG_NODES

    def text_preview(text: str) -> str:
        nonlocal remaining_chars
        limit = min(MAX_LOG_TEXT_CHARS, remaining_chars)
        # Lookahead completes known matches, but never adds raw characters
        # beyond the original preview cutoff to the rendered output.
        redacted, source_truncated = _redact_text(text, limit, secret_pattern, secret_lookahead)
        remaining_chars -= min(len(redacted), limit)
        if source_truncated or len(redacted) > limit:
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
        if isinstance(item, float):
            return item if math.isfinite(item) else "<non-finite float>"
        if item is None or isinstance(item, (bool, int)):
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
