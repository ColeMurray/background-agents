"""Bounded prompt attachment download and video processing."""

import asyncio
import base64
import mimetypes
import shutil
import tempfile
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Any, ClassVar, Protocol, cast

import httpx


class MediaLogger(Protocol):
    """Structured logger methods used by the attachment processor."""

    def info(self, event: str, **kwargs: Any) -> None: ...

    def warn(self, event: str, **kwargs: Any) -> None: ...


class AttachmentProcessor:
    """Resolve prompt attachments with bounded I/O and subprocess concurrency."""

    VIDEO_EXTENSIONS: ClassVar[set[str]] = {"mp4", "mov", "webm", "m4v", "avi", "mkv"}
    MAX_VIDEO_FRAMES = 8
    MAX_VIDEO_BYTES = 100 * 1024 * 1024
    MAX_IMAGE_BYTES = 10 * 1024 * 1024
    DOWNLOAD_TIMEOUT_SECONDS = 120.0
    SUBPROCESS_TIMEOUT_SECONDS = 30.0
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
        """Resolve uploads and expand videos in one bounded processing pass."""
        if not attachments:
            return attachments

        async def bounded(attachment: dict[str, Any]) -> list[dict[str, Any]]:
            async with self._semaphore:
                if self.is_video(attachment):
                    return await self._video_to_frames(attachment)
                hydrated = await self._hydrate_image_upload(attachment)
                return [hydrated] if hydrated is not None else []

        groups = await asyncio.gather(*(bounded(attachment) for attachment in attachments))
        return [attachment for group in groups for attachment in group]

    async def hydrate_uploads(
        self, attachments: list[dict[str, Any]] | None
    ) -> list[dict[str, Any]] | None:
        """Compatibility helper that hydrates uploads without expanding videos."""
        if not attachments:
            return attachments

        async def bounded(attachment: dict[str, Any]) -> dict[str, Any] | None:
            async with self._semaphore:
                return await self._hydrate_image_upload(attachment, include_videos=True)

        results = await asyncio.gather(*(bounded(attachment) for attachment in attachments))
        return [result for result in results if result is not None]

    async def expand_videos(
        self, attachments: list[dict[str, Any]] | None
    ) -> list[dict[str, Any]] | None:
        """Compatibility helper that expands videos with bounded concurrency."""
        if not attachments:
            return attachments

        async def bounded(attachment: dict[str, Any]) -> list[dict[str, Any]]:
            async with self._semaphore:
                return (
                    await self._video_to_frames(attachment)
                    if self.is_video(attachment)
                    else [attachment]
                )

        groups = await asyncio.gather(*(bounded(attachment) for attachment in attachments))
        return [attachment for group in groups for attachment in group]

    async def _hydrate_image_upload(
        self, attachment: dict[str, Any], *, include_videos: bool = False
    ) -> dict[str, Any] | None:
        upload_id = attachment.get("uploadId")
        if not upload_id or attachment.get("content"):
            return attachment
        if self.is_video(attachment) and not include_videos:
            return attachment

        name = attachment.get("name") or "attachment"
        max_bytes = self.MAX_VIDEO_BYTES if self.is_video(attachment) else self.MAX_IMAGE_BYTES
        data = await self._download_upload_bytes(str(upload_id), max_bytes)
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

    async def _video_to_frames(self, attachment: dict[str, Any]) -> list[dict[str, Any]]:
        name = attachment.get("name") or "video"
        tmpdir = Path(tempfile.mkdtemp(prefix="prompt_video_"))
        video_path = tmpdir / "input"
        try:
            upload_id = attachment.get("uploadId")
            content = attachment.get("content")
            url = attachment.get("url")
            if upload_id:
                ok = await self._download_upload_to_file(str(upload_id), video_path)
            elif content:
                try:
                    video_path.write_bytes(base64.b64decode(content, validate=True))
                    ok = video_path.stat().st_size <= self.MAX_VIDEO_BYTES
                except (ValueError, OSError):
                    ok = False
            elif url:
                ok = await self._download_url_to_file(str(url), self.MAX_VIDEO_BYTES, video_path)
            else:
                ok = False

            if not ok:
                self.log.warn(
                    "prompt.video_source_failed", attachment_name=name, upload_id=upload_id
                )
                await self.warn_user(
                    f"Video attachment {name} could not be loaded and was skipped."
                )
                return []

            frames = await self._extract_video_frames(video_path, tmpdir)
            if not frames:
                self.log.warn("prompt.video_no_frames", attachment_name=name)
                await self.warn_user(
                    f"Video attachment {name} could not be sampled and was skipped."
                )
                return []

            result = [
                {
                    "type": "image",
                    "name": f"{name} — frame {index}/{len(frames)}",
                    "mimeType": "image/jpeg",
                    "content": base64.b64encode(frame.read_bytes()).decode("ascii"),
                }
                for index, frame in enumerate(frames, start=1)
            ]
            self.log.info("prompt.video_frames", attachment_name=name, frame_count=len(result))
            return result
        except Exception as exc:  # media failure must not fail the prompt
            self.log.warn("prompt.video_expand_failed", attachment_name=name, exc=exc)
            await self.warn_user(f"Video attachment {name} could not be processed and was skipped.")
            return []
        finally:
            shutil.rmtree(tmpdir, ignore_errors=True)

    async def _download_upload_bytes(self, upload_id: str, max_bytes: int) -> bytes | None:
        chunks: list[bytes] = []

        async def consume(chunk: bytes) -> None:
            chunks.append(chunk)

        ok = await self._stream_download(self._upload_url(upload_id), max_bytes, consume, True)
        return b"".join(chunks) if ok and chunks else None

    async def _download_upload_to_file(self, upload_id: str, dest: Path) -> bool:
        return await self._download_url_to_file(
            self._upload_url(upload_id), self.MAX_VIDEO_BYTES, dest, authenticated=True
        )

    async def _download_url_to_file(
        self, url: str, max_bytes: int, dest: Path, *, authenticated: bool = False
    ) -> bool:
        try:
            with dest.open("wb") as handle:

                async def consume(chunk: bytes) -> None:
                    handle.write(chunk)

                ok = await self._stream_download(url, max_bytes, consume, authenticated)
            return ok and dest.exists() and dest.stat().st_size > 0
        except OSError as exc:
            self.log.warn("prompt.media_file_error", exc=exc)
            return False

    async def _stream_download(
        self,
        url: str,
        max_bytes: int,
        consume: Callable[[bytes], Awaitable[None]],
        authenticated: bool,
    ) -> bool:
        headers = {"Authorization": f"Bearer {self.auth_token}"} if authenticated else None
        try:
            async with (
                httpx.AsyncClient(follow_redirects=True) as client,
                client.stream(
                    "GET", url, timeout=self.DOWNLOAD_TIMEOUT_SECONDS, headers=headers
                ) as response,
            ):
                if response.status_code != 200:
                    self.log.warn("prompt.media_http_status", status=response.status_code)
                    return False
                total = 0
                async for chunk in response.aiter_bytes():
                    total += len(chunk)
                    if total > max_bytes:
                        self.log.warn("prompt.media_too_large", bytes=total)
                        return False
                    await consume(chunk)
                return total > 0
        except httpx.HTTPError as exc:
            self.log.warn("prompt.media_download_error", exc=exc)
            return False

    def _upload_url(self, upload_id: str) -> str:
        return f"{self.control_plane_url}/sessions/{self.session_id}/uploads/{upload_id}"

    async def _extract_video_frames(self, video_path: Path, out_dir: Path) -> list[Path]:
        duration = await self._probe_video_duration(video_path)
        vf = f"fps={self.MAX_VIDEO_FRAMES / duration:.6f}" if duration and duration > 0 else "fps=1"
        process = await self._run_process(
            "ffmpeg",
            "-nostdin",
            "-y",
            "-i",
            str(video_path),
            "-vf",
            vf,
            "-frames:v",
            str(self.MAX_VIDEO_FRAMES),
            "-q:v",
            "4",
            str(out_dir / "frame_%03d.jpg"),
        )
        if process is None or process[0] != 0:
            if process:
                self.log.warn(
                    "prompt.ffmpeg_failed", stderr=process[2].decode("utf-8", "ignore")[:500]
                )
            return []
        return sorted(out_dir.glob("frame_*.jpg"))

    async def _probe_video_duration(self, video_path: Path) -> float | None:
        process = await self._run_process(
            "ffprobe",
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
            str(video_path),
        )
        if process is None or process[0] != 0:
            return None
        try:
            return float(process[1].decode().strip())
        except ValueError:
            return None

    async def _run_process(self, *command: str) -> tuple[int, bytes, bytes] | None:
        try:
            process = await asyncio.create_subprocess_exec(
                *command,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
        except FileNotFoundError:
            self.log.warn("prompt.media_tool_missing", tool=command[0])
            return None
        try:
            stdout, stderr = await asyncio.wait_for(
                process.communicate(), timeout=self.SUBPROCESS_TIMEOUT_SECONDS
            )
        except TimeoutError:
            process.kill()
            await process.communicate()
            self.log.warn("prompt.media_process_timeout", tool=command[0])
            return None
        return cast("tuple[int, bytes, bytes]", (process.returncode, stdout, stderr))

    def is_video(self, attachment: dict[str, Any]) -> bool:
        """Return whether an attachment is a video by MIME type or extension."""
        mime = attachment.get("mimeType") or attachment.get("mime") or ""
        if isinstance(mime, str) and mime.startswith("video/"):
            return True
        for candidate in (attachment.get("name") or "", attachment.get("url") or ""):
            guessed = mimetypes.guess_type(candidate)[0] or ""
            extension = (
                candidate.rsplit(".", 1)[-1].split("?")[0].lower() if "." in candidate else ""
            )
            if guessed.startswith("video/") or extension in self.VIDEO_EXTENSIONS:
                return True
        return False

    def build_file_parts(self, attachments: list[dict[str, Any]] | None) -> list[dict[str, Any]]:
        """Convert resolved attachments into OpenCode file parts."""
        parts: list[dict[str, Any]] = []
        for attachment in attachments or []:
            if not isinstance(attachment, dict) or self.is_video(attachment):
                continue
            name = attachment.get("name") or "attachment"
            mime = attachment.get("mimeType") or attachment.get("mime")
            content = attachment.get("content")
            url = attachment.get("url")
            if content:
                resolved_mime = mime or "application/octet-stream"
                file_url = f"data:{resolved_mime};base64,{content}"
            elif url:
                resolved_mime = mime or mimetypes.guess_type(url)[0] or "application/octet-stream"
                file_url = url
            else:
                self.log.warn("prompt.attachment_skipped", attachment_name=name)
                continue
            parts.append({"type": "file", "mime": resolved_mime, "filename": name, "url": file_url})
        return parts
