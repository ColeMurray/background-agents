"""Repo-image build callback reporting for build-mode sandboxes."""

from __future__ import annotations

import asyncio
import os
import re
from dataclasses import dataclass, field
from typing import Any

import httpx

from .log_config import StructuredLogger, get_logger

CALLBACK_MAX_RETRIES = 3
CALLBACK_BACKOFF_BASE_SECONDS = 2
CALLBACK_TIMEOUT_SECONDS = 30.0
CALLBACK_USER_AGENT = "open-inspect/repo-image-builder"
ERROR_MESSAGE_MAX_CHARS = 500

BUILD_ID_ENV = "OI_REPO_IMAGE_BUILD_ID"
CALLBACK_URL_ENV = "OI_REPO_IMAGE_CALLBACK_URL"
FAILURE_CALLBACK_URL_ENV = "OI_REPO_IMAGE_FAILURE_CALLBACK_URL"
CALLBACK_TOKEN_ENV = "OI_REPO_IMAGE_CALLBACK_TOKEN"
PROVIDER_SESSION_ID_ENV = "OI_REPO_IMAGE_PROVIDER_SESSION_ID"
MODAL_SANDBOX_ID_ENV = "MODAL_SANDBOX_ID"
CALLBACK_TOKEN_PATTERN = re.compile(r"^[a-f0-9]{64}$")
MAX_CALLBACK_TOKEN_LINE_BYTES = 65
MODAL_IMAGE_BUILD_START_ARGUMENT = "--await-modal-image-build-token-stdin-v1"
MODAL_IMAGE_BUILD_START_PROTOCOL = "stdin-token-v1"


class ModalImageBuildStartCancelled(Exception):
    """Shutdown won while the Modal build waited for its callback token."""


async def read_modal_callback_token(
    reader: asyncio.StreamReader,
    shutdown_event: asyncio.Event,
) -> str:
    """Read and validate the one callback token delivered after provider binding."""
    read_task = asyncio.create_task(reader.readline())
    shutdown_task = asyncio.create_task(shutdown_event.wait())
    tasks = {read_task, shutdown_task}
    try:
        done, _pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
    finally:
        for task in tasks:
            if not task.done():
                task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)

    if shutdown_task in done and shutdown_event.is_set():
        raise ModalImageBuildStartCancelled

    try:
        raw_token = read_task.result()
    except ValueError as error:
        raise ValueError("callback token too large") from error
    if not raw_token:
        raise ValueError("stdin closed")
    if not raw_token.endswith(b"\n"):
        raise ValueError("incomplete callback token")
    if len(raw_token) > MAX_CALLBACK_TOKEN_LINE_BYTES:
        raise ValueError("callback token too large")
    try:
        token = raw_token[:-1].decode("ascii")
    except UnicodeDecodeError as error:
        raise ValueError("invalid callback token") from error
    if not CALLBACK_TOKEN_PATTERN.fullmatch(token):
        raise ValueError("invalid callback token")
    return token


