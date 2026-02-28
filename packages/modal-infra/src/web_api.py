"""
Web API endpoints for Open-Inspect Modal functions.

These endpoints expose Modal functions as HTTP APIs that can be called
from the control plane (Cloudflare Workers).

Note: These endpoints call the underlying Python logic directly rather than
using .remote() to avoid nested Modal function calls.

SECURITY: All sensitive endpoints require authentication via HMAC-signed tokens.
The control plane must include an Authorization header with a valid token.
"""

import os
import time

from fastapi import Header, HTTPException
from fastapi.responses import JSONResponse
from modal import fastapi_endpoint

from .app import (
    app,
    function_image,
    github_app_secrets,
    inspect_volume,
    internal_api_secret,
    validate_control_plane_url,
)
from .auth.internal import AuthConfigurationError, verify_internal_token
from .log_config import configure_logging, get_logger

configure_logging()
log = get_logger("web_api")


def _error_code_for_status(status_code: int) -> str:
    if status_code == 400:
        return "bad_request"
    if status_code == 401:
        return "unauthorized"
    if status_code == 403:
        return "forbidden"
    if status_code == 404:
        return "not_found"
    if status_code == 409:
        return "conflict"
    if status_code == 422:
        return "validation_error"
    if status_code == 429:
        return "rate_limited"
    if status_code == 503:
        return "service_unavailable"
    if status_code >= 500:
        return "internal_error"
    return "request_failed"


def success_response(data: dict | None, status_code: int = 200) -> JSONResponse:
    return JSONResponse(status_code=status_code, content={"success": True, "data": data})


def error_response(
    *, status_code: int, message: str, code: str | None = None, details: dict | None = None
) -> JSONResponse:
    error_payload = {
        "code": code or _error_code_for_status(status_code),
        "message": message,
        "status_code": status_code,
    }
    if details is not None:
        error_payload["details"] = details
    return JSONResponse(status_code=status_code, content={"success": False, "error": error_payload})


def _http_exception_message(exc: HTTPException) -> str:
    if isinstance(exc.detail, str):
        return exc.detail
    if isinstance(exc.detail, dict):
        detail_message = exc.detail.get("message")
        if isinstance(detail_message, str) and detail_message:
            return detail_message
    return "Request failed"


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


