"""
Async image builder and scheduler for repository pre-built images.

This module handles:
- Building repository images asynchronously (triggered by control plane)
- Creating build sandboxes, awaiting exit, snapshotting filesystem
- Reporting results back to control plane via authenticated callbacks
- Scheduled rebuilds every 30 minutes (cron) with git ls-remote comparison

The build flow:
1. Control plane POSTs to api_build_repo_image with repo info + callback URL
2. api_build_repo_image spawns build_repo_image.spawn() and returns immediately
3. build_repo_image creates a build sandbox, waits for it to finish, snapshots
4. On success/failure, POSTs result to the callback URL with HMAC auth

The scheduler flow:
1. Every 30 min, fetch enabled repos and current image status from control plane
2. For each enabled repo, git ls-remote to get HEAD SHA
3. If SHA differs from latest ready image, trigger a build
4. Mark stale builds as failed, clean up old failed rows
"""

import asyncio
import json
import os
import subprocess
import time

import httpx
import modal

from ..app import (
    app,
    function_image,
    github_app_secrets,
    internal_api_secret,
    validate_control_plane_url,
)
from ..auth.internal import generate_internal_token
from ..log_config import get_logger

log = get_logger("image_builder")

# Retry config for callbacks
CALLBACK_MAX_RETRIES = 3
CALLBACK_BACKOFF_BASE = 2  # seconds: 2, 4, 8


class BuildError(Exception):
    """Raised when a build sandbox fails."""

    pass


