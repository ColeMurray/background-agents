"""
Web API endpoints for Open-Inspect Daytona infrastructure.

These endpoints expose Daytona sandbox operations as HTTP APIs that can be called
from the control plane (Cloudflare Workers).

SECURITY: All sensitive endpoints require authentication via HMAC-signed tokens.
The control plane must include an Authorization header with a valid token.
"""

import os
import time

import httpx
from fastapi import APIRouter, Header, HTTPException, Request
from fastapi.responses import Response

from .auth.internal import AuthConfigurationError, verify_internal_token
from .log_config import configure_logging, get_logger

configure_logging()
log = get_logger("web_api")

router = APIRouter()


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


def require_valid_control_plane_url(url: str | None, request: Request) -> None:
    """
    Validate control_plane_url, raising HTTPException on failure.

    Args:
        url: The control plane URL to validate
        request: FastAPI request (for accessing app state)

    Raises:
        HTTPException: 400 if URL is invalid
    """
    if url:
        from .app import validate_control_plane_url

        if not validate_control_plane_url(url):
            raise HTTPException(
                status_code=400,
                detail=f"Invalid control_plane_url: {url}. URL must match allowed patterns.",
            )


@router.get("/api/health")
def api_health() -> dict:
    """Health check endpoint. Does not require authentication."""
    return {"success": True, "data": {"status": "healthy", "service": "open-inspect-daytona"}}