@dataclass(frozen=True)
class RepoImageBuildCallback:
    """Authenticated callback reporter for image build mode."""

    build_id: str
    callback_url: str
    # Sent explicitly by the control plane so the failure route is never derived
    # from callback_url's path (mirrors client.ts buildImage).
    failure_callback_url: str
    token: str
    provider_session_id: str = ""
    logger: StructuredLogger = field(default_factory=lambda: get_logger("repo_image_callback"))

    @classmethod
    def from_modal_token(
        cls, token: str, logger: StructuredLogger | None = None
    ) -> RepoImageBuildCallback:
        """Create a callback reporter from a post-bind token and Modal runtime identity."""
        if not CALLBACK_TOKEN_PATTERN.fullmatch(token):
            raise ValueError("invalid callback token")
        context = {
            BUILD_ID_ENV: os.environ.get(BUILD_ID_ENV, ""),
            CALLBACK_URL_ENV: os.environ.get(CALLBACK_URL_ENV, ""),
            FAILURE_CALLBACK_URL_ENV: os.environ.get(FAILURE_CALLBACK_URL_ENV, ""),
            MODAL_SANDBOX_ID_ENV: os.environ.get(MODAL_SANDBOX_ID_ENV, ""),
        }
        missing = [name for name, value in context.items() if not value]
        if missing:
            raise ValueError(f"missing Modal callback context: {', '.join(missing)}")
        return cls(
            build_id=context[BUILD_ID_ENV],
            callback_url=context[CALLBACK_URL_ENV],
            failure_callback_url=context[FAILURE_CALLBACK_URL_ENV],
            token=token,
            provider_session_id=context[MODAL_SANDBOX_ID_ENV],
            logger=logger or get_logger("repo_image_callback"),
        )

    @classmethod
    def from_env(cls, logger: StructuredLogger | None = None) -> RepoImageBuildCallback | None:
        """Create a callback reporter from build-mode environment variables."""
        build_id = os.environ.get(BUILD_ID_ENV, "")
        callback_url = os.environ.get(CALLBACK_URL_ENV, "")
        failure_callback_url = os.environ.get(FAILURE_CALLBACK_URL_ENV, "")
        token = os.environ.get(CALLBACK_TOKEN_ENV, "")

        if not build_id and not callback_url and not token:
            return None

        log = logger or get_logger("repo_image_callback")
        missing = [
            name
            for name, value in (
                (BUILD_ID_ENV, build_id),
                (CALLBACK_URL_ENV, callback_url),
                (FAILURE_CALLBACK_URL_ENV, failure_callback_url),
                (CALLBACK_TOKEN_ENV, token),
            )
            if not value
        ]
        if missing:
            log.error("repo_image.callback_misconfigured", missing=missing)
            return None

        return cls(
            build_id=build_id,
            callback_url=callback_url,
            failure_callback_url=failure_callback_url,
            token=token,
            provider_session_id=os.environ.get(PROVIDER_SESSION_ID_ENV, ""),
            logger=log,
        )

    async def report_success(
        self,
        *,
        base_sha: str,
        build_duration_seconds: float,
        repository_shas: list[dict[str, str]] | None = None,
        runtime_version: str = "",
    ) -> bool:
        """Report a successful image build.

        repository_shas ([{repoOwner, repoName, baseSha}]) and runtime_version are
        required by environment-image registration (design §7.3) and ignored
        by the repo-image callback route.
        """
        payload: dict[str, Any] = {
            "build_id": self.build_id,
            "base_sha": base_sha,
            "build_duration_seconds": round(build_duration_seconds, 3),
        }
        if repository_shas:
            payload["repository_shas"] = repository_shas
        if runtime_version:
            payload["runtime_version"] = runtime_version
        if self.provider_session_id:
            payload["provider_session_id"] = self.provider_session_id

        return await self._post_with_retry(self.callback_url, payload)

    async def report_failure(self, error: str) -> bool:
        """Report a failed repo-image build."""
        payload = {
            "build_id": self.build_id,
            "error": error[-ERROR_MESSAGE_MAX_CHARS:],
        }
        if self.provider_session_id:
            payload["provider_session_id"] = self.provider_session_id
        return await self._post_with_retry(self.failure_callback_url, payload)

    async def _post_with_retry(self, url: str, payload: dict[str, Any]) -> bool:
        for attempt in range(1, CALLBACK_MAX_RETRIES + 1):
            try:
                async with httpx.AsyncClient(timeout=CALLBACK_TIMEOUT_SECONDS) as client:
                    response = await client.post(
                        url,
                        json=payload,
                        headers={
                            "Authorization": f"Bearer {self.token}",
                            "Content-Type": "application/json",
                            "User-Agent": CALLBACK_USER_AGENT,
                        },
                    )
                    response.raise_for_status()
                self.logger.info(
                    "repo_image.callback_success",
                    build_id=self.build_id,
                    url=url,
                    attempt=attempt,
                    status=response.status_code,
                )
                return True
            except Exception as exc:
                delay = CALLBACK_BACKOFF_BASE_SECONDS**attempt
                self.logger.warn(
                    "repo_image.callback_retry",
                    build_id=self.build_id,
                    url=url,
                    attempt=attempt,
                    max_retries=CALLBACK_MAX_RETRIES,
                    delay_s=delay,
                    error=str(exc),
                )
                if attempt < CALLBACK_MAX_RETRIES:
                    await asyncio.sleep(delay)

        self.logger.error(
            "repo_image.callback_failed",
            build_id=self.build_id,
            url=url,
            max_retries=CALLBACK_MAX_RETRIES,
        )
        return False
