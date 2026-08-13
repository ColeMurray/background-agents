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
from pathlib import Path
from typing import Annotated

from fastapi import Header, HTTPException
from modal import fastapi_endpoint
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from sandbox_runtime.auth import AuthConfigurationError, verify_internal_token
from sandbox_runtime.repo_config import RepoConfigError, parse_repositories

from .app import (
    app,
    function_image,
    github_app_secrets,
    internal_api_secret,
    validate_control_plane_url,
)
from .clone_token import resolve_clone_token
from .log_config import configure_logging, get_logger

configure_logging()
log = get_logger("web_api")
IMAGE_BUILD_FINALIZATION_GRACE_SECONDS = 10 * 60


class _ModalRequestModel(BaseModel):
    model_config = ConfigDict(extra="ignore", strict=True)


NonEmptyString = Annotated[str, Field(min_length=1)]


class SnapshotBuildSandboxRequest(_ModalRequestModel):
    build_id: NonEmptyString
    provider_session_id: NonEmptyString


class BuildRepositoryRequest(_ModalRequestModel):
    repo_owner: NonEmptyString
    repo_name: NonEmptyString
    branch: NonEmptyString
    base_sha: str | None = None


class CreateBuildSandboxRequest(_ModalRequestModel):
    scope_kind: NonEmptyString
    scope_id: NonEmptyString
    build_id: NonEmptyString
    repositories: list[BuildRepositoryRequest]
    callback_url: NonEmptyString
    failure_callback_url: NonEmptyString
    clone_token: str | None = None
    clone_host: str | None = None
    clone_username: str | None = None
    user_env_vars: dict[str, str] | None = None
    build_execution_timeout_seconds: int | None = None
    provider_session_timeout_seconds: int | None = None


class StartBuildSandboxRequest(_ModalRequestModel):
    build_id: NonEmptyString
    provider_session_id: NonEmptyString
    callback_token: NonEmptyString


class TerminateBuildSandboxRequest(_ModalRequestModel):
    build_id: NonEmptyString
    provider_session_id: NonEmptyString
    reason: NonEmptyString


class DeleteProviderImageRequest(_ModalRequestModel):
    provider_image_id: NonEmptyString


def _parse_request[RequestModelT: BaseModel](
    model: type[RequestModelT], request: dict[str, object]
) -> RequestModelT:
    try:
        return model.model_validate(request)
    except ValidationError as e:
        error = e.errors(include_input=False)[0]
        location = error["loc"]
        field = str(location[0]) if location else "request"
        error_type = error["type"]
        if field == "repositories":
            detail = {
                "list_type": "repositories must be a list",
                "model_type": "repositories entries must be objects",
                "missing": "repositories entries require repo_owner, repo_name, and branch",
                "string_too_short": (
                    "repositories entries require repo_owner, repo_name, and branch"
                ),
                "string_type": "repositories entry fields must be strings",
            }.get(error_type, "repositories has an invalid value")
        elif field == "user_env_vars":
            detail = {
                "dict_type": "user_env_vars must be an object",
                "string_type": "user_env_vars values must be strings",
            }.get(error_type, "user_env_vars has an invalid value")
        elif len(location) > 1:
            detail = f"{field} has an invalid value"
        else:
            detail = {
                "missing": f"{field} is required",
                "string_too_short": f"{field} is required",
                "string_type": f"{field} must be a string",
                "int_type": f"{field} must be an integer",
            }.get(error_type, f"{field} has an invalid value")
        raise HTTPException(status_code=400, detail=detail) from None


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


