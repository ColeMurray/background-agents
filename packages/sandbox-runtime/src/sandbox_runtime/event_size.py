"""Size tool-call events before they enter the WebSocket delivery queue."""

import copy
import json
from typing import Any, Final

# Keep event values below the Durable Object SQLite 2 MB string/BLOB/row limit:
# https://developers.cloudflare.com/durable-objects/platform/limits/#sql-storage-limits
# This also fits the Node host's 1 MiB WebSocket message limit:
# packages/control-plane/src/node/websocket-upgrade.ts:34
MAX_EVENT_BYTES: Final = 1_000_000

_PATH_KEYS: Final = frozenset(
    {"path", "filePath", "filepath", "file_path", "fileName", "filename", "file"}
)


def event_size_bytes(event: dict[str, Any]) -> int:
    return len(json.dumps(event).encode("utf-8"))


def _arg_strings(value: Any, location: str = "args"):
    if isinstance(value, dict):
        for key, child in value.items():
            if key in _PATH_KEYS:
                continue
            path = f"{location}.{key}"
            if isinstance(child, str) and child:
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

    def shrink(container: dict | list, key: str | int, path: str, text: str) -> None:
        fields.append(path)
        low, high = 0, len(text)
        while low < high:
            mid = (low + high + 1) // 2
            container[key] = text[:mid]
            if event_size_bytes(result) <= MAX_EVENT_BYTES:
                low = mid
            else:
                high = mid - 1
        container[key] = text[:low]

    output = result.get("output")
    if isinstance(output, str) and output:
        shrink(result, "output", "output", output)

    if event_size_bytes(result) > MAX_EVENT_BYTES:
        candidates = sorted(
            _arg_strings(result["args"]), key=lambda item: len(json.dumps(item[3])), reverse=True
        )
        for container, key, path, text in candidates:
            shrink(container, key, path, text)
            if event_size_bytes(result) <= MAX_EVENT_BYTES:
                break

    if event_size_bytes(result) > MAX_EVENT_BYTES:
        raise ValueError("tool_call protected fields exceed the event frame budget")
    return result
