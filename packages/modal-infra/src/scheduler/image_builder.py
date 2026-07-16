"""
Async image builder and scheduler for pre-built scope images.

An image build bakes a provider image for a *scope* — a single repository or
an environment (an ordered repository set). This module handles:
- Building scope images asynchronously (triggered by control plane)
- Creating build sandboxes, awaiting exit, snapshotting filesystem
- Reporting results back to control plane via authenticated callbacks
- Scheduled rebuilds every 30 minutes (cron) with git ls-remote comparison

The build flow:
1. Control plane POSTs to api_build_image with the repository set + callback URL
2. api_build_image spawns build_image.spawn() and returns immediately
3. build_image creates a build sandbox, waits for it to finish, snapshots
4. On success/failure, POSTs result to the callback URL with HMAC auth

The scheduler flow:
1. Every 30 min, fetch enabled scope units and current image status from
   control plane
2. Evaluate the rebuild triggers per unit (fingerprint, runtime floor,
   per-repository git ls-remote drift)
3. Trigger builds for units that need one (capped per tick)
4. Mark stale builds as failed, clean up old failed rows
"""

import asyncio
import json
import os
import re
import subprocess
import time
from collections.abc import Iterable
from dataclasses import dataclass, field
from urllib.parse import quote

import httpx
import modal

from ..app import (
    app,
    function_image,
    github_app_secrets,
    internal_api_secret,
    validate_control_plane_url,
)
from ..auth import generate_internal_token
from ..clone_token import resolve_clone_token
from ..log_config import get_logger
from ..sandbox.manager import (
    DEFAULT_BUILD_TIMEOUT_SECONDS,
    MAX_BUILD_TIMEOUT_SECONDS,
    build_function_timeout_seconds,
)

log = get_logger("image_builder")

# Retry config for callbacks
CALLBACK_MAX_RETRIES = 3
CALLBACK_BACKOFF_BASE = 2  # seconds: 2, 4, 8

# Build log errors are surfaced through callbacks; keep them concise.
BUILD_FAILURE_MESSAGE_MAX_CHARS = 500

_SETUP_FAILURE_EVENTS = {"setup.failed", "setup.timeout", "setup.error"}
_SUPERVISOR_FAILURE_EVENTS = {"supervisor.error", "supervisor.fatal"}


class BuildError(Exception):
    """Raised when a build sandbox fails."""

    pass


def _format_build_failure_event(entry: dict, redact_values: Iterable[str] = ()) -> str | None:
    """Return a concise build failure message from a structured log entry."""
    event = entry.get("event")
    if not isinstance(event, str):
        return None
    if event not in _SETUP_FAILURE_EVENTS | _SUPERVISOR_FAILURE_EVENTS:
        return None

    if event in {"setup.failed", "setup.timeout"}:
        raw_message = entry.get("output_tail")
    else:
        raw_message = entry.get("error_message") or entry.get("error")

    message = raw_message.strip() if isinstance(raw_message, str) else ""
    for redact_value in sorted({value for value in redact_values if value}, key=len, reverse=True):
        message = message.replace(redact_value, "***")

    if event in {"setup.failed", "setup.timeout"}:
        if not message and entry.get("exit_code") is not None:
            message = f"exit_code={entry['exit_code']}"

    if not message:
        return event
    return f"{event}: {message[-BUILD_FAILURE_MESSAGE_MAX_CHARS:]}"


async def _terminate_build_sandbox(handle, build_id: str, reason: str) -> bool:
    """Terminate a build sandbox, logging but not failing the build on cleanup errors."""
    try:
        await handle.modal_sandbox.terminate.aio()
        log.info("image_build.sandbox_terminated", build_id=build_id, reason=reason)
        return True
    except Exception as e:
        log.warn(
            "image_build.sandbox_terminate_failed",
            build_id=build_id,
            reason=reason,
            error=str(e),
        )
        return False


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


@dataclass
class BuildLogResult:
    """What the build runtime reported through its structured log stream."""

    head_sha: str = ""
    repository_shas: list[dict] = field(default_factory=list)
    runtime_version: str = ""
    complete: bool = False
    error: str | None = None


