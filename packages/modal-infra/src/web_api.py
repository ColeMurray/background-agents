"""
Web API endpoints for Open-Inspect Modal functions.

These endpoints expose Modal functions as HTTP APIs that can be called
from the control plane (Cloudflare Workers).

Note: These endpoints call the underlying Python logic directly rather than
using .remote() to avoid nested Modal function calls.

SECURITY: All sensitive endpoints require authentication via HMAC-signed tokens.
The control plane must include an Authorization header with a valid token.
"""

import time

from fastapi import Header, HTTPException
from modal import fastapi_endpoint

from .app import (
    app,
    function_image,
    inspect_volume,
    internal_api_secret,
    validate_control_plane_url,
)
from .auth.internal import AuthConfigurationError, verify_internal_token
from .log_config import configure_logging, get_logger

configure_logging()
log = get_logger("web_api")


def require_auth(authorization: str | None) -> None:
    """
    Verify authentication, raising HTTPException on failure.

    Args:
        authorization: The Authorization header value

    Raises:
        HTTPException: 401 if authentication fails, 503 if auth is misconfigured
    """
    try:
        if not verify_internal_token(authorization):
            raise HTTPException(
                status_code=401,
                detail="Unauthorized: Invalid or missing authentication token",
            )
    except AuthConfigurationError as e:
        # Auth system is misconfigured - this is a server error, not client error
        raise HTTPException(
            status_code=503,
            detail=f"Service unavailable: Authentication not configured. {e}",
        )


def require_valid_control_plane_url(url: str | None) -> None:
    """
    Validate control_plane_url, raising HTTPException on failure.

    Args:
        url: The control plane URL to validate

    Raises:
        HTTPException: 400 if URL is invalid
    """
    if url and not validate_control_plane_url(url):
        raise HTTPException(
            status_code=400,
            detail=f"Invalid control_plane_url: {url}. URL must match allowed patterns.",
        )


def begin_authenticated_request(
    authorization: str | None,
    control_plane_url: str | None = None,
) -> float:
    require_auth(authorization)
    if control_plane_url is not None:
        require_valid_control_plane_url(control_plane_url)
    return time.time()


def log_http_request(
    start_time: float,
    http_method: str,
    http_path: str,
    http_status: int,
    outcome: str,
    endpoint_name: str,
    trace_id: str | None = None,
    request_id: str | None = None,
    session_id: str | None = None,
    sandbox_id: str | None = None,
) -> None:
    duration_ms = int((time.time() - start_time) * 1000)
    log.info(
        "modal.http_request",
        http_method=http_method,
        http_path=http_path,
        http_status=http_status,
        duration_ms=duration_ms,
        outcome=outcome,
        endpoint_name=endpoint_name,
        trace_id=trace_id,
        request_id=request_id,
        session_id=session_id,
        sandbox_id=sandbox_id,
    )