@app.function(
    image=function_image,
    volumes={"/data": inspect_volume},
    secrets=[github_app_secrets, internal_api_secret],
)
@fastapi_endpoint(method="POST")
async def api_create_sandbox(
    request: dict,
    authorization: str | None = Header(None),
    x_trace_id: str | None = Header(None),
    x_request_id: str | None = Header(None),
    x_session_id: str | None = Header(None),
    x_sandbox_id: str | None = Header(None),
) -> dict | JSONResponse:
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
    start_time = time.time()
    http_status = 200
    outcome = "success"

    try:
        require_auth(authorization)

        control_plane_url = request.get("control_plane_url")
        require_valid_control_plane_url(control_plane_url)
        if not isinstance(control_plane_url, str):
            control_plane_url = ""

        # Import types and manager directly
        from .auth.github_app import generate_installation_token
        from .sandbox.manager import (
            DEFAULT_SANDBOX_TIMEOUT_SECONDS,
            SandboxConfig,
            SandboxManager,
        )
        from .sandbox.types import SessionConfig

        session_id = request.get("session_id")
        repo_owner = request.get("repo_owner")
        repo_name = request.get("repo_name")
        sandbox_auth_token = request.get("sandbox_auth_token")

        if not isinstance(session_id, str) or not session_id:
            raise HTTPException(status_code=400, detail="session_id is required")
        if not isinstance(repo_owner, str) or not repo_owner:
            raise HTTPException(status_code=400, detail="repo_owner is required")
        if not isinstance(repo_name, str) or not repo_name:
            raise HTTPException(status_code=400, detail="repo_name is required")
        if not isinstance(sandbox_auth_token, str) or not sandbox_auth_token:
            raise HTTPException(status_code=400, detail="sandbox_auth_token is required")

        timeout_seconds_raw = request.get("timeout_seconds")
        timeout_seconds = DEFAULT_SANDBOX_TIMEOUT_SECONDS
        if timeout_seconds_raw is not None:
            try:
                timeout_seconds = int(timeout_seconds_raw)
            except (TypeError, ValueError):
                raise HTTPException(status_code=400, detail="timeout_seconds must be an integer")

        manager = SandboxManager()

        # Generate GitHub App token for git operations
        github_app_token = None
        try:
            app_id = os.environ.get("GITHUB_APP_ID")
            private_key = os.environ.get("GITHUB_APP_PRIVATE_KEY")
            installation_id = os.environ.get("GITHUB_APP_INSTALLATION_ID")

            if app_id and private_key and installation_id:
                github_app_token = generate_installation_token(
                    app_id=app_id,
                    private_key=private_key,
                    installation_id=installation_id,
                )
        except Exception as e:
            log.warn("github.token_error", exc=e)

        session_config = SessionConfig(
            session_id=session_id,
            repo_owner=repo_owner,
            repo_name=repo_name,
            branch=request.get("branch"),
            opencode_session_id=request.get("opencode_session_id"),
            provider=request.get("provider", "anthropic"),
            model=request.get("model", "claude-sonnet-4-6"),
        )

        config = SandboxConfig(
            repo_owner=repo_owner,
            repo_name=repo_name,
            sandbox_id=request.get("sandbox_id"),  # Use control-plane-provided ID for auth
            snapshot_id=request.get("snapshot_id"),
            session_config=session_config,
            control_plane_url=control_plane_url,
            sandbox_auth_token=sandbox_auth_token,
            timeout_seconds=timeout_seconds,
            clone_token=github_app_token,
            user_env_vars=request.get("user_env_vars") or None,
            repo_image_id=request.get("repo_image_id") or None,
            repo_image_sha=request.get("repo_image_sha") or None,
        )

        handle = await manager.create_sandbox(config)

        return success_response(
            {
                "sandbox_id": handle.sandbox_id,
                "modal_object_id": handle.modal_object_id,  # Modal's internal ID for snapshot API
                "status": handle.status.value,
                "created_at": handle.created_at,
            }
        )
    except HTTPException as e:
        outcome = "error"
        http_status = e.status_code
        return error_response(
            status_code=e.status_code,
            message=_http_exception_message(e),
            details=e.detail if isinstance(e.detail, dict) else None,
        )
    except Exception as e:
        outcome = "error"
        http_status = 500
        log.error("api.error", exc=e, endpoint_name="api_create_sandbox")
        return error_response(
            status_code=500,
            message="Failed to create sandbox",
            details={"exception": e.__class__.__name__},
        )
    finally:
        duration_ms = int((time.time() - start_time) * 1000)
        log.info(
            "modal.http_request",
            http_method="POST",
            http_path="/api_create_sandbox",
            http_status=http_status,
            duration_ms=duration_ms,
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
) -> dict | JSONResponse:
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
    start_time = time.time()
    http_status = 200
    outcome = "success"

    try:
        require_auth(authorization)

        control_plane_url = request.get("control_plane_url", "")
        if not isinstance(control_plane_url, str):
            control_plane_url = ""
        require_valid_control_plane_url(control_plane_url)

        repo_owner = request.get("repo_owner")
        repo_name = request.get("repo_name")
        if not isinstance(repo_owner, str) or not repo_owner:
            raise HTTPException(status_code=400, detail="repo_owner is required")
        if not isinstance(repo_name, str) or not repo_name:
            raise HTTPException(status_code=400, detail="repo_name is required")

        from .sandbox.manager import SandboxManager

        manager = SandboxManager()
        handle = await manager.warm_sandbox(
            repo_owner=repo_owner,
            repo_name=repo_name,
            control_plane_url=control_plane_url,
        )

        return success_response(
            {
                "sandbox_id": handle.sandbox_id,
                "status": handle.status.value,
            }
        )
    except HTTPException as e:
        outcome = "error"
        http_status = e.status_code
        return error_response(
            status_code=e.status_code,
            message=_http_exception_message(e),
            details=e.detail if isinstance(e.detail, dict) else None,
        )
    except Exception as e:
        outcome = "error"
        http_status = 500
        log.error("api.error", exc=e, endpoint_name="api_warm_sandbox")
        return error_response(
            status_code=500,
            message="Failed to warm sandbox",
            details={"exception": e.__class__.__name__},
        )
    finally:
        duration_ms = int((time.time() - start_time) * 1000)
        log.info(
            "modal.http_request",
            http_method="POST",
            http_path="/api_warm_sandbox",
            http_status=http_status,
            duration_ms=duration_ms,
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
) -> dict | JSONResponse:
    """
    Get latest snapshot for a repository.

    Requires authentication via Authorization header.

    Query params: ?repo_owner=...&repo_name=...
    """
    start_time = time.time()
    http_status = 200
    outcome = "success"

    try:
        require_auth(authorization)

        from .registry.store import SnapshotStore

        store = SnapshotStore()
        snapshot = store.get_latest_snapshot(repo_owner, repo_name)

        if snapshot:
            return success_response(snapshot.model_dump())
        return success_response(None)
    except HTTPException as e:
        outcome = "error"
        http_status = e.status_code
        return error_response(
            status_code=e.status_code,
            message=_http_exception_message(e),
            details=e.detail if isinstance(e.detail, dict) else None,
        )
    except Exception as e:
        outcome = "error"
        http_status = 500
        log.error("api.error", exc=e, endpoint_name="api_snapshot")
        return error_response(
            status_code=500,
            message="Failed to fetch snapshot",
            details={"exception": e.__class__.__name__},
        )
    finally:
        duration_ms = int((time.time() - start_time) * 1000)
        log.info(
            "modal.http_request",
            http_method="GET",
            http_path="/api_snapshot",
            http_status=http_status,
            duration_ms=duration_ms,
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
) -> dict | JSONResponse:
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
    start_time = time.time()
    http_status = 200
    outcome = "success"
    sandbox_id: str | None = None

    try:
        require_auth(authorization)

        sandbox_id = request.get("sandbox_id")
        if not sandbox_id:
            raise HTTPException(status_code=400, detail="sandbox_id is required")

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

        return success_response(
            {
                "image_id": image_id,
                "sandbox_id": sandbox_id,
                "session_id": session_id,
                "reason": reason,
            }
        )
    except HTTPException as e:
        outcome = "error"
        http_status = e.status_code
        return error_response(
            status_code=e.status_code,
            message=_http_exception_message(e),
            details=e.detail if isinstance(e.detail, dict) else None,
        )
    except Exception as e:
        outcome = "error"
        http_status = 500
        log.error("api.error", exc=e, endpoint_name="api_snapshot_sandbox")
        return error_response(
            status_code=500,
            message="Failed to snapshot sandbox",
            details={"exception": e.__class__.__name__},
        )
    finally:
        duration_ms = int((time.time() - start_time) * 1000)
        log.info(
            "modal.http_request",
            http_method="POST",
            http_path="/api_snapshot_sandbox",
            http_status=http_status,
            duration_ms=duration_ms,
            outcome=outcome,
            endpoint_name="api_snapshot_sandbox",
            trace_id=x_trace_id,
            request_id=x_request_id,
            session_id=x_session_id,
            sandbox_id=x_sandbox_id or sandbox_id,
        )