async def _stream_build_logs(sandbox, redact_values: Iterable[str] = ()) -> BuildLogResult:
    """
    Stream sandbox stdout and extract build results.

    The entrypoint logs structured JSON lines. We look for:
    - event="git.sync_complete" with "head_sha" (single-repo) and "repository_shas"
      (per-repository provenance, [{repoOwner, repoName, baseSha}])
    - event="image_build.complete" with "runtime_version" to know the build
      finished and which runtime it baked
    - setup/supervisor errors to preserve the actual build failure

    The sandbox stays alive after logging image_build.complete (it awaits
    shutdown_event), so we can snapshot_filesystem() while it's still running.
    """
    result = BuildLogResult()
    setup_error: str | None = None
    supervisor_error: str | None = None
    redact_values = tuple(redact_values)
    try:
        async for line in sandbox.stdout:
            try:
                entry = json.loads(line)
                if not isinstance(entry, dict):
                    continue
                event = entry.get("event")
                if not isinstance(event, str):
                    continue
                if event == "git.sync_complete":
                    if entry.get("head_sha"):
                        result.head_sha = entry["head_sha"]
                    if isinstance(entry.get("repository_shas"), list):
                        result.repository_shas = entry["repository_shas"]
                elif event == "image_build.complete":
                    if isinstance(entry.get("runtime_version"), str):
                        result.runtime_version = entry["runtime_version"]
                    result.complete = True
                    return result

                failure_message = _format_build_failure_event(entry, redact_values)
                if failure_message and event in _SETUP_FAILURE_EVENTS and setup_error is None:
                    setup_error = failure_message
                elif failure_message and supervisor_error is None:
                    supervisor_error = failure_message
            except json.JSONDecodeError:
                continue
    except Exception as e:
        log.warn("image_build.stream_error", error=str(e))
    result.error = setup_error or supervisor_error
    return result


