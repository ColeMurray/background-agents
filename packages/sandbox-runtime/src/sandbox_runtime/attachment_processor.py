"""Bounded prompt image attachment hydration."""

import asyncio
import base64
import re
from collections.abc import Awaitable, Callable
from typing import Any, Literal, Protocol, TypedDict, cast

import httpx


class MediaLogger(Protocol):
    """Structured logger methods used by the attachment processor."""

    def info(self, event: str, **kwargs: Any) -> None: ...

    def warn(self, event: str, **kwargs: Any) -> None: ...


PromptImageMimeType = Literal["image/png", "image/jpeg", "image/gif", "image/webp"]
PROMPT_IMAGE_MIME_TYPES = {"image/png", "image/jpeg", "image/gif", "image/webp"}
MAX_PROMPT_ATTACHMENTS = 6


class PromptImageAttachment(TypedDict):
    """Trusted image metadata resolved by the control plane."""

    uploadId: str
    name: str
    mimeType: PromptImageMimeType


class HydratedPromptImage(TypedDict):
    name: str
    mimeType: PromptImageMimeType
    content: str


class OpenCodeFilePart(TypedDict):
    type: str
    mime: str
    filename: str
    url: str


def parse_prompt_image_attachments(
    value: object,
) -> tuple[list[PromptImageAttachment] | None, int]:
    """Validate the untyped WebSocket attachment boundary and count rejected entries."""
    if value is None:
        return None, 0
    if not isinstance(value, list):
        return [], 1

    parsed: list[PromptImageAttachment] = []
    rejected = max(len(value) - MAX_PROMPT_ATTACHMENTS, 0)
    for item in value[:MAX_PROMPT_ATTACHMENTS]:
        if not isinstance(item, dict):
            rejected += 1
            continue
        upload_id = item.get("uploadId")
        name = item.get("name")
        mime_type = item.get("mimeType")
        if (
            not isinstance(upload_id, str)
            or re.fullmatch(r"[A-Za-z0-9-]{1,128}", upload_id) is None
            or not isinstance(name, str)
            or not 1 <= len(name) <= 255
            or not isinstance(mime_type, str)
            or mime_type not in PROMPT_IMAGE_MIME_TYPES
        ):
            rejected += 1
            continue
        parsed.append(
            {
                "uploadId": upload_id,
                "name": name,
                "mimeType": cast(PromptImageMimeType, mime_type),
            }
        )
    return parsed, rejected


class AttachmentProcessor:
    """Resolve prompt image uploads with bounded network concurrency."""

    MAX_IMAGE_BYTES = 10 * 1024 * 1024
    DOWNLOAD_TIMEOUT_SECONDS = 120.0
    MAX_CONCURRENCY = 2

    def __init__(
        self,
        *,
        control_plane_url: str,
        session_id: str,
        auth_token: str,
        log: MediaLogger,
        warn_user: Callable[[str], Awaitable[None]],
    ) -> None:
        self.control_plane_url = control_plane_url.rstrip("/")
        self.session_id = session_id
        self.auth_token = auth_token
        self.log = log
        self.warn_user = warn_user
        self._semaphore = asyncio.Semaphore(self.MAX_CONCURRENCY)

    async def process(
        self, attachments: list[PromptImageAttachment] | None
    ) -> list[HydratedPromptImage] | None:
        """Hydrate upload-backed images in one bounded processing pass."""
        if attachments is None:
            return None
        if not attachments:
            return []

        async def bounded(attachment: PromptImageAttachment) -> HydratedPromptImage | None:
            async with self._semaphore:
                return await self._hydrate_image_upload(attachment)

        results = await asyncio.gather(*(bounded(attachment) for attachment in attachments))
        return [result for result in results if result is not None]

    async def _hydrate_image_upload(
        self, attachment: PromptImageAttachment
    ) -> HydratedPromptImage | None:
        name = attachment["name"]
        upload_id = attachment["uploadId"]
        data = await self._download_upload_bytes(upload_id)
        if data is None:
            self.log.warn("prompt.upload_fetch_failed", attachment_name=name, upload_id=upload_id)
            await self.warn_user(f"Attachment {name} could not be fetched and was skipped.")
            return None
        self.log.info(
            "prompt.upload_fetched",
            attachment_name=name,
            upload_id=upload_id,
            size_bytes=len(data),
        )
        return {
            "name": name,
            "mimeType": attachment["mimeType"],
            "content": base64.b64encode(data).decode("ascii"),
        }

    async def _download_upload_bytes(self, upload_id: str) -> bytes | None:
        if re.fullmatch(r"[A-Za-z0-9-]+", upload_id) is None:
            self.log.warn("prompt.upload_id_invalid", upload_id=upload_id)
            return None

        headers = {"Authorization": f"Bearer {self.auth_token}"}
        chunks: list[bytes] = []
        try:
            async with (
                httpx.AsyncClient(follow_redirects=False) as client,
                client.stream(
                    "GET",
                    self._upload_url(upload_id),
                    timeout=self.DOWNLOAD_TIMEOUT_SECONDS,
                    headers=headers,
                ) as response,
            ):
                if response.status_code != 200:
                    self.log.warn("prompt.media_http_status", status=response.status_code)
                    return None
                total = 0
                async for chunk in response.aiter_bytes():
                    total += len(chunk)
                    if total > self.MAX_IMAGE_BYTES:
                        self.log.warn("prompt.media_too_large", bytes=total)
                        return None
                    chunks.append(chunk)
        except httpx.HTTPError as exc:
            self.log.warn("prompt.media_download_error", exc=exc)
            return None
        return b"".join(chunks) if chunks else None

    def _upload_url(self, upload_id: str) -> str:
        return f"{self.control_plane_url}/sessions/{self.session_id}/uploads/{upload_id}"

    def build_file_parts(
        self, attachments: list[HydratedPromptImage] | None
    ) -> list[OpenCodeFilePart]:
        """Convert resolved image attachments into OpenCode file parts."""
        parts: list[OpenCodeFilePart] = []
        for attachment in attachments or []:
            parts.append(
                {
                    "type": "file",
                    "mime": attachment["mimeType"],
                    "filename": attachment["name"],
                    "url": f"data:{attachment['mimeType']};base64,{attachment['content']}",
                }
            )
        return parts
