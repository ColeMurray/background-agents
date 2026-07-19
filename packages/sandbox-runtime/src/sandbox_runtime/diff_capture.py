"""Best-effort, non-blocking session diff refresh worker."""

from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass
from enum import Enum
from typing import TYPE_CHECKING, Protocol
from urllib.parse import quote

import httpx

from .diff_collector import (
    SESSION_DIFF_MAX_ERROR_LENGTH,
    CaptureLimits,
    DiffCaptureError,
    SessionDiffBundle,
    collect_session_diff_bundle,
    encode_bundle,
)
from .repo_config import load_repo_manifest

if TYPE_CHECKING:
    from collections.abc import Awaitable
    from pathlib import Path

    from .log_config import StructuredLogger
    from .repo_config import RepoEntry

DEFAULT_REFRESH_TIMEOUT_SECONDS = 60.0


class BundleCollector(Protocol):
    """Collects every session repository into one bounded upload bundle."""

    def __call__(
        self,
        repositories: list[RepoEntry],
        *,
        trigger_message_id: str | None,
        captured_at: int,
        limits: CaptureLimits | None = None,
    ) -> Awaitable[SessionDiffBundle]: ...


class DiffUploadOutcome(Enum):
    """The control plane's disposition of a diff endpoint call."""

    ACCEPTED = "accepted"
    UNSUPPORTED = "unsupported"


class ControlPlaneDiffClient:
    """HTTP client for the control plane's session diff endpoints.

    Owns its connection pool unless one is injected. A 404 from either
    endpoint means this control plane predates the diff feature; callers
    should stop uploading for the rest of the sandbox's life.
    """

    def __init__(
        self,
        *,
        control_plane_url: str,
        session_id: str,
        auth_token: str,
        timeout_seconds: float = DEFAULT_REFRESH_TIMEOUT_SECONDS,
        http_client: httpx.AsyncClient | None = None,
    ) -> None:
        base_url = control_plane_url.rstrip("/")
        self._diff_url = f"{base_url}/sessions/{quote(session_id, safe='')}/diff"
        self._auth_token = auth_token
        self._timeout_seconds = timeout_seconds
        self._http_client = http_client
        self._owns_http_client = http_client is None

    async def upload_bundle(self, bundle: SessionDiffBundle) -> DiffUploadOutcome:
        response = await self._client().put(
            self._diff_url,
            headers={
                "Authorization": f"Bearer {self._auth_token}",
                "Content-Type": "application/json",
            },
            content=encode_bundle(bundle),
            timeout=self._timeout_seconds,
        )
        return self._outcome(response)

    async def report_failure(self, message: str) -> DiffUploadOutcome:
        response = await self._client().post(
            f"{self._diff_url}/failure",
            headers={"Authorization": f"Bearer {self._auth_token}"},
            json={"error": message},
            timeout=self._timeout_seconds,
        )
        return self._outcome(response)

    async def aclose(self) -> None:
        if self._owns_http_client and self._http_client is not None:
            await self._http_client.aclose()

    def _client(self) -> httpx.AsyncClient:
        # Created on first request so constructing a bridge that never runs
        # (common in tests) does not leak an unclosed connection pool.
        if self._http_client is None:
            self._http_client = httpx.AsyncClient()
        return self._http_client

    def _outcome(self, response: httpx.Response) -> DiffUploadOutcome:
        if response.status_code == 404:
            return DiffUploadOutcome.UNSUPPORTED
        response.raise_for_status()
        return DiffUploadOutcome.ACCEPTED


@dataclass(frozen=True)
class _RefreshAttempt:
    """One coalesced refresh request, snapshotted before collection starts."""

    generation: int
    activity_generation: int
    trigger_message_id: str | None


