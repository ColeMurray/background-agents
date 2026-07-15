"""Bounded prompt image attachment hydration."""

import asyncio
import base64
import mimetypes
import re
from collections.abc import Awaitable, Callable
from typing import Any, ClassVar, Protocol

import httpx


class MediaLogger(Protocol):
    """Structured logger methods used by the attachment processor."""

    def info(self, event: str, **kwargs: Any) -> None: ...

    def warn(self, event: str, **kwargs: Any) -> None: ...


class AttachmentProcessor:
    """Resolve prompt image uploads with bounded network concurrency."""

    IMAGE_MIME_TYPES: ClassVar[set[str]] = {
        "image/png",
        "image/jpeg",
        "image/webp",
        "image/gif",
    }
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
        self, attachments: list[dict[str, Any]] | None
    ) -> list[dict[str, Any]] | None:
        """Hydrate upload-backed images in one bounded processing pass."""
        if not attachments:
            return attachments

        async def bounded(attachment: dict[str, Any]) -> dict[str, Any] | None:
            async with self._semaphore:
                return await self._hydrate_image_upload(attachment)

        results = await asyncio.gather(*(bounded(attachment) for attachment in attachments))
        return [result for result in results if result is not None]

    async def hydrate_uploads(
        self, attachments: list[dict[str, Any]] | None
    ) -> list[dict[str, Any]] | None:
        """Compatibility helper for older bridge callers."""
        return await self.process(attachments)

    async def _hydrate_image_upload(self, attachment: dict[str, Any]) -> dict[str, Any] | None:
        name = attachment.get("name") or "attachment"
        mime = attachment.get("mimeType") or attachment.get("mime")
        if mime and mime not in self.IMAGE_MIME_TYPES:
            self.log.warn("prompt.attachment_unsupported", attachment_name=name, mime_type=mime)
            await self.warn_user(f"Attachment {name} is not a supported image and was skipped.")
            return None

        upload_id = attachment.get("uploadId")
        if not upload_id or attachment.get("content"):
            return attachment

        data = await self._download_upload_bytes(str(upload_id), self.MAX_IMAGE_BYTES)
        if data is None:
            self.log.warn("prompt.upload_fetch_failed", attachment_name=name, upload_id=upload_id)
            await self.warn_user(f"Attachment {name} could not be fetched and was skipped.")
            return None
        hydrated = {key: value for key, value in attachment.items() if key != "uploadId"}
        hydrated["content"] = base64.b64encode(data).decode("ascii")
        self.log.info(
            "prompt.upload_fetched",
            attachment_name=name,
            upload_id=upload_id,
            size_bytes=len(data),
        )
        return hydrated

    async def _download_upload_bytes(self, upload_id: str, max_bytes: int) -> bytes | None:
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
                    if total > max_bytes:
                        self.log.warn("prompt.media_too_large", bytes=total)
                        return None
                    chunks.append(chunk)
        except httpx.HTTPError as exc:
            self.log.warn("prompt.media_download_error", exc=exc)
            return None
        return b"".join(chunks) if chunks else None

    def _upload_url(self, upload_id: str) -> str:
        return f"{self.control_plane_url}/sessions/{self.session_id}/uploads/{upload_id}"

    def build_file_parts(self, attachments: list[dict[str, Any]] | None) -> list[dict[str, Any]]:
        """Convert resolved image attachments into OpenCode file parts."""
        parts: list[dict[str, Any]] = []
        for attachment in attachments or []:
            if not isinstance(attachment, dict):
                continue
            name = attachment.get("name") or "attachment"
            mime = attachment.get("mimeType") or attachment.get("mime")
            content = attachment.get("content")
            url = attachment.get("url")
            resolved_mime = mime or (mimetypes.guess_type(url)[0] if url else None)
            if resolved_mime not in self.IMAGE_MIME_TYPES:
                self.log.warn("prompt.attachment_unsupported", attachment_name=name)
                continue
            if content:
                file_url = f"data:{resolved_mime};base64,{content}"
            elif url:
                file_url = url
            else:
                self.log.warn("prompt.attachment_skipped", attachment_name=name)
                continue
            parts.append({"type": "file", "mime": resolved_mime, "filename": name, "url": file_url})
        return parts
