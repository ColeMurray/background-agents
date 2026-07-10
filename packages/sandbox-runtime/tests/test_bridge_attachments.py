"""Unit tests for attachment -> OpenCode file part conversion in the bridge."""

import pytest

from sandbox_runtime.bridge import AgentBridge


@pytest.fixture
def bridge() -> AgentBridge:
    return AgentBridge(
        sandbox_id="test-sandbox",
        session_id="test-session",
        control_plane_url="http://localhost:8787",
        auth_token="test-token",
    )


def test_no_attachments_returns_empty(bridge: AgentBridge) -> None:
    assert bridge._build_attachment_parts(None) == []
    assert bridge._build_attachment_parts([]) == []


def test_image_content_becomes_data_url_file_part(bridge: AgentBridge) -> None:
    parts = bridge._build_attachment_parts(
        [{"type": "image", "name": "shot.png", "mimeType": "image/png", "content": "QUJD"}]
    )
    assert parts == [
        {
            "type": "file",
            "mime": "image/png",
            "filename": "shot.png",
            "url": "data:image/png;base64,QUJD",
        }
    ]


def test_url_attachment_passed_through_with_guessed_mime(bridge: AgentBridge) -> None:
    parts = bridge._build_attachment_parts(
        [{"type": "image", "name": "shot.png", "url": "https://uploads.linear.app/x/shot.png"}]
    )
    assert len(parts) == 1
    assert parts[0]["type"] == "file"
    assert parts[0]["url"] == "https://uploads.linear.app/x/shot.png"
    assert parts[0]["mime"] == "image/png"


def test_attachment_without_content_or_url_is_skipped(bridge: AgentBridge) -> None:
    assert bridge._build_attachment_parts([{"type": "image", "name": "broken"}]) == []


def test_non_dict_attachment_is_skipped(bridge: AgentBridge) -> None:
    assert bridge._build_attachment_parts(["not-a-dict"]) == []  # type: ignore[list-item]


def test_prompt_request_body_appends_image_parts_after_text(bridge: AgentBridge) -> None:
    body = bridge._build_prompt_request_body(
        "hello",
        model=None,
        attachments=[
            {"type": "image", "name": "a.png", "mimeType": "image/png", "content": "QQ=="}
        ],
    )
    assert body["parts"][0] == {"type": "text", "text": "hello"}
    assert body["parts"][1]["type"] == "file"
    assert body["parts"][1]["mime"] == "image/png"
    assert body["parts"][1]["url"] == "data:image/png;base64,QQ=="


def test_prompt_request_body_text_only_when_no_attachments(bridge: AgentBridge) -> None:
    body = bridge._build_prompt_request_body("hi", model=None)
    assert body["parts"] == [{"type": "text", "text": "hi"}]


@pytest.mark.parametrize(
    ("attachment", "expected"),
    [
        ({"mimeType": "video/mp4"}, True),
        ({"name": "rec.mp4"}, True),
        ({"url": "https://uploads.linear.app/a/b/c.mov?signature=x"}, True),
        ({"mimeType": "image/png"}, False),
        ({"name": "shot.png"}, False),
        ({"name": "notes.txt"}, False),
    ],
)
def test_is_video_attachment(
    bridge: AgentBridge, attachment: dict[str, object], expected: bool
) -> None:
    assert bridge._is_video_attachment(attachment) is expected


def test_build_attachment_parts_skips_video(bridge: AgentBridge) -> None:
    parts = bridge._build_attachment_parts(
        [{"type": "url", "name": "rec.mp4", "mimeType": "video/mp4", "url": "https://x/rec.mp4"}]
    )
    assert parts == []


async def test_expand_video_attachments_passes_through_non_video(bridge: AgentBridge) -> None:
    images = [{"type": "image", "name": "a.png", "mimeType": "image/png", "content": "QQ=="}]
    assert await bridge._expand_video_attachments(images) == images


async def test_expand_video_attachments_drops_video_without_source(bridge: AgentBridge) -> None:
    # A video attachment with neither url nor content cannot be framed, so it is dropped.
    result = await bridge._expand_video_attachments(
        [{"type": "url", "name": "rec.mp4", "mimeType": "video/mp4"}]
    )
    assert result == []
    assert bridge._event_buffer[-1]["type"] == "warning"
    assert bridge._event_buffer[-1]["scope"] == "media"
    assert "rec.mp4" in bridge._event_buffer[-1]["message"]