@app.function(
    image=function_image,
    volumes={"/data": inspect_volume},
    secrets=[internal_api_secret],
)
@fastapi_endpoint(method="POST")
async def api_create_sandbox(
    request: dict,
    authorization: str | None = Header(None),
    x_trace_id: str | None = Header(None),
    x_request_id: str | None = Header(None),
    x_session_id: str | None = Header(None),
    x_sandbox_id: str | None = Header(None),
) -> dict:
    """
    HTTP endpoint to create a sandbox.

    Requires authentication via Authorization header.

    POST body:
    {
        "session_id": "...",
        "sandbox_id": "...",  // Optional: expected sandbox ID from control plane
        "repo_owner": "...",
        "repo_name": "...",
        "control_plane_url": "...",
        "sandbox_auth_token": "...",
        "snapshot_id": null,
        "provider": "anthropic",
        "model": "claude-sonnet-4-6"
    }
    """
    control_plane_url = request.get("control_plane_url")
    start_time = begin_authenticated_request(authorization, control_plane_url)
    http_status = 200
    outcome = "success"

    try:
        # Import types and manager directly
        from .sandbox.manager import SandboxConfig, SandboxManager
        from .sandbox.types import SessionConfig

        manager = SandboxManager()

        session_config = SessionConfig(
            session_id=request.get("session_id"),
            repo_owner=request.get("repo_owner"),
            repo_name=request.get("repo_name"),
            branch=request.get("branch"),
            opencode_session_id=request.get("opencode_session_id"),
            provider=request.get("provider", "anthropic"),
            model=request.get("model", "claude-sonnet-4-6"),
        )

        config = SandboxConfig(
            repo_owner=request.get("repo_owner"),
            repo_name=request.get("repo_name"),
            sandbox_id=request.get("sandbox_id"),  # Use control-plane-provided ID for auth
            snapshot_id=request.get("snapshot_id"),
            session_config=session_config,
            control_plane_url=control_plane_url,
            sandbox_auth_token=request.get("sandbox_auth_token"),
            clone_token=request.get("clone_token"),
            user_env_vars=request.get("user_env_vars") or None,
            repo_image_id=request.get("repo_image_id") or None,
            repo_image_sha=request.get("repo_image_sha") or None,
        )

        handle = await manager.create_sandbox(config)

        return {
            "success": True,
            "data": {
                "sandbox_id": handle.sandbox_id,
                "modal_object_id": handle.modal_object_id,  # Modal's internal ID for snapshot API
                "status": handle.status.value,
                "created_at": handle.created_at,
            },
        }
    except Exception as e:
        outcome = "error"
        http_status = 500
        log.error("api.error", exc=e, endpoint_name="api_create_sandbox")
        return {"success": False, "error": str(e)}
    finally:
        log_http_request(
            start_time=start_time,
            http_method="POST",
            http_path="/api_create_sandbox",
            http_status=http_status,
            outcome=outcome,
            endpoint_name="api_create_sandbox",
            trace_id=x_trace_id,
            request_id=x_request_id,
            session_id=x_session_id,
            sandbox_id=x_sandbox_id,
        )


@app.function(
    image=function_image,
    volumes={"/data": inspect_volume},
    secrets=[internal_api_secret],
)
@fastapi_endpoint(method="POST")
async def api_warm_sandbox(
    request: dict,
    authorization: str | None = Header(None),
    x_trace_id: str | None = Header(None),
    x_request_id: str | None = Header(None),
    x_session_id: str | None = Header(None),
    x_sandbox_id: str | None = Header(None),
) -> dict:
    """
    HTTP endpoint to warm a sandbox.

    Requires authentication via Authorization header.

    POST body:
    {
        "repo_owner": "...",
        "repo_name": "...",
        "control_plane_url": "..."
    }
    """
    control_plane_url = request.get("control_plane_url", "")
    start_time = begin_authenticated_request(authorization, control_plane_url)
    http_status = 200
    outcome = "success"

    try:
        from .sandbox.manager import SandboxManager

        manager = SandboxManager()
        handle = await manager.warm_sandbox(
            repo_owner=request.get("repo_owner"),
            repo_name=request.get("repo_name"),
            control_plane_url=control_plane_url,
        )

        return {
            "success": True,
            "data": {
                "sandbox_id": handle.sandbox_id,
                "status": handle.status.value,
            },
        }
    except Exception as e:
        outcome = "error"
        http_status = 500
        log.error("api.error", exc=e, endpoint_name="api_warm_sandbox")
        return {"success": False, "error": str(e)}
    finally:
        log_http_request(
            start_time=start_time,
            http_method="POST",
            http_path="/api_warm_sandbox",
            http_status=http_status,
            outcome=outcome,
            endpoint_name="api_warm_sandbox",
            trace_id=x_trace_id,
            request_id=x_request_id,
            session_id=x_session_id,
            sandbox_id=x_sandbox_id,
        )


