"""Tests for bounded prompt attachment processing."""

import asyncio
from pathlib import Path
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


async def test_upload_backed_video_streams_to_disk_without_byte_hydration(
    processor: AttachmentProcessor, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def fail_byte_download(upload_id: str, max_bytes: int) -> bytes:
        raise AssertionError("videos must not be buffered into bytes")

    async def download_to_file(upload_id: str, destination: Path) -> bool:
        destination.write_bytes(b"video")
        return True

    async def extract(video_path: Path, out_dir: Path) -> list[Path]:
        assert video_path.read_bytes() == b"video"
        frame = out_dir / "frame.jpg"
        frame.write_bytes(b"jpeg")
        return [frame]

    monkeypatch.setattr(processor, "_download_upload_bytes", fail_byte_download)
    monkeypatch.setattr(processor, "_download_upload_to_file", download_to_file)
    monkeypatch.setattr(processor, "_extract_video_frames", extract)

    result = await processor.process(
        [{"type": "file", "name": "clip.mp4", "mimeType": "video/mp4", "uploadId": "up-1"}]
    )

    assert result is not None
    assert result[0]["type"] == "image"
    assert result[0]["content"] == "anBlZw=="


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
