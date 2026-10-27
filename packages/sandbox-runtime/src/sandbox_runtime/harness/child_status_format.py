"""Render protected child output references without exposing retrieval metadata."""

import json
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


# Keep symmetric with @open-inspect/shared/child-status-tool and the JS formatter.
_SESSION_DISPLAY_FIELDS = (
    "id",
    "title",
    "status",
    "repoOwner",
    "repoName",
    "branchName",
    "model",
    "createdAt",
    "updatedAt",
)
_RESPONSE_DISPLAY_FIELDS = ("success", "textContent", "error", "eventCount", "eventLimitReached")


def child_status_list_output(children: Sequence[Mapping[str, Any]], agent_message: str) -> str:
    return json.dumps(
        {
            "version": 1,
            "kind": "list",
            "children": [
                {key: child[key] for key in _SESSION_DISPLAY_FIELDS if key in child}
                for child in children
            ],
            "agentMessage": agent_message,
        },
        ensure_ascii=False,
    )


def child_status_detail_output(detail: Mapping[str, Any], child_id: str, agent_message: str) -> str:
    session = detail.get("session") or {}
    final = detail.get("finalResponse")
    response = None
    if final:
        response = {
            key: final[key]
            for key in _RESPONSE_DISPLAY_FIELDS
            if key in final and final[key] is not None
        }
        response["success"] = bool(final.get("success"))
        response["textContent"] = final.get("textContent") or ""
    return json.dumps(
        {
            "version": 1,
            "kind": "detail",
            "session": {
                **{key: session[key] for key in _SESSION_DISPLAY_FIELDS if key in session},
                "id": session.get("id") or child_id,
            },
            "hasUnfinishedPrompt": detail.get("hasUnfinishedPrompt") is True,
            "finalResponse": response,
            "agentMessage": agent_message,
        },
        ensure_ascii=False,
    )