@app.function(image=function_image)
@fastapi_endpoint(method="GET")
def api_health() -> dict:
    """Health check endpoint. Does not require authentication."""
    return {"success": True, "data": {"status": "healthy", "service": "open-inspect-modal"}}


@app.function(
    image=function_image,
    volumes={"/data": inspect_volume},
    secrets=[internal_api_secret],
)
@fastapi_endpoint(method="GET")
def api_snapshot(
    repo_owner: str,
    repo_name: str,
    authorization: str | None = Header(None),
    x_trace_id: str | None = Header(None),
    x_request_id: str | None = Header(None),
    x_session_id: str | None = Header(None),
    x_sandbox_id: str | None = Header(None),
) -> dict:
    """
    Get latest snapshot for a repository.

    Requires authentication via Authorization header.

    Query params: ?repo_owner=...&repo_name=...
    """
    start_time = begin_authenticated_request(authorization)
    http_status = 200
    outcome = "success"

    try:
        from .registry.store import SnapshotStore

        store = SnapshotStore()
        snapshot = store.get_latest_snapshot(repo_owner, repo_name)

        if snapshot:
            return {"success": True, "data": snapshot.model_dump()}
        return {"success": True, "data": None}
    except Exception as e:
        outcome = "error"
        http_status = 500
        log.error("api.error", exc=e, endpoint_name="api_snapshot")
        return {"success": False, "error": str(e)}
    finally:
        log_http_request(
            start_time=start_time,
            http_method="GET",
            http_path="/api_snapshot",
            http_status=http_status,
            outcome=outcome,
            endpoint_name="api_snapshot",
            trace_id=x_trace_id,
            request_id=x_request_id,
            session_id=x_session_id,
            sandbox_id=x_sandbox_id,
        )


@app.function(image=function_image, secrets=[internal_api_secret])
@fastapi_endpoint(method="POST")
async def api_snapshot_sandbox(
    request: dict,
    authorization: str | None = Header(None),
    x_trace_id: str | None = Header(None),
    x_request_id: str | None = Header(None),
    x_session_id: str | None = Header(None),
    x_sandbox_id: str | None = Header(None),
) -> dict:
    """
    Take a filesystem snapshot of a running sandbox using Modal's native API.

    Requires authentication via Authorization header.

    This creates a point-in-time copy of the sandbox's filesystem that can be
    used to restore the sandbox later. The snapshot is stored as a Modal Image
    and persists indefinitely.

    POST body:
    {
        "sandbox_id": "...",
        "session_id": "...",
        "reason": "execution_complete" | "pre_timeout" | "heartbeat_timeout"
    }

    Returns:
    {
        "success": true,
        "data": {
            "image_id": "...",
            "sandbox_id": "...",
            "session_id": "...",
            "reason": "..."
        }
    }
    """
    start_time = begin_authenticated_request(authorization)
    http_status = 200
    outcome = "success"

    sandbox_id = request.get("sandbox_id")
    if not sandbox_id:
        raise HTTPException(status_code=400, detail="sandbox_id is required")

    try:
        from .sandbox.manager import SandboxManager

        session_id = request.get("session_id")
        reason = request.get("reason", "manual")

        manager = SandboxManager()

        # Get the sandbox handle by ID
        handle = await manager.get_sandbox_by_id(sandbox_id)
        if not handle:
            raise HTTPException(status_code=404, detail=f"Sandbox not found: {sandbox_id}")

        # Take filesystem snapshot using Modal's native API (sync method)
        image_id = manager.take_snapshot(handle)

        return {
            "success": True,
            "data": {
                "image_id": image_id,
                "sandbox_id": sandbox_id,
                "session_id": session_id,
                "reason": reason,
            },
        }
    except HTTPException as e:
        outcome = "error"
        http_status = e.status_code
        raise
    except Exception as e:
        outcome = "error"
        http_status = 500
        log.error("api.error", exc=e, endpoint_name="api_snapshot_sandbox")
        return {"success": False, "error": str(e)}
    finally:
        log_http_request(
            start_time=start_time,
            http_method="POST",
            http_path="/api_snapshot_sandbox",
            http_status=http_status,
            outcome=outcome,
            endpoint_name="api_snapshot_sandbox",
            trace_id=x_trace_id,
            request_id=x_request_id,
            session_id=x_session_id,
            sandbox_id=x_sandbox_id or sandbox_id,
        )