@app.function(
    image=function_image,
    secrets=[internal_api_secret, github_app_secrets],
    timeout=build_function_timeout_seconds(DEFAULT_BUILD_TIMEOUT_SECONDS),
)
async def build_image(
    scope_kind: str,
    scope_id: str,
    repositories: list[dict],
    callback_url: str = "",
    failure_callback_url: str = "",
    build_id: str = "",
    user_env_vars: dict[str, str] | None = None,
    build_timeout_seconds: int | None = None,
) -> None:
    """
    Async worker: build a scope image (design §4).

    One worker for every scope kind: the build sandbox gets
    SESSION_CONFIG.repositories and the list-native runtime clones every
    repository and runs each repo's setup.sh sequentially, fatally. Repo
    scopes send their one-element repository set. The success callback
    carries what only the build knows — per-repository clone provenance
    (repository_shas) and the baked runtime_version — while the repositories
    fingerprint stays control-plane-side on the registered row.

    Args:
        scope_kind: "repo" | "environment" — logging only
        scope_id: lowercase "owner/name" or environment id — logging only
        repositories: SessionRepositoryConfig list ([{repo_owner, repo_name,
            branch}], position order, [0] = primary)
        callback_url: URL to POST success result to
        failure_callback_url: URL to POST failure result to. Sent explicitly by
            the control plane (mirrors client.ts buildImage) so the failure
            route is never derived from callback_url's path.
        build_id: Build identifier from the control plane
        user_env_vars: Build secrets (merged by the control plane) injected
            into the build sandbox
        build_timeout_seconds: Build sandbox lifetime (already clamped by the
            control plane). None → DEFAULT_BUILD_TIMEOUT_SECONDS.
    """
    from ..sandbox.manager import SNAPSHOT_FILESYSTEM_TIMEOUT_SECONDS, SandboxManager

    sandbox_timeout_seconds = build_timeout_seconds or DEFAULT_BUILD_TIMEOUT_SECONDS

    # Validate both callback URLs against allowed hosts to prevent SSRF.
    for url in (callback_url, failure_callback_url):
        if url and not validate_control_plane_url(url):
            log.error(
                "image_build.invalid_callback_url",
                url=url,
                build_id=build_id,
                scope_kind=scope_kind,
                scope_id=scope_id,
            )
            return

    start_time = time.time()
    manager = SandboxManager()
    handle = None
    sandbox_terminated = False

    try:
        if not repositories:
            raise BuildError("image build requires at least one repository")
        primary = repositories[0]

        clone_token = resolve_clone_token() or ""

        handle = await manager.create_build_sandbox(
            repo_owner=primary.get("repo_owner", ""),
            repo_name=primary.get("repo_name", ""),
            # Validated non-empty by the api_build_image endpoint; no silent
            # default — a missing branch must fail loudly, not build "main".
            default_branch=primary["branch"],
            clone_token=clone_token,
            user_env_vars=user_env_vars,
            timeout_seconds=sandbox_timeout_seconds,
            repositories=repositories,
        )

        # Stream stdout until the build completes. Redaction covers the clone
        # token and every build secret value so neither reaches the failure
        # message, the callback payload, or D1.
        redact_values = (clone_token, *((user_env_vars or {}).values()))
        build_logs = await _stream_build_logs(
            handle.modal_sandbox,
            redact_values=redact_values,
        )
        if not build_logs.complete:
            exit_code = handle.modal_sandbox.returncode
            if build_logs.error:
                raise BuildError(f"Build sandbox exited without completing: {build_logs.error}")
            raise BuildError(f"Build sandbox exited without completing (exit_code={exit_code})")

        # Registration fails closed on these — surface the real cause here
        # instead of an opaque callback rejection. Missing fields mean the
        # base image bakes a runtime too old for image builds.
        if not build_logs.repository_shas or not build_logs.runtime_version:
            raise BuildError(
                "build completed without repository_shas/runtime_version — "
                "base image runtime predates list-native image builds"
            )

        # Snapshot the running sandbox's filesystem
        image = await handle.modal_sandbox.snapshot_filesystem.aio(
            timeout=SNAPSHOT_FILESYSTEM_TIMEOUT_SECONDS
        )
        provider_image_id = image.object_id

        sandbox_terminated = await _terminate_build_sandbox(handle, build_id, "snapshot_complete")

        build_duration = time.time() - start_time

        log.info(
            "image_build.complete",
            build_id=build_id,
            scope_kind=scope_kind,
            scope_id=scope_id,
            outcome="success",
            duration_seconds=round(build_duration, 3),
            repository_count=len(repositories),
            provider_image_id=provider_image_id,
            runtime_version=build_logs.runtime_version,
        )

        if callback_url:
            await _callback_with_retry(
                callback_url,
                {
                    "build_id": build_id,
                    "provider_image_id": provider_image_id,
                    "repository_shas": build_logs.repository_shas,
                    "runtime_version": build_logs.runtime_version,
                    "build_duration_seconds": round(build_duration, 2),
                },
            )

    except Exception as e:
        build_duration = time.time() - start_time
        if handle is not None and not sandbox_terminated:
            sandbox_terminated = await _terminate_build_sandbox(handle, build_id, "build_failed")

        log.error(
            "image_build.complete",
            build_id=build_id,
            scope_kind=scope_kind,
            scope_id=scope_id,
            outcome="error",
            error=str(e),
            duration_seconds=round(build_duration, 3),
            repository_count=len(repositories),
        )

        if failure_callback_url:
            await _callback_with_retry(
                failure_callback_url,
                {
                    "build_id": build_id,
                    "error": str(e),
                },
            )
    finally:
        if handle is not None and not sandbox_terminated:
            await _terminate_build_sandbox(handle, build_id, "cleanup")


# ---------------------------------------------------------------------------
# Scheduler: cron-based rebuild logic
# ---------------------------------------------------------------------------

# Sized at the longest possible build's worker timeout so a long-but-live build isn't reaped.
STALE_BUILD_THRESHOLD_SECONDS = build_function_timeout_seconds(MAX_BUILD_TIMEOUT_SECONDS)

# Cleanup threshold: failed builds older than this are deleted
FAILED_BUILD_CLEANUP_SECONDS = 86400  # 24 hours