@app.function(image=function_image, secrets=[github_app_secrets, internal_api_secret])
@fastapi_endpoint(method="POST")
async def api_restore_sandbox(
    request: dict,
    authorization: str | None = Header(None),
    x_trace_id: str | None = Header(None),
    x_request_id: str | None = Header(None),
    x_session_id: str | None = Header(None),
    x_sandbox_id: str | None = Header(None),
) -> dict | JSONResponse:
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
    start_time = time.time()
    http_status = 200
    outcome = "success"

    try:
        require_auth(authorization)

        control_plane_url = request.get("control_plane_url", "")
        if not isinstance(control_plane_url, str):
            control_plane_url = ""
        require_valid_control_plane_url(control_plane_url)

        snapshot_image_id = request.get("snapshot_image_id")
        if not snapshot_image_id:
            raise HTTPException(status_code=400, detail="snapshot_image_id is required")

        from .auth.github_app import generate_installation_token
        from .sandbox.manager import DEFAULT_SANDBOX_TIMEOUT_SECONDS, SandboxManager

        session_config = request.get("session_config", {})
        sandbox_id = request.get("sandbox_id")
        sandbox_auth_token = request.get("sandbox_auth_token", "")
        user_env_vars = request.get("user_env_vars") or None
        timeout_seconds_raw = request.get("timeout_seconds")
        timeout_seconds = DEFAULT_SANDBOX_TIMEOUT_SECONDS
        if timeout_seconds_raw is not None:
            try:
                timeout_seconds = int(timeout_seconds_raw)
            except (TypeError, ValueError):
                raise HTTPException(status_code=400, detail="timeout_seconds must be an integer")

        manager = SandboxManager()

        github_app_token = None
        try:
            app_id = os.environ.get("GITHUB_APP_ID")
            private_key = os.environ.get("GITHUB_APP_PRIVATE_KEY")
            installation_id = os.environ.get("GITHUB_APP_INSTALLATION_ID")

            if app_id and private_key and installation_id:
                github_app_token = generate_installation_token(
                    app_id=app_id,
                    private_key=private_key,
                    installation_id=installation_id,
                )
        except Exception as e:
            log.warn("github.token_error", exc=e)

        # Restore sandbox from snapshot
        handle = await manager.restore_from_snapshot(
            snapshot_image_id=snapshot_image_id,
            session_config=session_config,
            sandbox_id=sandbox_id,
            control_plane_url=control_plane_url,
            sandbox_auth_token=sandbox_auth_token,
            clone_token=github_app_token,
            user_env_vars=user_env_vars,
            timeout_seconds=timeout_seconds,
        )

        return success_response(
            {
                "sandbox_id": handle.sandbox_id,
                "modal_object_id": handle.modal_object_id,
                "status": handle.status.value,
            }
        )
    except HTTPException as e:
        outcome = "error"
        http_status = e.status_code
        return error_response(
            status_code=e.status_code,
            message=_http_exception_message(e),
            details=e.detail if isinstance(e.detail, dict) else None,
        )
    except Exception as e:
        outcome = "error"
        http_status = 500
        log.error("api.error", exc=e, endpoint_name="api_restore_sandbox")
        return error_response(
            status_code=500,
            message="Failed to restore sandbox",
            details={"exception": e.__class__.__name__},
        )
    finally:
        duration_ms = int((time.time() - start_time) * 1000)
        log.info(
            "modal.http_request",
            http_method="POST",
            http_path="/api_restore_sandbox",
            http_status=http_status,
            duration_ms=duration_ms,
            outcome=outcome,
            endpoint_name="api_restore_sandbox",
            trace_id=x_trace_id,
            request_id=x_request_id,
            session_id=x_session_id,
            sandbox_id=x_sandbox_id,
        )


