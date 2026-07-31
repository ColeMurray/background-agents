"""Modal provider-session lifecycle for environment image builds."""

import json
import time

import modal
from modal.stream_type import StreamType

from sandbox_runtime.constants import IMAGE_BUILD_EXECUTION_TIMEOUT_ENV_VAR
from sandbox_runtime.log_config import get_logger
from sandbox_runtime.repo_image_callback import (
    BUILD_ID_ENV,
    CALLBACK_TOKEN_ENV,
    CALLBACK_URL_ENV,
    FAILURE_CALLBACK_URL_ENV,
    PROVIDER_SESSION_ID_ENV,
)

from ..app import app
from ..images.base import base_image
from .manager import SNAPSHOT_FILESYSTEM_TIMEOUT_SECONDS
from .vcs_env import inject_vcs_env_vars

log = get_logger("build_session")

# Mirrors packages/shared/src/types/integrations.ts; guarded by a contract test.
DEFAULT_BUILD_TIMEOUT_SECONDS = 1800
MAX_BUILD_TIMEOUT_SECONDS = 3600


class BuildSessionNotFoundError(LookupError):
    """The requested provider session is absent or bound to another build."""


class ModalBuildSessionService:
    """Own the identity-bound lifecycle of one Modal image-build sandbox."""

    async def create(
        self,
        *,
        build_id: str,
        scope_kind: str,
        scope_id: str,
        repositories: list[dict],
        clone_token: str = "",
        clone_host: str | None = None,
        clone_username: str | None = None,
        user_env_vars: dict[str, str] | None = None,
        build_execution_timeout_seconds: int = DEFAULT_BUILD_TIMEOUT_SECONDS,
        timeout_seconds: int = DEFAULT_BUILD_TIMEOUT_SECONDS,
    ) -> str:
        start_time = time.time()
        primary = repositories[0]
        env_vars = dict(user_env_vars or {})
        env_vars.update(
            {
                "PYTHONUNBUFFERED": "1",
                "SANDBOX_ID": f"build-{build_id}",
                "REPO_OWNER": primary["repo_owner"],
                "REPO_NAME": primary["repo_name"],
                "IMAGE_BUILD_MODE": "true",
                "SESSION_CONFIG": json.dumps(
                    {
                        "branch": primary["branch"],
                        "repositories": repositories,
                    }
                ),
                BUILD_ID_ENV: "",
                CALLBACK_URL_ENV: "",
                FAILURE_CALLBACK_URL_ENV: "",
                CALLBACK_TOKEN_ENV: "",
                PROVIDER_SESSION_ID_ENV: "",
                IMAGE_BUILD_EXECUTION_TIMEOUT_ENV_VAR: str(build_execution_timeout_seconds),
            }
        )
        inject_vcs_env_vars(
            env_vars,
            clone_token or None,
            clone_host=clone_host,
            clone_username=clone_username,
        )

        sandbox = await modal.Sandbox.create.aio(
            "python",
            "-c",
            "import signal; signal.pause()",
            image=base_image,
            app=app,
            secrets=[],
            timeout=timeout_seconds,
            workdir="/workspace",
            env=env_vars,
            tags={
                "openinspect_kind": "image-build",
                "openinspect_build_id": build_id,
                "openinspect_scope_kind": scope_kind,
                "openinspect_scope_id": scope_id,
            },
        )
        log.info(
            "sandbox.create_build",
            build_id=build_id,
            modal_object_id=sandbox.object_id,
            repo_owner=primary["repo_owner"],
            repo_name=primary["repo_name"],
            duration_ms=int((time.time() - start_time) * 1000),
            outcome="success",
        )
        return sandbox.object_id

    async def start(
        self,
        *,
        build_id: str,
        provider_session_id: str,
        callback_url: str,
        failure_callback_url: str,
        callback_token: str,
    ) -> None:
        sandbox = await self._resolve(build_id, provider_session_id)
        await sandbox.exec.aio(
            "python",
            "-m",
            "sandbox_runtime.entrypoint",
            workdir="/workspace",
            env={
                BUILD_ID_ENV: build_id,
                CALLBACK_URL_ENV: callback_url,
                FAILURE_CALLBACK_URL_ENV: failure_callback_url,
                CALLBACK_TOKEN_ENV: callback_token,
                PROVIDER_SESSION_ID_ENV: provider_session_id,
            },
            stdout=StreamType.DEVNULL,
            stderr=StreamType.DEVNULL,
        )
        log.info(
            "sandbox.start_build",
            build_id=build_id,
            modal_object_id=provider_session_id,
        )

    async def terminate(
        self,
        *,
        build_id: str,
        provider_session_id: str,
        reason: str,
    ) -> None:
        try:
            sandbox = await self._resolve(build_id, provider_session_id)
            await sandbox.terminate.aio()
        except BuildSessionNotFoundError:
            log.info(
                "sandbox.terminate_build_not_found",
                build_id=build_id,
                modal_object_id=provider_session_id,
                reason=reason,
            )
            return
        log.info(
            "sandbox.terminate_build",
            build_id=build_id,
            modal_object_id=provider_session_id,
            reason=reason,
        )

    async def snapshot(self, *, build_id: str, provider_session_id: str) -> str:
        sandbox = await self._resolve(build_id, provider_session_id)
        image = await sandbox.snapshot_filesystem.aio(timeout=SNAPSHOT_FILESYSTEM_TIMEOUT_SECONDS)
        log.info(
            "sandbox.snapshot_build",
            build_id=build_id,
            modal_object_id=provider_session_id,
            image_id=image.object_id,
        )
        return image.object_id

    @staticmethod
    async def _resolve(build_id: str, provider_session_id: str):
        try:
            sandbox = await modal.Sandbox.from_id.aio(provider_session_id)
            tags = await sandbox.get_tags.aio()
        except modal.exception.NotFoundError as e:
            raise BuildSessionNotFoundError("build session not found") from e
        if (
            tags.get("openinspect_kind") != "image-build"
            or tags.get("openinspect_build_id") != build_id
        ):
            raise BuildSessionNotFoundError("build session not found")
        return sandbox
