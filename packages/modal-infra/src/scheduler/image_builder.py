"""
Async image builder for repository pre-built images.

This module handles:
- Building repository images asynchronously (triggered by control plane)
- Creating build sandboxes, awaiting exit, snapshotting filesystem
- Reporting results back to control plane via authenticated callbacks

The build flow:
1. Control plane POSTs to api_build_repo_image with repo info + callback URL
2. api_build_repo_image spawns build_repo_image.spawn() and returns immediately
3. build_repo_image creates a build sandbox, waits for it to finish, snapshots
4. On success/failure, POSTs result to the callback URL with HMAC auth
"""

import asyncio
import os
import time

import httpx

from ..app import app, function_image, github_app_secrets, internal_api_secret
from ..auth.internal import generate_internal_token
from ..log_config import get_logger

log = get_logger("image_builder")

# Retry config for callbacks
CALLBACK_MAX_RETRIES = 3
CALLBACK_BACKOFF_BASE = 2  # seconds: 2, 8, 32


class BuildError(Exception):
    """Raised when a build sandbox fails."""

    pass


async def _callback_with_retry(
    url: str,
    payload: dict,
    secret: str | None = None,
) -> bool:
    """
    POST a JSON payload to the callback URL with HMAC auth and retries.

    Args:
        url: The callback URL to POST to
        payload: JSON body to send
        secret: MODAL_API_SECRET for auth. If None, reads from env.

    Returns:
        True if the callback succeeded, False if all retries failed
    """
    for attempt in range(CALLBACK_MAX_RETRIES):
        try:
            token = generate_internal_token(secret)
            async with httpx.AsyncClient(timeout=30.0) as client:
                response = await client.post(
                    url,
                    json=payload,
                    headers={
                        "Authorization": f"Bearer {token}",
                        "Content-Type": "application/json",
                    },
                )
                response.raise_for_status()
                log.info(
                    "callback.success",
                    url=url,
                    attempt=attempt + 1,
                    status=response.status_code,
                )
                return True
        except Exception as e:
            delay = CALLBACK_BACKOFF_BASE ** (attempt + 1)
            log.warn(
                "callback.retry",
                url=url,
                attempt=attempt + 1,
                max_retries=CALLBACK_MAX_RETRIES,
                delay_s=delay,
                error=str(e),
            )
            if attempt < CALLBACK_MAX_RETRIES - 1:
                await asyncio.sleep(delay)

    log.error(
        "callback.failed",
        url=url,
        max_retries=CALLBACK_MAX_RETRIES,
    )
    return False


def _read_sandbox_head_sha(sandbox) -> str:
    """
    Read the git HEAD SHA from a sandbox by executing git rev-parse.

    Args:
        sandbox: A modal.Sandbox instance

    Returns:
        The HEAD SHA string, or empty string on failure
    """
    try:
        process = sandbox.exec("git", "-C", "/workspace/repo", "rev-parse", "HEAD")
        stdout = process.stdout.read().strip()
        return stdout
    except Exception as e:
        log.warn("sandbox.read_sha_error", error=str(e))
        return ""


@app.function(
    image=function_image,
    secrets=[internal_api_secret, github_app_secrets],
    timeout=1800,  # 30 minutes
)
async def build_repo_image(
    repo_owner: str,
    repo_name: str,
    default_branch: str = "main",
    callback_url: str = "",
    build_id: str = "",
) -> None:
    """
    Async worker: create build sandbox, await exit, snapshot, callback.

    This function is spawned by api_build_repo_image and runs asynchronously.
    Results are reported back to the control plane via callback URLs.

    Args:
        repo_owner: GitHub repository owner
        repo_name: GitHub repository name
        default_branch: Branch to clone and build
        callback_url: URL to POST success result to
        build_id: Build identifier from the control plane
    """
    from ..auth.github_app import generate_installation_token
    from ..sandbox.manager import SandboxManager

    start_time = time.time()
    manager = SandboxManager()

    try:
        # 1. Generate GitHub App install token for clone
        clone_token = ""
        try:
            app_id = os.environ.get("GITHUB_APP_ID")
            private_key = os.environ.get("GITHUB_APP_PRIVATE_KEY")
            installation_id = os.environ.get("GITHUB_APP_INSTALLATION_ID")

            if app_id and private_key and installation_id:
                clone_token = generate_installation_token(
                    app_id=app_id,
                    private_key=private_key,
                    installation_id=installation_id,
                )
        except Exception as e:
            log.warn("github.token_error", error=str(e))

        # 2. Create build sandbox
        log.info(
            "build.start",
            build_id=build_id,
            repo_owner=repo_owner,
            repo_name=repo_name,
            default_branch=default_branch,
        )

        handle = await manager.create_build_sandbox(
            repo_owner=repo_owner,
            repo_name=repo_name,
            default_branch=default_branch,
            clone_token=clone_token,
        )

        # 3. Await sandbox exit
        handle.modal_sandbox.wait()
        exit_code = handle.modal_sandbox.returncode
        if exit_code != 0:
            raise BuildError(f"Build sandbox exited with code {exit_code}")

        # 4. Read base SHA before snapshot
        base_sha = _read_sandbox_head_sha(handle.modal_sandbox)

        # 5. Snapshot filesystem
        image = handle.modal_sandbox.snapshot_filesystem()
        provider_image_id = image.object_id

        build_duration = time.time() - start_time

        log.info(
            "build.success",
            build_id=build_id,
            provider_image_id=provider_image_id,
            base_sha=base_sha,
            build_duration_s=round(build_duration, 1),
        )

        # 6. Callback: success
        if callback_url:
            await _callback_with_retry(
                callback_url,
                {
                    "build_id": build_id,
                    "provider_image_id": provider_image_id,
                    "base_sha": base_sha,
                    "build_duration_seconds": round(build_duration, 2),
                },
            )

    except Exception as e:
        build_duration = time.time() - start_time
        log.error(
            "build.failed",
            build_id=build_id,
            error=str(e),
            build_duration_s=round(build_duration, 1),
        )

        # Callback: failure
        if callback_url:
            failure_url = callback_url.replace("/build-complete", "/build-failed")
            await _callback_with_retry(
                failure_url,
                {
                    "build_id": build_id,
                    "error": str(e),
                },
            )
