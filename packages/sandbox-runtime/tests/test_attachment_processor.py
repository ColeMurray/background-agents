"""Tests for bounded prompt attachment processing."""

import asyncio
from typing import Any

import pytest

from sandbox_runtime.attachment_processor import (
    AttachmentProcessor,
    HydratedPromptImage,
    PromptImageAttachment,
    parse_prompt_image_attachments,
)


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


async def test_upload_is_hydrated_to_base64(
    processor: AttachmentProcessor, monkeypatch: pytest.MonkeyPatch
) -> None:
    calls: list[str] = []

    async def download(upload_id: str) -> bytes:
        calls.append(upload_id)
        return b"ABC"

    monkeypatch.setattr(processor, "_download_upload_bytes", download)

    result = await processor.process(
        [{"name": "shot.png", "mimeType": "image/png", "uploadId": "up-1"}]
    )

    assert result == [{"name": "shot.png", "mimeType": "image/png", "content": "QUJD"}]
    assert calls == ["up-1"]


async def test_invalid_upload_id_is_rejected(processor: AttachmentProcessor) -> None:
    assert await processor._download_upload_bytes("../admin") is None


def test_untyped_prompt_attachments_are_validated() -> None:
    parsed, rejected = parse_prompt_image_attachments(
        [
            {"name": "shot.png", "mimeType": "image/png", "uploadId": "up-1"},
            {"name": "remote.png", "mimeType": "image/png", "url": "https://example.com"},
            {"name": "video.mp4", "mimeType": "video/mp4", "uploadId": "up-2"},
            "invalid",
        ]
    )

    assert parsed == [{"name": "shot.png", "mimeType": "image/png", "uploadId": "up-1"}]
    assert rejected == 3


async def test_processing_concurrency_is_bounded(
    processor: AttachmentProcessor, monkeypatch: pytest.MonkeyPatch
) -> None:
    active = 0
    peak = 0

    async def hydrate(attachment: PromptImageAttachment) -> HydratedPromptImage:
        nonlocal active, peak
        active += 1
        peak = max(peak, active)
        await asyncio.sleep(0.01)
        active -= 1
        return {
            "name": attachment["name"],
            "mimeType": attachment["mimeType"],
            "content": "QQ==",
        }

    monkeypatch.setattr(processor, "_hydrate_image_upload", hydrate)
    attachments: list[PromptImageAttachment] = [
        {"name": f"{index}.png", "mimeType": "image/png", "uploadId": f"up-{index}"}
        for index in range(6)
    ]

    result = await processor.process(attachments)
    assert result is not None
    assert len(result) == len(attachments)
    assert peak == processor.MAX_CONCURRENCY