@app.function(image=function_image, secrets=[internal_api_secret])
@fastapi_endpoint(method="POST")
async def api_restore_sandbox(
    request: dict,
    authorization: str | None = Header(None),
    x_trace_id: str | None = Header(None),
    x_request_id: str | None = Header(None),
    x_session_id: str | None = Header(None),
    x_sandbox_id: str | None = Header(None),
) -> dict:
    """
    Create a new sandbox from a filesystem snapshot.

    Requires authentication via Authorization header.

    This restores a sandbox from a previously taken snapshot Image,
    allowing the session to resume with full workspace state intact.
    Git clone is skipped since the workspace already contains all changes.

    POST body:
    {
        "snapshot_image_id": "...",
        "session_config": {
            "session_id": "...",
            "repo_owner": "...",
            "repo_name": "...",
            "provider": "anthropic",
            "model": "claude-sonnet-4-6"
        },
        "sandbox_id": "...",
        "control_plane_url": "...",
        "sandbox_auth_token": "..."
    }

    Returns:
    {
        "success": true,
        "data": {
            "sandbox_id": "...",
            "status": "warming"
        }
    }
    """
    control_plane_url = request.get("control_plane_url", "")
    start_time = begin_authenticated_request(authorization, control_plane_url)
    http_status = 200
    outcome = "success"

    snapshot_image_id = request.get("snapshot_image_id")
    if not snapshot_image_id:
        raise HTTPException(status_code=400, detail="snapshot_image_id is required")

    try:
        from .sandbox.manager import DEFAULT_SANDBOX_TIMEOUT_SECONDS, SandboxManager

        session_config = request.get("session_config", {})
        sandbox_id = request.get("sandbox_id")
        sandbox_auth_token = request.get("sandbox_auth_token", "")
        user_env_vars = request.get("user_env_vars") or None
        timeout_seconds = int(request.get("timeout_seconds", DEFAULT_SANDBOX_TIMEOUT_SECONDS))

        manager = SandboxManager()

        # Restore sandbox from snapshot
        handle = await manager.restore_from_snapshot(
            snapshot_image_id=snapshot_image_id,
            session_config=session_config,
            sandbox_id=sandbox_id,
            control_plane_url=control_plane_url,
            sandbox_auth_token=sandbox_auth_token,
            clone_token=request.get("clone_token"),
            user_env_vars=user_env_vars,
            timeout_seconds=timeout_seconds,
        )

        return {
            "success": True,
            "data": {
                "sandbox_id": handle.sandbox_id,
                "modal_object_id": handle.modal_object_id,
                "status": handle.status.value,
            },
        }
    except HTTPException as e:
        outcome = "error"
        http_status = e.status_code
        raise
    except Exception as e:
        outcome = "error"
        http_status = 500
        log.error("api.error", exc=e, endpoint_name="api_restore_sandbox")
        return {"success": False, "error": str(e)}
    finally:
        log_http_request(
            start_time=start_time,
            http_method="POST",
            http_path="/api_restore_sandbox",
            http_status=http_status,
            outcome=outcome,
            endpoint_name="api_restore_sandbox",
            trace_id=x_trace_id,
            request_id=x_request_id,
            session_id=x_session_id,
            sandbox_id=x_sandbox_id,
        )


