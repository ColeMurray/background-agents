"""Tests for bounded prompt attachment processing."""

import asyncio
from typing import Any

import pytest

from sandbox_runtime.attachment_processor import AttachmentProcessor


class TestLogger:
    def info(self, event: str, **kwargs: Any) -> None:
        pass

    def warn(self, event: str, **kwargs: Any) -> None:
        pass


@pytest.fixture
def processor() -> AttachmentProcessor:
    async def warn_user(message: str) -> None:
        pass

    return AttachmentProcessor(
        control_plane_url="https://control.example",
        session_id="session-1",
        auth_token="token",
        log=TestLogger(),
        warn_user=warn_user,
    )


async def test_video_attachment_is_rejected_without_downloading(
    processor: AttachmentProcessor, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def fail_download(upload_id: str, max_bytes: int) -> bytes:
        raise AssertionError("unsupported attachments must not be downloaded")

    monkeypatch.setattr(processor, "_download_upload_bytes", fail_download)

    result = await processor.process(
        [{"type": "file", "name": "clip.mp4", "mimeType": "video/mp4", "uploadId": "up-1"}]
    )

    assert result == []


async def test_invalid_upload_id_is_rejected(processor: AttachmentProcessor) -> None:
    assert await processor._download_upload_bytes("../admin", processor.MAX_IMAGE_BYTES) is None


async def test_processing_concurrency_is_bounded(
    processor: AttachmentProcessor, monkeypatch: pytest.MonkeyPatch
) -> None:
    active = 0
    peak = 0

    async def hydrate(attachment: dict[str, Any]) -> dict[str, Any]:
        nonlocal active, peak
        active += 1
        peak = max(peak, active)
        await asyncio.sleep(0.01)
        active -= 1
        return attachment

    monkeypatch.setattr(processor, "_hydrate_image_upload", hydrate)
    attachments = [
        {"type": "image", "name": f"{index}.png", "content": "QQ=="} for index in range(6)
    ]

    assert await processor.process(attachments) == attachments
    assert peak == processor.MAX_CONCURRENCY
