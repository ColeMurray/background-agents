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
    github_app_secrets,
    internal_api_secret,
    validate_control_plane_url,
)
from .auth import AuthConfigurationError, verify_internal_token
from .clone_token import resolve_clone_token
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


def _normalize_optional_repository_context(
    repo_owner: str | None, repo_name: str | None
) -> tuple[str | None, str | None]:
    normalized_owner = repo_owner.strip() if isinstance(repo_owner, str) else None
    normalized_name = repo_name.strip() if isinstance(repo_name, str) else None
    normalized_owner = normalized_owner or None
    normalized_name = normalized_name or None
    if (normalized_owner is None) != (normalized_name is None):
        raise HTTPException(
            status_code=400,
            detail="repo_owner and repo_name must be provided together",
        )
    return normalized_owner, normalized_name


def _session_config_from_create_request(
    request: dict, *, repo_owner: str | None, repo_name: str | None
):
    """Build the create-path SessionConfig from the flat wire request.

    Create is a lossy reconstruction — the manager re-serializes this typed
    model into SESSION_CONFIG — while restore forwards its session_config
    dict verbatim. Wire fields share their names with SessionConfig fields,
    so the model's own field list drives the pickup: a new field only needs
    the SessionConfig change, not another line here. repo_owner/repo_name
    are set from the normalized pair, never the raw request.
    """
    from .sandbox import SessionConfig

    fields = {
        name: request[name]
        for name in SessionConfig.model_fields
        if name in request and request[name] is not None
    }
    fields["repo_owner"] = repo_owner
    fields["repo_name"] = repo_name
    return SessionConfig(**fields)