async def test_expand_video_attachments_handles_none(bridge: AgentBridge) -> None:
    assert await bridge._expand_video_attachments(None) is None
    assert await bridge._expand_video_attachments([]) == []


async def test_hydrate_upload_attachments_handles_none(bridge: AgentBridge) -> None:
    assert await bridge._hydrate_upload_attachments(None) is None
    assert await bridge._hydrate_upload_attachments([]) == []


async def test_hydrate_upload_attachments_passes_through_non_upload(bridge: AgentBridge) -> None:
    attachments = [
        {"type": "image", "name": "a.png", "mimeType": "image/png", "content": "QQ=="},
        {"type": "url", "name": "rec.mp4", "mimeType": "video/mp4", "url": "https://x/rec.mp4"},
    ]
    assert await bridge._hydrate_upload_attachments(attachments) == attachments


async def test_hydrate_upload_attachments_inlines_downloaded_content(
    bridge: AgentBridge, monkeypatch: pytest.MonkeyPatch
) -> None:
    calls: list[tuple[str, int]] = []

    async def fake_download(upload_id: str, max_bytes: int) -> bytes:
        calls.append((upload_id, max_bytes))
        return b"ABC"

    monkeypatch.setattr(bridge.attachment_processor, "_download_upload_bytes", fake_download)
    result = await bridge._hydrate_upload_attachments(
        [{"type": "image", "name": "shot.png", "mimeType": "image/png", "uploadId": "up-1"}]
    )
    assert result == [
        {"type": "image", "name": "shot.png", "mimeType": "image/png", "content": "QUJD"}
    ]
    assert calls == [("up-1", bridge.attachment_processor.MAX_IMAGE_BYTES)]


async def test_hydrate_upload_attachments_uses_video_cap_for_videos(
    bridge: AgentBridge, monkeypatch: pytest.MonkeyPatch
) -> None:
    calls: list[tuple[str, int]] = []

    async def fake_download(upload_id: str, max_bytes: int) -> bytes:
        calls.append((upload_id, max_bytes))
        return b"vid"

    monkeypatch.setattr(bridge.attachment_processor, "_download_upload_bytes", fake_download)
    result = await bridge._hydrate_upload_attachments(
        [{"type": "file", "name": "rec.mp4", "mimeType": "video/mp4", "uploadId": "up-2"}]
    )
    assert result is not None
    assert result[0]["content"] == "dmlk"
    assert "uploadId" not in result[0]
    assert calls == [("up-2", bridge.attachment_processor.MAX_VIDEO_BYTES)]


async def test_hydrate_upload_attachments_drops_failed_download(
    bridge: AgentBridge, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def fake_download(upload_id: str, max_bytes: int) -> None:
        return None

    monkeypatch.setattr(bridge.attachment_processor, "_download_upload_bytes", fake_download)
    result = await bridge._hydrate_upload_attachments(
        [
            {"type": "image", "name": "gone.png", "mimeType": "image/png", "uploadId": "up-3"},
            {"type": "image", "name": "ok.png", "mimeType": "image/png", "content": "QQ=="},
        ]
    )
    assert result == [
        {"type": "image", "name": "ok.png", "mimeType": "image/png", "content": "QQ=="}
    ]
    assert bridge._event_buffer[-1]["type"] == "warning"
    assert bridge._event_buffer[-1]["scope"] == "media"
    assert "gone.png" in bridge._event_buffer[-1]["message"]


async def test_hydrate_upload_attachments_keeps_existing_content(
    bridge: AgentBridge, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def fail_download(upload_id: str, max_bytes: int) -> bytes:
        raise AssertionError("should not download when content is already inline")

    monkeypatch.setattr(bridge.attachment_processor, "_download_upload_bytes", fail_download)
    attachments = [
        {
            "type": "image",
            "name": "a.png",
            "mimeType": "image/png",
            "content": "QQ==",
            "uploadId": "up-4",
        }
    ]
    assert await bridge._hydrate_upload_attachments(attachments) == attachments