def _timeout_seconds_from_request(request: dict, default_timeout_seconds: int) -> int:
    value = request.get("timeout_seconds")
    if value is None:
        return default_timeout_seconds
    if isinstance(value, bool):
        raise HTTPException(status_code=400, detail="timeout_seconds must be a positive integer")
    try:
        timeout_seconds = int(value)
    except (TypeError, ValueError, OverflowError):
        raise HTTPException(
            status_code=400, detail="timeout_seconds must be a positive integer"
        ) from None
    if timeout_seconds < 1 or timeout_seconds != value:
        raise HTTPException(status_code=400, detail="timeout_seconds must be a positive integer")
    return timeout_seconds


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
        from .sandbox.manager import (
            DEFAULT_SANDBOX_TIMEOUT_SECONDS,
            DEFAULT_VNC_ENABLED,
            SandboxConfig,
            SandboxManager,
        )

        manager = SandboxManager()

        repo_image_id = request.get("repo_image_id") or None
        repo_owner, repo_name = _normalize_optional_repository_context(
            request.get("repo_owner"),
            request.get("repo_name"),
        )

        session_config = _session_config_from_create_request(
            request, repo_owner=repo_owner, repo_name=repo_name
        )

        config = SandboxConfig(
            repo_owner=repo_owner,
            repo_name=repo_name,
            sandbox_id=request.get("sandbox_id"),  # Use control-plane-provided ID for auth
            session_config=session_config,
            control_plane_url=control_plane_url,
            sandbox_auth_token=request.get("sandbox_auth_token"),
            user_env_vars=request.get("user_env_vars") or None,
            repo_image_id=repo_image_id,
            repo_image_sha=request.get("repo_image_sha") or None,
            code_server_enabled=bool(request.get("code_server_enabled", False)),
            vnc_enabled=bool(request.get("vnc_enabled", DEFAULT_VNC_ENABLED)),
            agent_slack_notify_enabled=bool(request.get("agent_slack_notify_enabled", False)),
            settings=request.get("sandbox_settings") or None,
            timeout_seconds=_timeout_seconds_from_request(request, DEFAULT_SANDBOX_TIMEOUT_SECONDS),
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
                "vnc_url": handle.vnc_url,
                "vnc_password": handle.vnc_password,
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

        handle = await manager.get_sandbox_by_id(sandbox_id)
        if not handle:
            raise HTTPException(status_code=404, detail=f"Sandbox not found: {sandbox_id}")

        image_id = await manager.take_snapshot(handle)

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


@app.function(image=function_image, secrets=[internal_api_secret])
@fastapi_endpoint(method="POST")
async def api_snapshot_build_sandbox(
    request: dict[str, object],
    authorization: str | None = Header(None),
    x_trace_id: str | None = Header(None),
    x_request_id: str | None = Header(None),
) -> dict:
    """Snapshot the exact provider session bound to an image build."""
    start_time = time.time()
    http_status = 200
    outcome = "success"
    build_id = request.get("build_id")
    provider_session_id = request.get("provider_session_id")

    require_auth(authorization)

    try:
        from .sandbox.build_session import (
            BuildSessionNotFoundError,
            ModalBuildSessionService,
        )

        parsed_request = _parse_request(SnapshotBuildSandboxRequest, request)
        build_id = parsed_request.build_id
        provider_session_id = parsed_request.provider_session_id
        image_id = await ModalBuildSessionService().snapshot(
            build_id=build_id,
            provider_session_id=provider_session_id,
        )
        return {
            "success": True,
            "data": {
                "image_id": image_id,
                "build_id": build_id,
                "provider_session_id": provider_session_id,
            },
        }
    except BuildSessionNotFoundError as e:
        outcome = "error"
        http_status = 404
        raise HTTPException(status_code=404, detail=str(e)) from e
    except HTTPException as e:
        outcome = "error"
        http_status = e.status_code
        raise
    except Exception as e:
        outcome = "error"
        http_status = 500
        log.error("api.error", exc=e, endpoint_name="api_snapshot_build_sandbox")
        return {"success": False, "error": str(e)}
    finally:
        log.info(
            "modal.http_request",
            http_method="POST",
            http_path="/api_snapshot_build_sandbox",
            http_status=http_status,
            duration_ms=int((time.time() - start_time) * 1000),
            outcome=outcome,
            endpoint_name="api_snapshot_build_sandbox",
            trace_id=x_trace_id,
            request_id=x_request_id,
            build_id=build_id,
            sandbox_id=provider_session_id,
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
        from .sandbox.manager import (
            DEFAULT_SANDBOX_TIMEOUT_SECONDS,
            DEFAULT_VNC_ENABLED,
            SandboxManager,
        )

        session_config = request.get("session_config", {})
        sandbox_id = request.get("sandbox_id")
        sandbox_auth_token = request.get("sandbox_auth_token", "")
        user_env_vars = request.get("user_env_vars") or None
        timeout_seconds = _timeout_seconds_from_request(request, DEFAULT_SANDBOX_TIMEOUT_SECONDS)
        repo_owner, repo_name = _normalize_optional_repository_context(
            session_config.get("repo_owner") if isinstance(session_config, dict) else None,
            session_config.get("repo_name") if isinstance(session_config, dict) else None,
        )
        if isinstance(session_config, dict):
            session_config = {
                **session_config,
                "repo_owner": repo_owner,
                "repo_name": repo_name,
            }

        manager = SandboxManager()
        clone_token = resolve_clone_token() if repo_owner and repo_name else None

        code_server_enabled = bool(request.get("code_server_enabled", False))
        vnc_enabled = bool(request.get("vnc_enabled", DEFAULT_VNC_ENABLED))
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
            vnc_enabled=vnc_enabled,
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
                "vnc_url": handle.vnc_url,
                "vnc_password": handle.vnc_password,
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
    secrets=[internal_api_secret],
)
@fastapi_endpoint(method="POST")
async def api_create_build_sandbox(
    request: dict[str, object],
    authorization: str | None = Header(None),
    x_trace_id: str | None = Header(None),
    x_request_id: str | None = Header(None),
) -> dict:
    """Create a dormant provider-session build sandbox."""
    start_time = time.time()
    http_status = 200
    outcome = "success"
    build_id = request.get("build_id")
    provider_session_id = None

    require_auth(authorization)

    try:
        from .sandbox.build_session import (
            DEFAULT_BUILD_TIMEOUT_SECONDS,
            MAX_BUILD_TIMEOUT_SECONDS,
            ModalBuildSessionService,
        )

        parsed_request = _parse_request(CreateBuildSandboxRequest, request)
        build_id = parsed_request.build_id
        scope_kind = parsed_request.scope_kind
        scope_id = parsed_request.scope_id
        if scope_kind not in {"repo", "environment"}:
            raise HTTPException(status_code=400, detail="scope_kind must be repo or environment")
        repositories = _validated_build_repositories(parsed_request.repositories)
        build_execution_timeout_seconds = _validated_timeout_seconds(
            parsed_request.build_execution_timeout_seconds,
            default_seconds=DEFAULT_BUILD_TIMEOUT_SECONDS,
            max_seconds=MAX_BUILD_TIMEOUT_SECONDS,
        )
        provider_session_timeout_seconds = _validated_timeout_seconds(
            parsed_request.provider_session_timeout_seconds,
            default_seconds=(
                DEFAULT_BUILD_TIMEOUT_SECONDS + IMAGE_BUILD_FINALIZATION_GRACE_SECONDS
            ),
            max_seconds=MAX_BUILD_TIMEOUT_SECONDS + IMAGE_BUILD_FINALIZATION_GRACE_SECONDS,
        )
        clone_host = parsed_request.clone_host or None
        clone_username = parsed_request.clone_username or None
        callback_url = parsed_request.callback_url
        failure_callback_url = parsed_request.failure_callback_url
        if not validate_control_plane_url(callback_url) or not validate_control_plane_url(
            failure_callback_url
        ):
            raise HTTPException(
                status_code=400, detail="callback URLs must target the control plane"
            )

        provider_session_id = await ModalBuildSessionService().create(
            build_id=build_id,
            scope_kind=scope_kind,
            scope_id=scope_id,
            repositories=repositories,
            callback_url=callback_url,
            failure_callback_url=failure_callback_url,
            clone_token=parsed_request.clone_token or "",
            clone_host=clone_host,
            clone_username=clone_username,
            user_env_vars=parsed_request.user_env_vars or None,
            build_execution_timeout_seconds=build_execution_timeout_seconds,
            timeout_seconds=provider_session_timeout_seconds,
        )
        return {
            "success": True,
            "data": {"provider_session_id": provider_session_id},
        }
    except HTTPException as e:
        outcome = "error"
        http_status = e.status_code
        raise
    except Exception as e:
        outcome = "error"
        http_status = 500
        log.error("api.error", exc=e, endpoint_name="api_create_build_sandbox")
        return {"success": False, "error": str(e)}
    finally:
        _log_build_http_request(
            start_time=start_time,
            http_path="/api_create_build_sandbox",
            http_status=http_status,
            outcome=outcome,
            endpoint_name="api_create_build_sandbox",
            trace_id=x_trace_id,
            request_id=x_request_id,
            build_id=build_id,
            provider_session_id=provider_session_id,
        )


@app.function(image=function_image, secrets=[internal_api_secret])
@fastapi_endpoint(method="POST")
async def api_start_build_sandbox(
    request: dict[str, object],
    authorization: str | None = Header(None),
    x_trace_id: str | None = Header(None),
    x_request_id: str | None = Header(None),
) -> dict:
    """Start a build only after its provider session is bound in D1."""
    start_time = time.time()
    http_status = 200
    outcome = "success"
    build_id = request.get("build_id")
    provider_session_id = request.get("provider_session_id")

    require_auth(authorization)

    try:
        from .sandbox.build_session import ModalBuildSessionService

        parsed_request = _parse_request(StartBuildSandboxRequest, request)
        build_id = parsed_request.build_id
        provider_session_id = parsed_request.provider_session_id
        await ModalBuildSessionService().start(
            build_id=build_id,
            provider_session_id=provider_session_id,
            callback_token=parsed_request.callback_token,
        )
        return {"success": True, "data": {"started": True}}
    except HTTPException as e:
        outcome = "error"
        http_status = e.status_code
        raise
    except Exception as e:
        outcome = "error"
        http_status = 500
        log.error("api.error", exc=e, endpoint_name="api_start_build_sandbox")
        return {"success": False, "error": str(e)}
    finally:
        _log_build_http_request(
            start_time=start_time,
            http_path="/api_start_build_sandbox",
            http_status=http_status,
            outcome=outcome,
            endpoint_name="api_start_build_sandbox",
            trace_id=x_trace_id,
            request_id=x_request_id,
            build_id=build_id,
            provider_session_id=provider_session_id,
        )


@app.function(image=function_image, secrets=[internal_api_secret])
@fastapi_endpoint(method="POST")
async def api_terminate_build_sandbox(
    request: dict[str, object],
    authorization: str | None = Header(None),
    x_trace_id: str | None = Header(None),
    x_request_id: str | None = Header(None),
) -> dict:
    """Terminate the exactly tagged provider-session build sandbox."""
    start_time = time.time()
    http_status = 200
    outcome = "success"
    build_id = request.get("build_id")
    provider_session_id = request.get("provider_session_id")

    require_auth(authorization)

    try:
        from .sandbox.build_session import ModalBuildSessionService

        parsed_request = _parse_request(TerminateBuildSandboxRequest, request)
        build_id = parsed_request.build_id
        provider_session_id = parsed_request.provider_session_id
        await ModalBuildSessionService().terminate(
            build_id=build_id,
            provider_session_id=provider_session_id,
            reason=parsed_request.reason,
        )
        return {"success": True, "data": {"terminated": True}}
    except HTTPException as e:
        outcome = "error"
        http_status = e.status_code
        raise
    except Exception as e:
        outcome = "error"
        http_status = 500
        log.error("api.error", exc=e, endpoint_name="api_terminate_build_sandbox")
        return {"success": False, "error": str(e)}
    finally:
        _log_build_http_request(
            start_time=start_time,
            http_path="/api_terminate_build_sandbox",
            http_status=http_status,
            outcome=outcome,
            endpoint_name="api_terminate_build_sandbox",
            trace_id=x_trace_id,
            request_id=x_request_id,
            build_id=build_id,
            provider_session_id=provider_session_id,
        )


def _log_build_http_request(
    *,
    start_time: float,
    http_path: str,
    http_status: int,
    outcome: str,
    endpoint_name: str,
    trace_id: str | None,
    request_id: str | None,
    build_id: object,
    provider_session_id: object,
) -> None:
    log.info(
        "modal.http_request",
        http_method="POST",
        http_path=http_path,
        http_status=http_status,
        duration_ms=int((time.time() - start_time) * 1000),
        outcome=outcome,
        endpoint_name=endpoint_name,
        trace_id=trace_id,
        request_id=request_id,
        build_id=build_id,
        sandbox_id=provider_session_id,
    )


def _validated_timeout_seconds(
    value: int | None,
    *,
    default_seconds: int,
    max_seconds: int,
) -> int:
    if value is None:
        return default_seconds
    return min(max_seconds, max(1, value))


def _validated_build_repositories(
    value: list[BuildRepositoryRequest],
) -> list[dict[str, str]]:
    if not value:
        raise HTTPException(status_code=400, detail="repositories must be a non-empty list")

    request_repositories = [entry.model_dump(exclude_none=True) for entry in value]
    try:
        repositories = parse_repositories(
            {"repositories": request_repositories},
            workspace_path=Path("/workspace"),
        )
    except RepoConfigError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    if len(repositories) != len(value):
        raise HTTPException(
            status_code=400,
            detail="repositories entries require repo_owner, repo_name, and branch",
        )
    return [
        {
            "repo_owner": repository.owner,
            "repo_name": repository.name,
            "branch": repository.branch,
            **({"base_sha": repository.base_sha} if repository.base_sha else {}),
        }
        for repository in repositories
    ]


@app.function(
    image=function_image,
    secrets=[internal_api_secret],
)
@fastapi_endpoint(method="POST")
async def api_delete_provider_image(
    request: dict[str, object],
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

    try:
        parsed_request = _parse_request(DeleteProviderImageRequest, request)
        provider_image_id = parsed_request.provider_image_id

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