@app.function(
    image=function_image,
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
    start_time = time.time()
    http_status = 200
    outcome = "success"

    require_auth(authorization)

    control_plane_url = request.get("control_plane_url")
    require_valid_control_plane_url(control_plane_url)

    try:
        from .sandbox.manager import SandboxConfig, SandboxManager

        manager = SandboxManager()

        snapshot_id = request.get("snapshot_id")
        repo_image_id = request.get("repo_image_id") or None
        repo_owner, repo_name = _normalize_optional_repository_context(
            request.get("repo_owner"),
            request.get("repo_name"),
        )
        fallback_clone_token = (
            resolve_clone_token() if snapshot_id and repo_owner and repo_name else None
        )

        session_config = _session_config_from_create_request(
            request, repo_owner=repo_owner, repo_name=repo_name
        )

        config = SandboxConfig(
            repo_owner=repo_owner,
            repo_name=repo_name,
            sandbox_id=request.get("sandbox_id"),  # Use control-plane-provided ID for auth
            snapshot_id=snapshot_id,
            session_config=session_config,
            control_plane_url=control_plane_url,
            sandbox_auth_token=request.get("sandbox_auth_token"),
            fallback_clone_token=fallback_clone_token,
            user_env_vars=request.get("user_env_vars") or None,
            repo_image_id=repo_image_id,
            repo_image_sha=request.get("repo_image_sha") or None,
            code_server_enabled=bool(request.get("code_server_enabled", False)),
            agent_slack_notify_enabled=bool(request.get("agent_slack_notify_enabled", False)),
            settings=request.get("sandbox_settings") or None,
        )

        handle = await manager.create_sandbox(config)

        return {
            "success": True,
            "data": {
                "sandbox_id": handle.sandbox_id,
                "modal_object_id": handle.modal_object_id,  # Modal's internal ID for snapshot API
                "status": handle.status.value,
                "created_at": handle.created_at,
                "code_server_url": handle.code_server_url,
                "code_server_password": handle.code_server_password,
                "ttyd_url": handle.ttyd_url,
                "tunnel_urls": handle.tunnel_urls,
            },
        }
    except HTTPException as e:
        outcome = "error"
        http_status = e.status_code
        raise
    except Exception as e:
        outcome = "error"
        http_status = 500
        log.error("api.error", exc=e, endpoint_name="api_create_sandbox")
        return {"success": False, "error": str(e)}
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


@app.function(image=function_image)
@fastapi_endpoint(method="GET")
def api_health() -> dict:
    """Health check endpoint. Does not require authentication."""
    return {"success": True, "data": {"status": "healthy", "service": "open-inspect-modal"}}


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
    start_time = time.time()
    http_status = 200
    outcome = "success"

    require_auth(authorization)

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
    start_time = time.time()
    http_status = 200
    outcome = "success"

    require_auth(authorization)

    control_plane_url = request.get("control_plane_url", "")
    require_valid_control_plane_url(control_plane_url)

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
        repo_owner, repo_name = _normalize_optional_repository_context(
            session_config.get("repo_owner") if isinstance(session_config, dict) else None,
            session_config.get("repo_name") if isinstance(session_config, dict) else None,
        )

        manager = SandboxManager()
        clone_token = resolve_clone_token() if repo_owner and repo_name else None

        code_server_enabled = bool(request.get("code_server_enabled", False))
        agent_slack_notify_enabled = bool(request.get("agent_slack_notify_enabled", False))
        sandbox_settings = request.get("sandbox_settings") or None

        # Restore sandbox from snapshot
        handle = await manager.restore_from_snapshot(
            snapshot_image_id=snapshot_image_id,
            session_config=session_config,
            sandbox_id=sandbox_id,
            control_plane_url=control_plane_url,
            sandbox_auth_token=sandbox_auth_token,
            clone_token=clone_token,
            user_env_vars=user_env_vars,
            timeout_seconds=timeout_seconds,
            code_server_enabled=code_server_enabled,
            agent_slack_notify_enabled=agent_slack_notify_enabled,
            settings=sandbox_settings,
        )

        return {
            "success": True,
            "data": {
                "sandbox_id": handle.sandbox_id,
                "modal_object_id": handle.modal_object_id,
                "status": handle.status.value,
                "code_server_url": handle.code_server_url,
                "code_server_password": handle.code_server_password,
                "ttyd_url": handle.ttyd_url,
                "tunnel_urls": handle.tunnel_urls,
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
async def api_build_image(
    request: dict,
    authorization: str | None = Header(None),
    x_trace_id: str | None = Header(None),
    x_request_id: str | None = Header(None),
) -> dict:
    """
    Kick off an async scope image build (design §4). Returns immediately.

    Spawns a build_image worker that clones every repository in the set, runs
    their setup hooks sequentially, snapshots the filesystem, and POSTs the
    result (repository_shas + runtime_version) to callback_url.

    POST body:
    {
        "scope_kind": "repo" | "environment",  // logging only
        "scope_id": "...",                      // logging only
        "build_id": "...",
        "callback_url": "...",
        "failure_callback_url": "...",
        "repositories": [{"repo_owner": "...", "repo_name": "...", "branch": "..."}],
        "user_env_vars": {...},          // optional
        "build_timeout_seconds": 1800    // optional
    }
    """
    start_time = time.time()
    http_status = 200
    outcome = "success"

    require_auth(authorization)

    try:
        from .sandbox.manager import (
            DEFAULT_BUILD_TIMEOUT_SECONDS,
            build_function_timeout_seconds,
        )
        from .scheduler.image_builder import build_image

        scope_kind = request.get("scope_kind", "")
        scope_id = request.get("scope_id", "")
        build_id = request.get("build_id", "")
        callback_url = request.get("callback_url", "")
        failure_callback_url = request.get("failure_callback_url", "")
        repositories = request.get("repositories")
        user_env_vars = request.get("user_env_vars") or None
        # Already capped by the control plane; default when absent/null.
        build_timeout_seconds = int(
            request.get("build_timeout_seconds") or DEFAULT_BUILD_TIMEOUT_SECONDS
        )

        if not build_id:
            raise HTTPException(status_code=400, detail="build_id is required")

        if not callback_url:
            raise HTTPException(status_code=400, detail="callback_url is required")

        if not failure_callback_url:
            raise HTTPException(status_code=400, detail="failure_callback_url is required")

        if not isinstance(repositories, list) or not repositories:
            raise HTTPException(status_code=400, detail="repositories must be a non-empty list")
        for entry in repositories:
            if (
                not isinstance(entry, dict)
                or not entry.get("repo_owner")
                or not entry.get("repo_name")
                or not entry.get("branch")
            ):
                raise HTTPException(
                    status_code=400,
                    detail="repositories entries require repo_owner, repo_name, and branch",
                )

        function_timeout = build_function_timeout_seconds(build_timeout_seconds)

        # Spawn the async builder — returns immediately
        await build_image.with_options(timeout=function_timeout).spawn.aio(
            scope_kind=scope_kind,
            scope_id=scope_id,
            repositories=repositories,
            callback_url=callback_url,
            failure_callback_url=failure_callback_url,
            build_id=build_id,
            user_env_vars=user_env_vars,
            build_timeout_seconds=build_timeout_seconds,
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
        log.error("api.error", exc=e, endpoint_name="api_build_image")
        return {"success": False, "error": str(e)}
    finally:
        duration_ms = int((time.time() - start_time) * 1000)
        log.info(
            "modal.http_request",
            http_method="POST",
            http_path="/api_build_image",
            http_status=http_status,
            duration_ms=duration_ms,
            outcome=outcome,
            endpoint_name="api_build_image",
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
    start_time = time.time()
    http_status = 200
    outcome = "success"

    require_auth(authorization)

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