@app.function(
    image=function_image,
    secrets=[internal_api_secret],
)
@fastapi_endpoint(method="POST")
async def api_build_repo_image(
    request: dict,
    authorization: str | None = Header(None),
    x_trace_id: str | None = Header(None),
    x_request_id: str | None = Header(None),
) -> dict:
    """
    Kick off an async image build. Returns immediately.

    Spawns a build_repo_image async worker that will:
    1. Create a build sandbox
    2. Wait for it to finish (git clone + setup)
    3. Snapshot the filesystem
    4. POST the result to callback_url

    POST body:
    {
        "repo_owner": "...",
        "repo_name": "...",
        "default_branch": "main",
        "build_id": "...",
        "callback_url": "..."
    }
    """
    start_time = begin_authenticated_request(authorization)
    http_status = 200
    outcome = "success"

    try:
        from .scheduler.image_builder import build_repo_image

        repo_owner = request.get("repo_owner")
        repo_name = request.get("repo_name")
        default_branch = request.get("default_branch", "main")
        build_id = request.get("build_id", "")
        callback_url = request.get("callback_url", "")
        user_env_vars = request.get("user_env_vars") or None
        clone_token = request.get("clone_token") or ""

        if not repo_owner or not repo_name:
            raise HTTPException(status_code=400, detail="repo_owner and repo_name are required")

        if not build_id:
            raise HTTPException(status_code=400, detail="build_id is required")

        # Spawn the async builder — returns immediately
        await build_repo_image.spawn.aio(
            repo_owner=repo_owner,
            repo_name=repo_name,
            default_branch=default_branch,
            callback_url=callback_url,
            build_id=build_id,
            user_env_vars=user_env_vars,
            clone_token=clone_token,
        )

        return {
            "success": True,
            "data": {
                "build_id": build_id,
                "status": "building",
            },
        }
    except HTTPException as e:
        outcome = "error"
        http_status = e.status_code
        raise
    except Exception as e:
        outcome = "error"
        http_status = 500
        log.error("api.error", exc=e, endpoint_name="api_build_repo_image")
        return {"success": False, "error": str(e)}
    finally:
        log_http_request(
            start_time=start_time,
            http_method="POST",
            http_path="/api_build_repo_image",
            http_status=http_status,
            outcome=outcome,
            endpoint_name="api_build_repo_image",
            trace_id=x_trace_id,
            request_id=x_request_id,
        )


@app.function(
    image=function_image,
    secrets=[internal_api_secret],
)
@fastapi_endpoint(method="POST")
async def api_delete_provider_image(
    request: dict,
    authorization: str | None = Header(None),
    x_trace_id: str | None = Header(None),
    x_request_id: str | None = Header(None),
) -> dict:
    """
    Delete a single provider image (best-effort).

    Used to clean up old pre-built images after they're replaced by newer builds.

    POST body:
    {
        "provider_image_id": "..."
    }
    """
    start_time = begin_authenticated_request(authorization)
    http_status = 200
    outcome = "success"

    provider_image_id = request.get("provider_image_id")
    if not provider_image_id:
        raise HTTPException(status_code=400, detail="provider_image_id is required")

    try:
        # Modal doesn't have an explicit delete API for images;
        # images are garbage-collected when no longer referenced.
        # We log the request for auditability.
        log.info(
            "image.delete_requested",
            provider_image_id=provider_image_id,
        )

        return {
            "success": True,
            "data": {
                "provider_image_id": provider_image_id,
                "deleted": True,
            },
        }
    except HTTPException as e:
        outcome = "error"
        http_status = e.status_code
        raise
    except Exception as e:
        outcome = "error"
        http_status = 500
        log.error("api.error", exc=e, endpoint_name="api_delete_provider_image")
        return {"success": False, "error": str(e)}
    finally:
        log_http_request(
            start_time=start_time,
            http_method="POST",
            http_path="/api_delete_provider_image",
            http_status=http_status,
            outcome=outcome,
            endpoint_name="api_delete_provider_image",
            trace_id=x_trace_id,
            request_id=x_request_id,
        )