# Builds triggered per tick across ALL units, at most — cheap storm insurance
# since there is no global build-concurrency cap; the next tick picks up the
# rest. Sized so a runtime-floor bump (which queues every enabled unit) drains
# in bounded time while sessions fall back to base images (design §4).
TRIGGER_CAP_PER_TICK = 8


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
    ref: str,
    clone_token: str,
) -> str | None:
    """
    Run git ls-remote to get the SHA a ref points to.

    Pass "HEAD" to follow the remote's default branch, or "refs/heads/<name>"
    for a specific branch.

    Returns the SHA string, or None on failure.
    """
    if clone_token:
        url = f"https://x-access-token:{clone_token}@github.com/{repo_owner}/{repo_name}.git"
    else:
        url = f"https://github.com/{repo_owner}/{repo_name}.git"

    try:
        result = subprocess.run(
            ["git", "ls-remote", url, ref],
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
                ref=ref,
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


def _parse_runtime_version_number(runtime_version: str) -> int | None:
    """Numeric prefix of a SANDBOX_VERSION ("v54-opencode" → 54), or None."""
    match = re.match(r"^v(\d+)", runtime_version)
    return int(match.group(1)) if match else None


def _should_rebuild_unit(
    unit: dict,
    all_images: list[dict],
    min_runtime_version: int | None,
    clone_token: str,
) -> bool:
    """
    Rebuild triggers for one enabled scope unit ({scopeKind, scopeId,
    repositoriesFingerprint, repositories[]}, design §4), cheapest first:

    1. no ready image matches the unit's current repositories fingerprint
       (covers created/edited scopes and failed builds);
    3. the matching ready image's runtime_version is below the compatibility
       floor, or unparseable (fail closed);
    2. any repository's remote branch tip drifted from the image's recorded
       repository_shas (needs one ls-remote per repository, so it runs last).

    Trigger 4 (provider-side snapshot expiry) is inert on modal 1.4.3 —
    snapshots do not expire there; it activates with the snapshot-TTL
    follow-up.
    """
    scope_kind = unit.get("scopeKind", "")
    scope_id = unit.get("scopeId", "")
    fingerprint = unit.get("repositoriesFingerprint", "")

    scope_images = [
        img
        for img in all_images
        if img.get("scope_kind") == scope_kind and img.get("scope_id") == scope_id
    ]

    # Per-scope concurrency 1: skip while a build is in flight. The trigger
    # route enforces this too; checking here saves the HTTP call.
    if any(img.get("status") == "building" for img in scope_images):
        log.info("scheduler.skip_building", scope_kind=scope_kind, scope_id=scope_id)
        return False

    matching_ready = [
        img
        for img in scope_images
        if img.get("status") == "ready" and img.get("repositories_fingerprint") == fingerprint
    ]
    if not matching_ready:
        log.info("scheduler.no_ready_image", scope_kind=scope_kind, scope_id=scope_id)
        return True

    latest_ready = matching_ready[0]  # status endpoint orders by created_at DESC

    version = _parse_runtime_version_number(latest_ready.get("runtime_version") or "")
    if min_runtime_version is not None and (version is None or version < min_runtime_version):
        log.info(
            "scheduler.runtime_below_floor",
            scope_kind=scope_kind,
            scope_id=scope_id,
            runtime_version=latest_ready.get("runtime_version"),
            min_runtime_version=min_runtime_version,
        )
        return True

    try:
        recorded_shas = json.loads(latest_ready.get("repository_shas") or "[]")
    except json.JSONDecodeError:
        recorded_shas = None
    if not isinstance(recorded_shas, list):
        log.warn(
            "scheduler.malformed_repository_shas",
            scope_kind=scope_kind,
            scope_id=scope_id,
        )
        return True
    recorded_by_repo = {
        (str(m.get("repoOwner", "")).lower(), str(m.get("repoName", "")).lower()): m.get(
            "baseSha", ""
        )
        for m in recorded_shas
        if isinstance(m, dict)
    }

    for repo in unit.get("repositories", []):
        repo_owner = repo.get("repoOwner", "")
        repo_name = repo.get("repoName", "")
        base_branch = repo.get("baseBranch", "")
        if not repo_owner or not repo_name or not base_branch:
            continue
        remote_sha = _git_ls_remote_sha(
            repo_owner, repo_name, f"refs/heads/{base_branch}", clone_token
        )
        if not remote_sha:
            # Lookup failure is not a drift signal — rebuilding on transient
            # git errors would storm every tick.
            continue
        if recorded_by_repo.get((repo_owner.lower(), repo_name.lower())) != remote_sha:
            log.info(
                "scheduler.sha_mismatch",
                scope_kind=scope_kind,
                scope_id=scope_id,
                repo_owner=repo_owner,
                repo_name=repo_name,
                remote_sha=remote_sha[:12],
            )
            return True

    return False


def _unit_trigger_path(unit: dict) -> str | None:
    """Control-plane trigger path for a unit, or None for a malformed unit."""
    scope_kind = unit.get("scopeKind", "")
    scope_id = unit.get("scopeId", "")
    if scope_kind == "repo":
        repo_owner, separator, repo_name = scope_id.rpartition("/")
        if not separator or not repo_owner or not repo_name:
            return None
        return (
            f"/image-builds/trigger/repo/{quote(repo_owner, safe='')}/{quote(repo_name, safe='')}"
        )
    if scope_kind == "environment" and scope_id:
        return f"/image-builds/trigger/environment/{scope_id}"
    return None


async def _rebuild_images_pass(control_plane_url: str, clone_token: str) -> int:
    """
    The unified rebuild pass (design §4): GET enabled units + cross-scope
    status, evaluate the rebuild triggers per unit, POST triggers (one cap
    across all units per tick), then mark-stale and cleanup.
    """
    enabled_data = await _api_get(f"{control_plane_url}/image-builds/enabled")
    units: list[dict] = enabled_data.get("units", [])
    min_runtime_version = enabled_data.get("minRuntimeVersion")

    builds_triggered = 0
    if units:
        status_data = await _api_get(f"{control_plane_url}/image-builds/status")
        all_images: list[dict] = status_data.get("images", [])

        for unit in units:
            trigger_path = _unit_trigger_path(unit)
            if trigger_path is None:
                continue
            if builds_triggered >= TRIGGER_CAP_PER_TICK:
                log.info("scheduler.trigger_cap_reached", cap=TRIGGER_CAP_PER_TICK)
                break

            if not _should_rebuild_unit(unit, all_images, min_runtime_version, clone_token):
                continue

            try:
                await _api_post(f"{control_plane_url}{trigger_path}")
                builds_triggered += 1
                log.info(
                    "scheduler.build_triggered",
                    scope_kind=unit.get("scopeKind", ""),
                    scope_id=unit.get("scopeId", ""),
                )
            except Exception as e:
                log.error(
                    "scheduler.trigger_error",
                    scope_kind=unit.get("scopeKind", ""),
                    scope_id=unit.get("scopeId", ""),
                    error=str(e),
                )

    try:
        result = await _api_post(
            f"{control_plane_url}/image-builds/mark-stale",
            {"max_age_seconds": STALE_BUILD_THRESHOLD_SECONDS},
        )
        stale_count = result.get("markedFailed", 0)
        if stale_count:
            log.info("scheduler.stale_marked", count=stale_count)
    except Exception as e:
        log.warn("scheduler.mark_stale_error", error=str(e))

    try:
        result = await _api_post(
            f"{control_plane_url}/image-builds/cleanup",
            {"max_age_seconds": FAILED_BUILD_CLEANUP_SECONDS},
        )
        deleted = result.get("deleted", 0)
        reaped = result.get("reapedSuperseded", 0)
        if deleted or reaped:
            log.info("scheduler.cleanup", deleted=deleted, reaped_superseded=reaped)
    except Exception as e:
        log.warn("scheduler.cleanup_error", error=str(e))

    return builds_triggered


@app.function(
    image=function_image,
    schedule=modal.Cron("*/30 * * * *"),
    secrets=[internal_api_secret, github_app_secrets],
    timeout=300,  # 5 min — scheduler itself is fast, builds run async
)
async def rebuild_images():
    """
    Every 30 minutes, run the unified rebuild pass over every prebuild-enabled
    scope unit (repos and environments alike).

    (Renamed from rebuild_repo_images at the Modal cutover: a full
    `modal deploy` replaces the app atomically, so the old scheduled function
    is removed in the same deploy.)
    """
    control_plane_url = os.environ.get("CONTROL_PLANE_URL", "")
    if not control_plane_url:
        log.error("scheduler.no_control_plane_url")
        return

    log.info("scheduler.start")
    start_time = time.time()
    builds_triggered = 0

    try:
        clone_token = resolve_clone_token() or ""
        builds_triggered = await _rebuild_images_pass(control_plane_url, clone_token)
    except Exception as e:
        log.error("scheduler.error", error=str(e))

    duration_s = round(time.time() - start_time, 1)
    log.info(
        "scheduler.done",
        builds_triggered=builds_triggered,
        duration_s=duration_s,
    )