@router.post("/api/create-sandbox")
async def api_create_sandbox(
    request: Request,
    body: dict,
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
        "sandbox_id": "...",
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

    control_plane_url = body.get("control_plane_url")
    require_valid_control_plane_url(control_plane_url, request)

    try:
        from .auth.github_app import generate_installation_token
        from .sandbox.manager import DaytonaSandboxManager, SandboxConfig
        from .sandbox.types import SessionConfig

        config = request.app.state.config

        manager = DaytonaSandboxManager(
            daytona=request.app.state.daytona,
            s3_client=request.app.state.s3,
            config=config,
        )

        # Generate GitHub App token for git operations
        github_app_token = None
        try:
            app_id = config.github_app_id
            private_key = config.github_app_private_key
            installation_id = config.github_app_installation_id

            if app_id and private_key and installation_id:
                from .auth.github_app import resolve_api_base

                github_app_token = generate_installation_token(
                    app_id=app_id,
                    private_key=private_key,
                    installation_id=installation_id,
                    api_base=resolve_api_base(config.github_hostname),
                )
        except Exception as e:
            log.warn("github.token_error", exc=e)

        session_config = SessionConfig(
            session_id=body.get("session_id"),
            repo_owner=body.get("repo_owner"),
            repo_name=body.get("repo_name"),
            branch=body.get("branch"),
            opencode_session_id=body.get("opencode_session_id"),
            provider=body.get("provider", "anthropic"),
            model=body.get("model", "claude-sonnet-4-6"),
        )

        sandbox_config = SandboxConfig(
            repo_owner=body.get("repo_owner"),
            repo_name=body.get("repo_name"),
            sandbox_id=body.get("sandbox_id"),
            snapshot_id=body.get("snapshot_id"),
            session_config=session_config,
            control_plane_url=control_plane_url,
            sandbox_auth_token=body.get("sandbox_auth_token"),
            clone_token=github_app_token,
            user_env_vars=body.get("user_env_vars") or None,
            repo_image_id=body.get("repo_image_id") or None,
            repo_image_sha=body.get("repo_image_sha") or None,
        )

        handle = await manager.create_sandbox(sandbox_config)

        return {
            "success": True,
            "data": {
                "sandbox_id": handle.sandbox_id,
                "modal_object_id": handle.provider_object_id,  # Keep same key for API compat
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
        duration_ms = int((time.time() - start_time) * 1000)
        log.info(
            "daytona.http_request",
            http_method="POST",
            http_path="/api/create-sandbox",
            http_status=http_status,
            duration_ms=duration_ms,
            outcome=outcome,
            endpoint_name="api_create_sandbox",
            trace_id=x_trace_id,
            request_id=x_request_id,
            session_id=x_session_id,
            sandbox_id=x_sandbox_id,
        )


@router.post("/api/snapshot-sandbox")
async def api_snapshot_sandbox(
    request: Request,
    body: dict,
    authorization: str | None = Header(None),
    x_trace_id: str | None = Header(None),
    x_request_id: str | None = Header(None),
    x_session_id: str | None = Header(None),
    x_sandbox_id: str | None = Header(None),
) -> dict:
    """
    Take a filesystem snapshot of a running sandbox.

    Creates a tarball of the sandbox's workspace and uploads it to S3.
    The snapshot key can be used to restore the sandbox later.

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

    sandbox_id = body.get("sandbox_id")
    if not sandbox_id:
        raise HTTPException(status_code=400, detail="sandbox_id is required")

    try:
        from .sandbox.manager import DaytonaSandboxManager

        session_id = body.get("session_id")
        reason = body.get("reason", "manual")

        config = request.app.state.config
        manager = DaytonaSandboxManager(
            daytona=request.app.state.daytona,
            s3_client=request.app.state.s3,
            config=config,
        )

        # Take filesystem snapshot (tarball to S3)
        image_id = await manager.take_snapshot(
            sandbox_id=sandbox_id,
            session_id=session_id or "",
            reason=reason,
        )

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
            "daytona.http_request",
            http_method="POST",
            http_path="/api/snapshot-sandbox",
            http_status=http_status,
            duration_ms=duration_ms,
            outcome=outcome,
            endpoint_name="api_snapshot_sandbox",
            trace_id=x_trace_id,
            request_id=x_request_id,
            session_id=x_session_id,
            sandbox_id=x_sandbox_id or sandbox_id,
        )


@router.post("/api/restore-sandbox")
async def api_restore_sandbox(
    request: Request,
    body: dict,
    authorization: str | None = Header(None),
    x_trace_id: str | None = Header(None),
    x_request_id: str | None = Header(None),
    x_session_id: str | None = Header(None),
    x_sandbox_id: str | None = Header(None),
) -> dict:
    """
    Create a new sandbox from a filesystem snapshot.

    Restores a sandbox from a previously taken snapshot tarball in S3,
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
            "modal_object_id": "...",
            "status": "warming"
        }
    }
    """
    start_time = time.time()
    http_status = 200
    outcome = "success"

    require_auth(authorization)

    control_plane_url = body.get("control_plane_url", "")
    require_valid_control_plane_url(control_plane_url, request)

    snapshot_image_id = body.get("snapshot_image_id")
    if not snapshot_image_id:
        raise HTTPException(status_code=400, detail="snapshot_image_id is required")

    try:
        from .auth.github_app import generate_installation_token
        from .sandbox.manager import DEFAULT_SANDBOX_TIMEOUT_SECONDS, DaytonaSandboxManager

        session_config = body.get("session_config", {})
        sandbox_id = body.get("sandbox_id")
        sandbox_auth_token = body.get("sandbox_auth_token", "")
        user_env_vars = body.get("user_env_vars") or None
        timeout_seconds = int(body.get("timeout_seconds", DEFAULT_SANDBOX_TIMEOUT_SECONDS))

        config = request.app.state.config
        manager = DaytonaSandboxManager(
            daytona=request.app.state.daytona,
            s3_client=request.app.state.s3,
            config=config,
        )

        github_app_token = None
        try:
            app_id = config.github_app_id
            private_key = config.github_app_private_key
            installation_id = config.github_app_installation_id

            if app_id and private_key and installation_id:
                from .auth.github_app import resolve_api_base

                github_app_token = generate_installation_token(
                    app_id=app_id,
                    private_key=private_key,
                    installation_id=installation_id,
                    api_base=resolve_api_base(config.github_hostname),
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

        return {
            "success": True,
            "data": {
                "sandbox_id": handle.sandbox_id,
                "modal_object_id": handle.provider_object_id,  # Keep same key for API compat
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
        duration_ms = int((time.time() - start_time) * 1000)
        log.info(
            "daytona.http_request",
            http_method="POST",
            http_path="/api/restore-sandbox",
            http_status=http_status,
            duration_ms=duration_ms,
            outcome=outcome,
            endpoint_name="api_restore_sandbox",
            trace_id=x_trace_id,
            request_id=x_request_id,
            session_id=x_session_id,
            sandbox_id=x_sandbox_id,
        )


@router.post("/api/warm-sandbox")
async def api_warm_sandbox(
    request: Request,
    body: dict,
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
    start_time = time.time()
    http_status = 200
    outcome = "success"

    require_auth(authorization)

    control_plane_url = body.get("control_plane_url", "")
    require_valid_control_plane_url(control_plane_url, request)

    try:
        from .sandbox.manager import DaytonaSandboxManager

        config = request.app.state.config
        manager = DaytonaSandboxManager(
            daytona=request.app.state.daytona,
            s3_client=request.app.state.s3,
            config=config,
        )

        handle = await manager.warm_sandbox(
            repo_owner=body.get("repo_owner"),
            repo_name=body.get("repo_name"),
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
        duration_ms = int((time.time() - start_time) * 1000)
        log.info(
            "daytona.http_request",
            http_method="POST",
            http_path="/api/warm-sandbox",
            http_status=http_status,
            duration_ms=duration_ms,
            outcome=outcome,
            endpoint_name="api_warm_sandbox",
            trace_id=x_trace_id,
            request_id=x_request_id,
            session_id=x_session_id,
            sandbox_id=x_sandbox_id,
        )


@router.post("/api/build-repo-image")
async def api_build_repo_image(
    request: Request,
    body: dict,
    authorization: str | None = Header(None),
    x_trace_id: str | None = Header(None),
    x_request_id: str | None = Header(None),
) -> dict:
    """
    Kick off an async image build. Returns immediately.

    Spawns a background build task that will:
    1. Create a build sandbox
    2. Wait for it to finish (git clone + setup)
    3. Snapshot the filesystem to S3
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

    require_auth(authorization)

    try:
        import asyncio

        from .scheduler.image_builder import build_repo_image

        repo_owner = body.get("repo_owner")
        repo_name = body.get("repo_name")
        default_branch = body.get("default_branch", "main")
        build_id = body.get("build_id", "")
        callback_url = body.get("callback_url", "")
        user_env_vars = body.get("user_env_vars") or None

        if not repo_owner or not repo_name:
            raise HTTPException(status_code=400, detail="repo_owner and repo_name are required")

        if not build_id:
            raise HTTPException(status_code=400, detail="build_id is required")

        # Spawn the async builder as a background task — returns immediately
        asyncio.create_task(
            build_repo_image(
                daytona=request.app.state.daytona,
                s3_client=request.app.state.s3,
                config=request.app.state.config,
                repo_owner=repo_owner,
                repo_name=repo_name,
                default_branch=default_branch,
                callback_url=callback_url,
                build_id=build_id,
                user_env_vars=user_env_vars,
            )
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
        duration_ms = int((time.time() - start_time) * 1000)
        log.info(
            "daytona.http_request",
            http_method="POST",
            http_path="/api/build-repo-image",
            http_status=http_status,
            duration_ms=duration_ms,
            outcome=outcome,
            endpoint_name="api_build_repo_image",
            trace_id=x_trace_id,
            request_id=x_request_id,
        )


@router.post("/api/delete-provider-image")
async def api_delete_provider_image(
    request: Request,
    body: dict,
    authorization: str | None = Header(None),
    x_trace_id: str | None = Header(None),
    x_request_id: str | None = Header(None),
) -> dict:
    """
    Delete a single provider image (best-effort).

    Used to clean up old pre-built images after they're replaced by newer builds.
    For Daytona, this deletes the snapshot tarball from S3.

    POST body:
    {
        "provider_image_id": "..."
    }
    """
    start_time = time.time()
    http_status = 200
    outcome = "success"

    require_auth(authorization)

    provider_image_id = body.get("provider_image_id")
    if not provider_image_id:
        raise HTTPException(status_code=400, detail="provider_image_id is required")

    try:
        config = request.app.state.config
        s3 = request.app.state.s3

        log.info(
            "image.delete_requested",
            provider_image_id=provider_image_id,
        )

        # Delete the snapshot tarball from S3
        try:
            s3.delete_object(Bucket=config.s3_bucket, Key=provider_image_id)
            log.info("image.deleted", provider_image_id=provider_image_id)
        except Exception as e:
            log.warn("image.delete_failed", provider_image_id=provider_image_id, exc=e)

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
            "daytona.http_request",
            http_method="POST",
            http_path="/api/delete-provider-image",
            http_status=http_status,
            duration_ms=duration_ms,
            outcome=outcome,
            endpoint_name="api_delete_provider_image",
            trace_id=x_trace_id,
            request_id=x_request_id,
        )


@router.get("/api/snapshot")
def api_snapshot(
    request: Request,
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
    start_time = time.time()
    http_status = 200
    outcome = "success"

    require_auth(authorization)

    try:
        from .registry.store import SnapshotStore

        store = SnapshotStore(
            s3_client=request.app.state.s3,
            bucket=request.app.state.config.s3_bucket,
        )
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
        duration_ms = int((time.time() - start_time) * 1000)
        log.info(
            "daytona.http_request",
            http_method="GET",
            http_path="/api/snapshot",
            http_status=http_status,
            duration_ms=duration_ms,
            outcome=outcome,
            endpoint_name="api_snapshot",
            trace_id=x_trace_id,
            request_id=x_request_id,
            session_id=x_session_id,
            sandbox_id=x_sandbox_id,
        )


@router.api_route("/ghes-proxy/{path:path}", methods=["GET", "POST", "PUT", "PATCH", "DELETE"])
async def ghes_proxy(
    request: Request,
    path: str,
    authorization: str | None = Header(None),
) -> Response:
    """
    Reverse proxy to GHES for OAuth token exchange and API calls.

    The web app (Cloudflare Worker) cannot reach GHES directly because it's
    in a private VPC. This endpoint forwards requests to the GHES instance.

    Requires authentication via Authorization header (same HMAC token as other endpoints).
    Only proxies to paths under /login/oauth/ and /api/v3/ to limit scope.
    """
    require_auth(authorization)

    ghes_hostname = os.environ.get("GITHUB_HOSTNAME", "")
    if not ghes_hostname:
        raise HTTPException(status_code=503, detail="GITHUB_HOSTNAME not configured")

    # Only allow OAuth and API paths to prevent open proxy abuse
    allowed_prefixes = ("login/oauth/", "api/v3/")
    if not any(path.startswith(p) for p in allowed_prefixes):
        raise HTTPException(status_code=403, detail="Path not allowed through GHES proxy")

    target_url = f"https://{ghes_hostname}/{path}"
    body = await request.body()
    headers = {
        k: v
        for k, v in request.headers.items()
        if k.lower() not in ("host", "cf-connecting-ip", "cf-ray", "cf-visitor", "x-forwarded-for", "x-forwarded-proto", "authorization")
    }
    headers["Host"] = ghes_hostname

    # Use the GHES CA bundle if configured, otherwise use system defaults
    ca_bundle = os.environ.get("GHES_CA_BUNDLE", True)
    async with httpx.AsyncClient(verify=ca_bundle, timeout=30.0) as client:
        resp = await client.request(
            method=request.method,
            url=target_url,
            content=body,
            headers=headers,
        )

    return Response(
        content=resp.content,
        status_code=resp.status_code,
        headers=dict(resp.headers),
    )
