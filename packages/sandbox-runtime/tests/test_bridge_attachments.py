"""Tests for prompt attachment staging in the sandbox bridge."""

from pathlib import Path
from typing import Any

import pytest

from sandbox_runtime.bridge import AgentBridge


class AttachmentStreamResponse:
    def __init__(self, chunks: list[bytes]):
        self.chunks = chunks

    async def __aenter__(self) -> "AttachmentStreamResponse":
        return self

    async def __aexit__(self, *_args: Any) -> None:
        return None

    def raise_for_status(self) -> None:
        return None

    async def aiter_bytes(self):
        for chunk in self.chunks:
            yield chunk


class AttachmentHttpClient:
    def __init__(self, chunks: list[bytes]):
        self.chunks = chunks
        self.requests: list[dict[str, Any]] = []

    def stream(self, method: str, url: str, **kwargs: Any) -> AttachmentStreamResponse:
        self.requests.append({"method": method, "url": url, **kwargs})
        return AttachmentStreamResponse(self.chunks)


@pytest.fixture
def bridge(tmp_path: Path) -> AgentBridge:
    bridge = AgentBridge(
        sandbox_id="test-sandbox",
        session_id="test-session",
        control_plane_url="http://localhost:8787",
        auth_token="test-token",
    )
    bridge.repo_path = tmp_path
    bridge.http_client = AttachmentHttpClient([b"hello", b" world"])
    return bridge


@pytest.mark.asyncio
async def test_stages_relative_prompt_attachment_with_sandbox_auth(bridge: AgentBridge):
    staged = await bridge._stage_prompt_attachments(
        "msg-1",
        [
            {
                "id": "att-1",
                "name": "../notes.txt",
                "url": "/sessions/test-session/attachments/att-1?filename=notes.txt",
                "mimeType": "text/plain",
            }
        ],
    )

    assert staged == [
        {
            "name": "notes.txt",
            "path": str(bridge.repo_path / ".open-inspect/attachments/msg-1/1-notes.txt"),
            "mimeType": "text/plain",
            "sizeBytes": 11,
        }
    ]
    assert Path(staged[0]["path"]).read_text() == "hello world"

    http_client = bridge.http_client
    assert isinstance(http_client, AttachmentHttpClient)
    assert http_client.requests[0]["url"] == (
        "http://localhost:8787/sessions/test-session/attachments/att-1?filename=notes.txt"
    )
    assert http_client.requests[0]["headers"] == {"Authorization": "Bearer test-token"}


def test_appends_attachment_manifest():
    content = AgentBridge._append_attachment_manifest(
        "Review this",
        [
            {
                "name": "notes.txt",
                "path": "/workspace/.open-inspect/attachments/msg-1/1-notes.txt",
                "mimeType": "text/plain",
                "sizeBytes": 11,
            }
        ],
    )

    assert "Review this" in content
    assert "Attached files are available in the workspace:" in content
    assert "/workspace/.open-inspect/attachments/msg-1/1-notes.txt" in content
