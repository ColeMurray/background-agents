"""Repo-image build callback reporting for build-mode sandboxes."""

from __future__ import annotations

import asyncio
import os
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


class RepoImageCallbackMisconfigured(Exception):
    """Some but not all build-callback environment variables are set.

    Raised instead of returning None so a build-mode sandbox aborts with a
    nonzero exit rather than running the build with completion reporting
    silently disabled (which would leave the control-plane row wedged in
    `building` until the provider-side timeout reaper fires).
    """


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
    def from_env(cls, logger: StructuredLogger | None = None) -> RepoImageBuildCallback | None:
        """Create a callback reporter from build-mode environment variables.

        Returns None when no callback variable is set at all (not an
        image-build callback context). Raises RepoImageCallbackMisconfigured
        when only some are set: the control plane rejects callbacks missing
        any field, so a partially configured build must abort at boot instead
        of running with reporting silently disabled.
        """
        build_id = os.environ.get(BUILD_ID_ENV, "")
        callback_url = os.environ.get(CALLBACK_URL_ENV, "")
        failure_callback_url = os.environ.get(FAILURE_CALLBACK_URL_ENV, "")
        token = os.environ.get(CALLBACK_TOKEN_ENV, "")
        provider_session_id = os.environ.get(PROVIDER_SESSION_ID_ENV, "")

        values = (
            (BUILD_ID_ENV, build_id),
            (CALLBACK_URL_ENV, callback_url),
            (FAILURE_CALLBACK_URL_ENV, failure_callback_url),
            (CALLBACK_TOKEN_ENV, token),
            (PROVIDER_SESSION_ID_ENV, provider_session_id),
        )
        # Configuration is detected by variable PRESENCE, not truthiness: a
        # present-but-empty variable is a misconfigured build context, and the
        # empty-value check below must reject it rather than silently
        # disabling completion reporting.
        if not any(name in os.environ for name, _value in values):
            return None

        log = logger or get_logger("repo_image_callback")
        missing = [name for name, value in values if not value]
        if missing:
            log.error("repo_image.callback_misconfigured", missing=missing)
            raise RepoImageCallbackMisconfigured(
                f"partial build-callback configuration; missing: {', '.join(missing)}"
            )

        return cls(
            build_id=build_id,
            callback_url=callback_url,
            failure_callback_url=failure_callback_url,
            token=token,
            provider_session_id=provider_session_id,
            logger=log,
        )

    async def report_success(
        self,
        *,
        build_duration_seconds: float,
        repository_shas: list[dict[str, str]],
        runtime_version: str,
    ) -> bool:
        """Report a successful image build.

        repository_shas ([{repoOwner, repoName, baseSha}]) and runtime_version
        are required by image registration (design §7.3) — the control plane
        rejects a completion missing either. provider_session_id is always
        sent: every provider sets it unconditionally at spawn.
        """
        payload: dict[str, Any] = {
            "build_id": self.build_id,
            "build_duration_seconds": round(build_duration_seconds, 3),
            "repository_shas": repository_shas,
            "runtime_version": runtime_version,
            "provider_session_id": self.provider_session_id,
        }
        return await self._post_with_retry(self.callback_url, payload)

    async def report_failure(self, error: str) -> bool:
        """Report a failed repo-image build."""
        payload = {
            "build_id": self.build_id,
            "error": error[-ERROR_MESSAGE_MAX_CHARS:],
            "provider_session_id": self.provider_session_id,
        }
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
