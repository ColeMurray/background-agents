"""Unit tests for attachment -> OpenCode file part conversion in the bridge."""

from unittest.mock import MagicMock

import pytest

from sandbox_runtime.bridge import AgentBridge
from tests.conftest import wire_opencode_transport


@pytest.fixture
def bridge() -> AgentBridge:
    bridge = AgentBridge(
        sandbox_id="test-sandbox",
        session_id="test-session",
        control_plane_url="http://localhost:8787",
        auth_token="test-token",
    )
    wire_opencode_transport(bridge, MagicMock())
    return bridge


def test_prompt_request_body_appends_image_parts_after_text(bridge: AgentBridge) -> None:
    body = bridge._ensure_prompt_stream()._build_prompt_request_body(
        "hello",
        model=None,
        attachments=[{"name": "a.png", "mimeType": "image/png", "content": "QQ=="}],
    )
    assert body["parts"] == [
        {"type": "text", "text": "hello"},
        {
            "type": "file",
            "mime": "image/png",
            "filename": "a.png",
            "url": "data:image/png;base64,QQ==",
        },
    ]


def test_prompt_request_body_text_only_when_no_attachments(bridge: AgentBridge) -> None:
    body = bridge._ensure_prompt_stream()._build_prompt_request_body("hi", model=None)
    assert body["parts"] == [{"type": "text", "text": "hi"}]