@app.function(
    image=function_image,
    secrets=[internal_api_secret, github_app_secrets],
)
@fastapi_endpoint(method="POST")
async def api_build_repo_image(
    request: dict,
    authorization: str | None = Header(None),
    x_trace_id: str | None = Header(None),
    x_request_id: str | None = Header(None),
) -> dict | JSONResponse:
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
    start_time = time.time()
    http_status = 200
    outcome = "success"

    try:
        require_auth(authorization)

        from .scheduler.image_builder import build_repo_image

        repo_owner = request.get("repo_owner")
        repo_name = request.get("repo_name")
        default_branch = request.get("default_branch", "main")
        build_id = request.get("build_id", "")
        callback_url = request.get("callback_url", "")
        user_env_vars = request.get("user_env_vars") or None

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
        )

        return success_response(
            {
                "build_id": build_id,
                "status": "building",
            }
        )
    except HTTPException as e:
        outcome = "error"
        http_status = e.status_code
        return error_response(
            status_code=e.status_code,
            message=_http_exception_message(e),
            details=e.detail if isinstance(e.detail, dict) else None,
        )
    except Exception as e:
        outcome = "error"
        http_status = 500
        log.error("api.error", exc=e, endpoint_name="api_build_repo_image")
        return error_response(
            status_code=500,
            message="Failed to start image build",
            details={"exception": e.__class__.__name__},
        )
    finally:
        duration_ms = int((time.time() - start_time) * 1000)
        log.info(
            "modal.http_request",
            http_method="POST",
            http_path="/api_build_repo_image",
            http_status=http_status,
            duration_ms=duration_ms,
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
) -> dict | JSONResponse:
    """
    Delete a single provider image (best-effort).

    Used to clean up old pre-built images after they're replaced by newer builds.

    POST body:
    {
        "provider_image_id": "..."
    }
    """
    start_time = time.time()
    http_status = 200
    outcome = "success"

    try:
        require_auth(authorization)

        provider_image_id = request.get("provider_image_id")
        if not provider_image_id:
            raise HTTPException(status_code=400, detail="provider_image_id is required")

        # Modal doesn't have an explicit delete API for images;
        # images are garbage-collected when no longer referenced.
        # We log the request for auditability.
        log.info(
            "image.delete_requested",
            provider_image_id=provider_image_id,
        )

        return success_response(
            {
                "provider_image_id": provider_image_id,
                "deleted": True,
            }
        )
    except HTTPException as e:
        outcome = "error"
        http_status = e.status_code
        return error_response(
            status_code=e.status_code,
            message=_http_exception_message(e),
            details=e.detail if isinstance(e.detail, dict) else None,
        )
    except Exception as e:
        outcome = "error"
        http_status = 500
        log.error("api.error", exc=e, endpoint_name="api_delete_provider_image")
        return error_response(
            status_code=500,
            message="Failed to delete provider image",
            details={"exception": e.__class__.__name__},
        )
    finally:
        duration_ms = int((time.time() - start_time) * 1000)
        log.info(
            "modal.http_request",
            http_method="POST",
            http_path="/api_delete_provider_image",
            http_status=http_status,
            duration_ms=duration_ms,
            outcome=outcome,
            endpoint_name="api_delete_provider_image",
            trace_id=x_trace_id,
            request_id=x_request_id,
        )
