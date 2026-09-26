"""Size tool-call events before they enter the WebSocket delivery queue."""

import copy
import json
from collections.abc import Iterator
from typing import Any, Final

# Keep event values below the Durable Object SQLite 2 MB string/BLOB/row limit:
# https://developers.cloudflare.com/durable-objects/platform/limits/#sql-storage-limits
# This also fits the Node host's 1 MiB WebSocket message limit:
# packages/control-plane/src/node/websocket-upgrade.ts:34
MAX_EVENT_BYTES: Final = 1_000_000

_PATH_KEYS: Final = frozenset({"path", "filepath", "filename", "file", "notebookpath"})


def event_size_bytes(event: dict[str, Any]) -> int:
    return len(json.dumps(event).encode("utf-8"))


def _arg_strings(
    value: Any, location: str = "args"
) -> Iterator[tuple[dict[str, Any] | list[Any], str | int, str, str]]:
    if isinstance(value, dict):
        for key, child in value.items():
            path = f"{location}.{key}"
            if isinstance(child, str) and child:
                if not isinstance(key, str) or key.replace("_", "").lower() not in _PATH_KEYS:
                    yield value, key, path, child
            else:
                yield from _arg_strings(child, path)
    elif isinstance(value, list):
        for index, child in enumerate(value):
            path = f"{location}[{index}]"
            if isinstance(child, str) and child:
                yield value, index, path, child
            else:
                yield from _arg_strings(child, path)


def _fit_json_string(text: str, max_bytes: int) -> str:
    low, high = 0, len(text)
    while low < high:
        mid = (low + high + 1) // 2
        if len(json.dumps(text[:mid])) <= max_bytes:
            low = mid
        else:
            high = mid - 1
    return text[:low]


def truncate_critical_error(event: dict[str, Any], original_bytes: int) -> dict[str, Any] | None:
    """Keep a critical event's identity and outcome when its diagnostic is too large."""
    error = event.get("error")
    if not isinstance(error, str):
        return None
    remaining = MAX_EVENT_BYTES - original_bytes + len(json.dumps(error))
    if remaining < 2:
        return None
    result = {**event, "error": _fit_json_string(error, remaining)}
    return result if event_size_bytes(result) <= MAX_EVENT_BYTES else None


def _set_arg(container: dict[str, Any] | list[Any], key: str | int, text: str) -> None:
    if isinstance(key, str):
        assert isinstance(container, dict)
        container[key] = text
    else:
        assert isinstance(container, list)
        container[key] = text


def truncate_tool_call(event: dict[str, Any]) -> dict[str, Any]:
    """Return the original event if it fits, otherwise a bounded, marked copy.

    Never alter identity or file paths. If those alone cannot fit, let the
    caller warn and decline to send the untransmittable event.
    """
    original_bytes = event_size_bytes(event)
    if original_bytes <= MAX_EVENT_BYTES:
        return event

    result = {**event, "args": copy.deepcopy(event["args"])}
    fields: list[str] = []
    result["truncated"] = {"fields": fields, "originalBytes": original_bytes}
    size_bytes = event_size_bytes(result)

    def shrink(container: dict[str, Any] | list[Any], key: str | int, path: str, text: str) -> None:
        nonlocal size_bytes
        size_bytes += len(json.dumps(path)) + (2 if fields else 0)
        fields.append(path)
        without_text_bytes = size_bytes - len(json.dumps(text))
        replacement = (
            _fit_json_string(text, MAX_EVENT_BYTES - without_text_bytes)
            if without_text_bytes + 2 <= MAX_EVENT_BYTES
            else ""
        )
        _set_arg(container, key, replacement)
        size_bytes = without_text_bytes + len(json.dumps(replacement))

    output = result.get("output")
    if isinstance(output, str) and output:
        shrink(result, "output", "output", output)

    if size_bytes > MAX_EVENT_BYTES:
        candidates = sorted(
            _arg_strings(result["args"]), key=lambda item: len(json.dumps(item[3])), reverse=True
        )
        for container, key, path, text in candidates:
            shrink(container, key, path, text)
            if size_bytes <= MAX_EVENT_BYTES:
                break

    if event_size_bytes(result) > MAX_EVENT_BYTES:
        raise ValueError("tool_call protected fields exceed the event frame budget")
    return result