def _outbound_secret() -> str:
    """Get INTERNAL_CALLBACK_SECRET for authenticating outbound calls to the control plane."""
    secret = os.environ.get("INTERNAL_CALLBACK_SECRET")
    if not secret:
        raise RuntimeError("INTERNAL_CALLBACK_SECRET not configured")
    return secret


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
        secret: INTERNAL_CALLBACK_SECRET for auth. If None, reads from env.

    Returns:
        True if the callback succeeded, False if all retries failed
    """
    if secret is None:
        secret = _outbound_secret()
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


def _generate_clone_token() -> str:
    """Generate a GitHub App install token for git operations. Returns empty string on failure."""
    from ..auth.github_app import generate_installation_token

    try:
        app_id = os.environ.get("GITHUB_APP_ID")
        private_key = os.environ.get("GITHUB_APP_PRIVATE_KEY")
        installation_id = os.environ.get("GITHUB_APP_INSTALLATION_ID")

        if app_id and private_key and installation_id:
            return generate_installation_token(
                app_id=app_id,
                private_key=private_key,
                installation_id=installation_id,
            )
    except Exception as e:
        log.warn("github.token_error", error=str(e))
    return ""


async def _stream_build_logs(sandbox) -> tuple[str, bool]:
    """
    Stream sandbox stdout and extract build results.

    The entrypoint logs structured JSON lines. We look for:
    - event="git.sync_complete" with "head_sha" field
    - event="image_build.complete" to know the build finished

    The sandbox stays alive after logging image_build.complete (it awaits
    shutdown_event), so we can snapshot_filesystem() while it's still running.

    Returns:
        (head_sha, build_complete) tuple. head_sha is empty string if not found.
    """
    head_sha = ""
    try:
        async for line in sandbox.stdout:
            if "git.sync_complete" not in line and "image_build.complete" not in line:
                continue
            try:
                entry = json.loads(line)
                event = entry.get("event", "")
                if event == "git.sync_complete" and entry.get("head_sha"):
                    head_sha = entry["head_sha"]
                elif event == "image_build.complete":
                    return head_sha, True
            except json.JSONDecodeError:
                continue
    except Exception as e:
        log.warn("build.stream_error", error=str(e))
    return head_sha, False


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
    from ..sandbox.manager import SandboxManager

    # Validate callback URL against allowed hosts to prevent SSRF
    if callback_url and not validate_control_plane_url(callback_url):
        log.error("build.invalid_callback_url", url=callback_url, build_id=build_id)
        return

    start_time = time.time()
    manager = SandboxManager()

    try:
        clone_token = _generate_clone_token()

        # Create build sandbox
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

        # 3. Stream stdout until build completes (sandbox stays alive for snapshotting)
        base_sha, build_complete = await _stream_build_logs(handle.modal_sandbox)
        if not build_complete:
            exit_code = handle.modal_sandbox.returncode
            raise BuildError(f"Build sandbox exited without completing (exit_code={exit_code})")

        # 4. Snapshot the running sandbox's filesystem
        image = await handle.modal_sandbox.snapshot_filesystem.aio()
        provider_image_id = image.object_id

        # 5. Terminate the sandbox (no longer needed after snapshot)
        await handle.modal_sandbox.terminate.aio()

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
            base_url = callback_url.rsplit("/", 1)[0]
            failure_url = f"{base_url}/build-failed"
            await _callback_with_retry(
                failure_url,
                {
                    "build_id": build_id,
                    "error": str(e),
                },
            )


# ---------------------------------------------------------------------------
# Scheduler: cron-based rebuild logic
# ---------------------------------------------------------------------------

# Stale build threshold: builds older than this are marked failed
STALE_BUILD_THRESHOLD_SECONDS = 2100  # 35 minutes

# Cleanup threshold: failed builds older than this are deleted
FAILED_BUILD_CLEANUP_SECONDS = 86400  # 24 hours


async def _api_get(
    url: str,
    secret: str | None = None,
) -> dict:
    """GET a control plane endpoint with HMAC auth."""
    if secret is None:
        secret = _outbound_secret()
    token = generate_internal_token(secret)
    async with httpx.AsyncClient(timeout=30.0) as client:
        response = await client.get(
            url,
            headers={"Authorization": f"Bearer {token}"},
        )
        response.raise_for_status()
        return response.json()


async def _api_post(
    url: str,
    payload: dict | None = None,
    secret: str | None = None,
) -> dict:
    """POST to a control plane endpoint with HMAC auth."""
    if secret is None:
        secret = _outbound_secret()
    token = generate_internal_token(secret)
    async with httpx.AsyncClient(timeout=30.0) as client:
        response = await client.post(
            url,
            json=payload or {},
            headers={
                "Authorization": f"Bearer {token}",
                "Content-Type": "application/json",
            },
        )
        response.raise_for_status()
        return response.json()


def _git_ls_remote_sha(
    repo_owner: str,
    repo_name: str,
    branch: str,
    clone_token: str,
) -> str | None:
    """
    Run git ls-remote to get the HEAD SHA for a branch.

    Returns the SHA string, or None on failure.
    """
    if clone_token:
        url = f"https://x-access-token:{clone_token}@github.com/{repo_owner}/{repo_name}.git"
    else:
        url = f"https://github.com/{repo_owner}/{repo_name}.git"

    try:
        result = subprocess.run(
            ["git", "ls-remote", url, f"refs/heads/{branch}"],
            capture_output=True,
            text=True,
            timeout=30,
        )
        if result.returncode != 0:
            stderr = result.stderr[:200]
            if clone_token:
                stderr = stderr.replace(clone_token, "***")
            log.warn(
                "scheduler.ls_remote_failed",
                repo_owner=repo_owner,
                repo_name=repo_name,
                branch=branch,
                stderr=stderr,
            )
            return None

        # Output format: "sha\trefs/heads/branch"
        output = result.stdout.strip()
        if not output:
            return None
        return output.split("\t")[0]
    except Exception as e:
        log.warn(
            "scheduler.ls_remote_error",
            repo_owner=repo_owner,
            repo_name=repo_name,
            error=str(e),
        )
        return None


def _should_rebuild(
    repo_owner: str,
    repo_name: str,
    remote_sha: str,
    all_images: list[dict],
) -> bool:
    """
    Determine if a repo needs a rebuild based on current image status.

    Returns True if a build should be triggered.
    """
    owner_lower = repo_owner.lower()
    name_lower = repo_name.lower()

    # Find images for this repo
    repo_images = [
        img
        for img in all_images
        if img.get("repo_owner", "").lower() == owner_lower
        and img.get("repo_name", "").lower() == name_lower
    ]

    # Check if there's already a build in progress
    building = [img for img in repo_images if img.get("status") == "building"]
    if building:
        log.info(
            "scheduler.skip_building",
            repo_owner=repo_owner,
            repo_name=repo_name,
            building_count=len(building),
        )
        return False

    # Find latest ready image
    ready = [img for img in repo_images if img.get("status") == "ready"]
    if not ready:
        # No ready image — always rebuild
        log.info(
            "scheduler.no_ready_image",
            repo_owner=repo_owner,
            repo_name=repo_name,
        )
        return True

    # Compare SHA
    latest_ready = ready[0]  # getAllStatus returns ordered by created_at DESC
    if latest_ready.get("base_sha") != remote_sha:
        log.info(
            "scheduler.sha_mismatch",
            repo_owner=repo_owner,
            repo_name=repo_name,
            ready_sha=latest_ready.get("base_sha", "")[:12],
            remote_sha=remote_sha[:12],
        )
        return True

    return False


@app.function(
    image=function_image,
    schedule=modal.Cron("*/30 * * * *"),
    secrets=[internal_api_secret, github_app_secrets],
    timeout=300,  # 5 min — scheduler itself is fast, builds run async
)
async def rebuild_repo_images():
    """
    Every 30 minutes:
    1. Fetch list of repos with image building enabled from control plane
    2. Fetch current image status for all repos
    3. For each enabled repo, check remote HEAD SHA via git ls-remote
    4. If SHA differs from latest ready image, trigger a build
    5. Mark stale builds as failed
    6. Clean up old failed D1 rows
    """
    control_plane_url = os.environ.get("CONTROL_PLANE_URL", "")
    if not control_plane_url:
        log.error("scheduler.no_control_plane_url")
        return

    log.info("scheduler.start")
    start_time = time.time()
    builds_triggered = 0

    try:
        # 1. Get enabled repos
        enabled_data = await _api_get(f"{control_plane_url}/repo-images/enabled-repos")
        enabled_repos: list[dict] = enabled_data.get("repos", [])

        if not enabled_repos:
            log.info("scheduler.no_enabled_repos")
            return

        # 2. Get current image status (all repos)
        status_data = await _api_get(f"{control_plane_url}/repo-images/status")
        all_images: list[dict] = status_data.get("images", [])

        # 3. Generate GitHub App token for ls-remote
        clone_token = _generate_clone_token()

        # 4. Check each enabled repo
        for repo in enabled_repos:
            repo_owner = repo.get("repoOwner", "")
            repo_name = repo.get("repoName", "")

            if not repo_owner or not repo_name:
                continue

            remote_sha = _git_ls_remote_sha(repo_owner, repo_name, "main", clone_token)
            if not remote_sha:
                continue

            if _should_rebuild(repo_owner, repo_name, remote_sha, all_images):
                try:
                    await _api_post(
                        f"{control_plane_url}/repo-images/trigger/{repo_owner}/{repo_name}",
                    )
                    builds_triggered += 1
                    log.info(
                        "scheduler.build_triggered",
                        repo_owner=repo_owner,
                        repo_name=repo_name,
                    )
                except Exception as e:
                    log.error(
                        "scheduler.trigger_error",
                        repo_owner=repo_owner,
                        repo_name=repo_name,
                        error=str(e),
                    )

        # 5. Mark stale builds as failed
        try:
            result = await _api_post(
                f"{control_plane_url}/repo-images/mark-stale",
                {"max_age_seconds": STALE_BUILD_THRESHOLD_SECONDS},
            )
            stale_count = result.get("markedFailed", 0)
            if stale_count:
                log.info("scheduler.stale_marked", count=stale_count)
        except Exception as e:
            log.warn("scheduler.mark_stale_error", error=str(e))

        # 6. Clean up old failed builds
        try:
            result = await _api_post(
                f"{control_plane_url}/repo-images/cleanup",
                {"max_age_seconds": FAILED_BUILD_CLEANUP_SECONDS},
            )
            deleted = result.get("deleted", 0)
            if deleted:
                log.info("scheduler.cleanup", deleted=deleted)
        except Exception as e:
            log.warn("scheduler.cleanup_error", error=str(e))

    except Exception as e:
        log.error("scheduler.error", error=str(e))

    duration_s = round(time.time() - start_time, 1)
    log.info(
        "scheduler.done",
        builds_triggered=builds_triggered,
        duration_s=duration_s,
    )
