"""Render protected child output references without exposing retrieval metadata."""

from collections.abc import Mapping, Sequence
from typing import Any


def format_stored_files(files: Sequence[Mapping[str, Any]], indent: str = "  ") -> list[str]:
    if not files:
        return []
    lines = ["", f"{indent}Stored outputs:"]
    for file in files:
        metadata = (
            file.get("metadata") if file.get("type") == "file" and file.get("available") else None
        )
        details = metadata or file
        filename = details.get("filename")
        caption = details.get("caption")
        unavailable = " (unavailable)" if file.get("available") is False else ""
        name = f": {filename}" if filename else ""
        lines.append(f"{indent}  - {file.get('type')} id={file.get('id')}{name}{unavailable}")
        if caption:
            lines.extend(f"{indent}    {line}" for line in str(caption).split("\n"))
    return lines