class SessionDiffRefreshWorker:
    """Coalesces terminal executions into one eventual idle checkout refresh."""

    def __init__(
        self,
        *,
        client: ControlPlaneDiffClient,
        manifest_path: Path,
        log: StructuredLogger,
        collector: BundleCollector = collect_session_diff_bundle,
        limits: CaptureLimits | None = None,
        refresh_timeout_seconds: float = DEFAULT_REFRESH_TIMEOUT_SECONDS,
    ) -> None:
        self.client = client
        self.manifest_path = manifest_path
        self.log = log
        self.collector = collector
        self.limits = limits or CaptureLimits.defaults()
        self.refresh_timeout_seconds = refresh_timeout_seconds

        self._requested_generation = 0
        self._settled_generation = 0
        self._activity_generation = 0
        self._trigger_message_id: str | None = None
        self._active_prompt_count = 0
        self._idle = asyncio.Event()
        self._idle.set()
        self._task: asyncio.Task[None] | None = None
        self._unsupported = False
        self._closed = False

    def prompt_started(self) -> None:
        """Invalidate overlapping collections and hold refreshes until idle."""
        self._activity_generation += 1
        self._active_prompt_count += 1
        self._idle.clear()

    def prompt_finished(self) -> None:
        """Release the idle gate once every started prompt has terminated."""
        self._active_prompt_count = max(0, self._active_prompt_count - 1)
        if self._active_prompt_count == 0:
            self._idle.set()

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
        """Stop accepting refreshes and bound shutdown waiting to ``timeout_seconds``."""
        self._closed = True
        await self.flush(timeout_seconds=timeout_seconds)
        await self.client.aclose()

    async def _run(self) -> None:
        try:
            while not self._unsupported and self._settled_generation < self._requested_generation:
                await self._idle.wait()
                await self._settle(self._snapshot_attempt())
        finally:
            self._task = None
            self._restart_if_requested_during_exit()

    def _snapshot_attempt(self) -> _RefreshAttempt:
        return _RefreshAttempt(
            generation=self._requested_generation,
            activity_generation=self._activity_generation,
            trigger_message_id=self._trigger_message_id,
        )

    async def _settle(self, attempt: _RefreshAttempt) -> None:
        """Collect and upload one bundle, settling ``attempt`` unless it went stale.

        Returning without settling leaves the loop condition true, so the next
        iteration retries against the checkout's current state.
        """
        repositories = load_repo_manifest(self.manifest_path)
        if not repositories:
            self._settled_generation = attempt.generation
            return

        try:
            bundle = await self._collect_bundle(attempt, repositories)
        except asyncio.CancelledError:
            raise
        except Exception as error:
            if not self._is_stale(attempt):
                await self._report_failure(error)
                self._settled_generation = attempt.generation
            return

        if self._is_stale(attempt):
            self.log.info("session_diff.refresh_discarded", generation=attempt.generation)
            return

        try:
            outcome = await self.client.upload_bundle(bundle)
        except asyncio.CancelledError:
            raise
        except Exception as error:
            await self._report_failure(error)
        else:
            if outcome is DiffUploadOutcome.UNSUPPORTED:
                self._mark_unsupported()
            else:
                self.log.info(
                    "session_diff.collection_completed",
                    repository_count=len(bundle["repositories"]),
                    encoded_bytes=len(encode_bundle(bundle)),
                )
        self._settled_generation = attempt.generation

    async def _collect_bundle(
        self, attempt: _RefreshAttempt, repositories: list[RepoEntry]
    ) -> SessionDiffBundle:
        bundle = await asyncio.wait_for(
            self.collector(
                repositories,
                trigger_message_id=attempt.trigger_message_id,
                captured_at=int(time.time() * 1_000),
                limits=self.limits,
            ),
            timeout=self.refresh_timeout_seconds,
        )
        if all(repository["status"] != "ready" for repository in bundle["repositories"]):
            raise DiffCaptureError("All repositories failed to collect changes")
        return bundle

    def _is_stale(self, attempt: _RefreshAttempt) -> bool:
        return (
            self._active_prompt_count > 0
            or attempt.generation != self._requested_generation
            or attempt.activity_generation != self._activity_generation
        )

    async def _report_failure(self, error: Exception) -> None:
        message = str(error)[:SESSION_DIFF_MAX_ERROR_LENGTH] or "Session diff refresh failed"
        self.log.warn("session_diff.refresh_failed", error=message)
        if self._unsupported:
            return
        try:
            outcome = await self.client.report_failure(message)
        except Exception as report_error:
            self.log.warn(
                "session_diff.failure_report_failed",
                error=str(report_error)[:SESSION_DIFF_MAX_ERROR_LENGTH],
            )
        else:
            if outcome is DiffUploadOutcome.UNSUPPORTED:
                self._mark_unsupported()

    def _mark_unsupported(self) -> None:
        self._unsupported = True
        self.log.info("session_diff.unsupported")

    def _restart_if_requested_during_exit(self) -> None:
        # request() may bump the generation after the loop condition was read
        # but before this task is observably done; respawn so that refresh is
        # not silently lost.
        if (
            not self._unsupported
            and not self._closed
            and self._settled_generation < self._requested_generation
        ):
            self._task = asyncio.create_task(self._run())
