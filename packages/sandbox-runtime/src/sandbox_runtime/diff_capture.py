"""Best-effort, non-blocking session diff refresh worker."""

from __future__ import annotations

import asyncio
import time
from collections.abc import Awaitable, Callable
from typing import TYPE_CHECKING
from urllib.parse import quote

from .diff_collector import (
    CaptureLimits,
    DiffCaptureError,
    SessionDiffBundle,
    collect_session_diff_bundle,
    encode_bundle,
)

if TYPE_CHECKING:
    import httpx

    from .log_config import StructuredLogger
    from .repo_config import RepoEntry

DEFAULT_REFRESH_TIMEOUT_SECONDS = 60.0
DEFAULT_IDLE_POLL_SECONDS = 0.05

BundleCollector = Callable[..., Awaitable[SessionDiffBundle]]


class SessionDiffRefreshWorker:
    """Coalesces terminal executions into one eventual idle checkout refresh."""

    def __init__(
        self,
        *,
        session_id: str,
        control_plane_url: str,
        auth_token: str,
        load_repositories: Callable[[], list[RepoEntry]],
        is_idle: Callable[[], bool],
        get_http_client: Callable[[], httpx.AsyncClient | None],
        log: StructuredLogger,
        collector: BundleCollector = collect_session_diff_bundle,
        limits: CaptureLimits | None = None,
        refresh_timeout_seconds: float = DEFAULT_REFRESH_TIMEOUT_SECONDS,
        idle_poll_seconds: float = DEFAULT_IDLE_POLL_SECONDS,
    ) -> None:
        self.session_id = session_id
        self.control_plane_url = control_plane_url.rstrip("/")
        self.auth_token = auth_token
        self.load_repositories = load_repositories
        self.is_idle = is_idle
        self.get_http_client = get_http_client
        self.log = log
        self.collector = collector
        self.limits = limits or CaptureLimits.defaults()
        self.refresh_timeout_seconds = refresh_timeout_seconds
        self.idle_poll_seconds = idle_poll_seconds

        self._requested_generation = 0
        self._settled_generation = 0
        self._activity_generation = 0
        self._trigger_message_id: str | None = None
        self._task: asyncio.Task[None] | None = None
        self._unsupported = False
        self._closed = False

    def prompt_started(self) -> None:
        """Invalidate any collection that overlaps a newly mutating prompt."""
        self._activity_generation += 1

    def request(self, trigger_message_id: str | None) -> None:
        """Request a refresh without waiting for Git or the control plane."""
        if self._unsupported or self._closed:
            return
        self._requested_generation += 1
        self._trigger_message_id = trigger_message_id
        if self._task is None or self._task.done():
            self._task = asyncio.create_task(self._run())

    async def flush(self, *, timeout_seconds: float) -> None:
        """Best-effort wait for pending work, bounded for graceful shutdown."""
        task = self._task
        if task is None:
            return
        try:
            await asyncio.wait_for(asyncio.shield(task), timeout=timeout_seconds)
        except TimeoutError:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)

    async def close(self, *, timeout_seconds: float) -> None:
        self._closed = True
        await self.flush(timeout_seconds=timeout_seconds)

    async def _run(self) -> None:
        try:
            while not self._unsupported and self._settled_generation < self._requested_generation:
                while not self.is_idle():
                    await asyncio.sleep(self.idle_poll_seconds)

                generation = self._requested_generation
                activity_generation = self._activity_generation
                trigger_message_id = self._trigger_message_id
                repositories = self.load_repositories()
                if not repositories:
                    self._settled_generation = generation
                    continue

                try:
                    bundle = await asyncio.wait_for(
                        self.collector(
                            repositories,
                            trigger_message_id=trigger_message_id,
                            captured_at=int(time.time() * 1_000),
                            limits=self.limits,
                        ),
                        timeout=self.refresh_timeout_seconds,
                    )
                    ready_count = sum(
                        1
                        for repository in bundle["repositories"]
                        if isinstance(repository, dict) and repository.get("status") == "ready"
                    )
                    if ready_count == 0:
                        raise DiffCaptureError("All repositories failed to collect changes")
                except asyncio.CancelledError:
                    raise
                except Exception as error:
                    if self._is_stale(generation, activity_generation):
                        continue
                    await self._report_failure(error)
                    self._settled_generation = generation
                    continue

                if self._is_stale(generation, activity_generation):
                    self.log.info(
                        "session_diff.refresh_discarded",
                        generation=generation,
                    )
                    continue

                try:
                    supported = await self._upload(bundle)
                except asyncio.CancelledError:
                    raise
                except Exception as error:
                    await self._report_failure(error)
                else:
                    if supported:
                        self.log.info(
                            "session_diff.collection_completed",
                            repository_count=len(bundle["repositories"]),
                            encoded_bytes=len(encode_bundle(bundle)),
                        )
                self._settled_generation = generation
        finally:
            self._task = None
            if (
                not self._unsupported
                and not self._closed
                and self._settled_generation < self._requested_generation
            ):
                self._task = asyncio.create_task(self._run())

    def _is_stale(self, generation: int, activity_generation: int) -> bool:
        return (
            not self.is_idle()
            or generation != self._requested_generation
            or activity_generation != self._activity_generation
        )

    async def _upload(self, bundle: SessionDiffBundle) -> bool:
        client = self.get_http_client()
        if client is None:
            raise DiffCaptureError("Bridge HTTP client is unavailable")
        response = await client.request(
            "PUT",
            f"{self.control_plane_url}/sessions/{quote(self.session_id, safe='')}/diff",
            headers={
                "Authorization": f"Bearer {self.auth_token}",
                "Content-Type": "application/json",
            },
            content=encode_bundle(bundle),
            timeout=self.refresh_timeout_seconds,
        )
        if response.status_code == 404:
            self._unsupported = True
            self.log.info("session_diff.unsupported")
            return False
        response.raise_for_status()
        return True

    async def _report_failure(self, error: Exception) -> None:
        message = str(error)[:2_000] or "Session diff refresh failed"
        self.log.warn("session_diff.refresh_failed", error=message)
        client = self.get_http_client()
        if client is None or self._unsupported:
            return
        try:
            response = await client.request(
                "POST",
                f"{self.control_plane_url}/sessions/{quote(self.session_id, safe='')}/diff/failure",
                headers={
                    "Authorization": f"Bearer {self.auth_token}",
                    "Content-Type": "application/json",
                },
                json={"error": message},
                timeout=self.refresh_timeout_seconds,
            )
            if response.status_code == 404:
                self._unsupported = True
                return
            response.raise_for_status()
        except Exception as report_error:
            self.log.warn(
                "session_diff.failure_report_failed",
                error=str(report_error)[:2_000],
            )
