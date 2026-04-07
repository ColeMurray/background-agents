"""Daytona service operations for Open-Inspect sandboxes."""

from __future__ import annotations

import json
import os
import time
from typing import Any

from daytona import CreateSandboxFromSnapshotParams, Daytona, DaytonaConfig, DaytonaNotFoundError
from pydantic import BaseModel, ConfigDict, Field

from .auth import derive_code_server_password
from .config import (
    CODE_SERVER_PORT,
    DaytonaServiceConfig,
    load_config,
    resolve_preview_expiry_seconds,
    resolve_tunnel_ports,
    validate_control_plane_url,
)
from .github_app import generate_installation_token


def to_camel(value: str) -> str:
    """Convert snake_case field names to camelCase for the HTTP contract."""
    head, *tail = value.split("_")
    return head + "".join(part.capitalize() for part in tail)


class DaytonaRequestModel(BaseModel):
    """Base request model that accepts the camelCase control-plane payload."""

    model_config = ConfigDict(populate_by_name=True, alias_generator=to_camel)


class CreateSandboxRequest(DaytonaRequestModel):
    """Create a fresh Daytona sandbox from the configured base snapshot."""

    session_id: str
    sandbox_id: str
    repo_owner: str
    repo_name: str
    control_plane_url: str
    sandbox_auth_token: str
    provider: str
    model: str
    user_env_vars: dict[str, str] | None = None
    timeout_seconds: int | None = None
    branch: str | None = None
    code_server_enabled: bool = False
    sandbox_settings: dict[str, Any] | None = None


class ResumeSandboxRequest(DaytonaRequestModel):
    """Resume an existing Daytona sandbox in place."""

    provider_object_id: str
    session_id: str
    sandbox_id: str
    timeout_seconds: int | None = None
    code_server_enabled: bool = False
    sandbox_settings: dict[str, Any] | None = None


class StopSandboxRequest(DaytonaRequestModel):
    """Stop an existing Daytona sandbox."""

    provider_object_id: str
    session_id: str
    reason: str = Field(min_length=1)


class DaytonaSandboxService:
    """Thin adapter around the Daytona SDK for control-plane lifecycle calls."""

    def __init__(self, config: DaytonaServiceConfig | None = None):
        self.config = config or load_config()

    def _client(self) -> Daytona:
        return Daytona(
            DaytonaConfig(
                api_key=self.config.api_key,
                api_url=self.config.api_url,
                target=self.config.target,
            )
        )

    def _resolve_clone_token(self) -> str | None:
        if self.config.scm_provider == "gitlab":
            return os.environ.get("GITLAB_ACCESS_TOKEN")

        if {
            "GITHUB_APP_ID",
            "GITHUB_APP_PRIVATE_KEY",
            "GITHUB_APP_INSTALLATION_ID",
        }.issubset(os.environ):
            return generate_installation_token()

        return None

    def _build_env(self, request: CreateSandboxRequest) -> dict[str, str]:
        clone_token = self._resolve_clone_token()
        env_vars = dict(request.user_env_vars or {})
        session_config = {
            "session_id": request.session_id,
            "repo_owner": request.repo_owner,
            "repo_name": request.repo_name,
            "provider": request.provider,
            "model": request.model,
        }
        if request.branch:
            session_config["branch"] = request.branch

        env_vars.update(
            {
                "PYTHONUNBUFFERED": "1",
                "SANDBOX_ID": request.sandbox_id,
                "CONTROL_PLANE_URL": request.control_plane_url,
                "SANDBOX_AUTH_TOKEN": request.sandbox_auth_token,
                "REPO_OWNER": request.repo_owner,
                "REPO_NAME": request.repo_name,
                "SESSION_CONFIG": json.dumps(session_config),
            }
        )

        if request.code_server_enabled:
            env_vars["CODE_SERVER_PASSWORD"] = derive_code_server_password(request.sandbox_id)

        if self.config.scm_provider == "gitlab":
            env_vars["VCS_HOST"] = "gitlab.com"
            env_vars["VCS_CLONE_USERNAME"] = "oauth2"
        else:
            env_vars["VCS_HOST"] = "github.com"
            env_vars["VCS_CLONE_USERNAME"] = "x-access-token"

        if clone_token:
            env_vars["VCS_CLONE_TOKEN"] = clone_token
            if self.config.scm_provider == "github":
                env_vars["GITHUB_APP_TOKEN"] = clone_token
                env_vars["GITHUB_TOKEN"] = clone_token

        return env_vars

    def _build_labels(self, request: CreateSandboxRequest) -> dict[str, str]:
        return {
            "openinspect_framework": "open-inspect",
            "openinspect_session_id": request.session_id,
            "openinspect_repo": f"{request.repo_owner}/{request.repo_name}",
            "openinspect_expected_sandbox_id": request.sandbox_id,
        }

    def _build_tunnel_urls(
        self,
        sandbox: Any,
        timeout_seconds: int | None,
        code_server_enabled: bool,
        sandbox_settings: dict[str, Any] | None,
        logical_sandbox_id: str,
    ) -> tuple[str | None, str | None, dict[str, str] | None]:
        expiry_seconds = resolve_preview_expiry_seconds(timeout_seconds)
        tunnel_ports = resolve_tunnel_ports((sandbox_settings or {}).get("tunnelPorts"))
        code_server_url: str | None = None
        code_server_password: str | None = None

        if code_server_enabled:
            code_server_url = sandbox.create_signed_preview_url(
                CODE_SERVER_PORT,
                expires_in_seconds=expiry_seconds,
            ).url
            code_server_password = derive_code_server_password(logical_sandbox_id)
            tunnel_ports = [port for port in tunnel_ports if port != CODE_SERVER_PORT]

        tunnel_urls: dict[str, str] | None = None
        if tunnel_ports:
            tunnel_urls = {
                str(port): sandbox.create_signed_preview_url(
                    port,
                    expires_in_seconds=expiry_seconds,
                ).url
                for port in tunnel_ports
            }

        return code_server_url, code_server_password, tunnel_urls

    def create_sandbox(self, request: CreateSandboxRequest) -> dict[str, Any]:
        """Create a fresh Daytona sandbox from the repo-local base snapshot."""
        validate_control_plane_url(request.control_plane_url)

        client = self._client()
        sandbox = client.create(
            CreateSandboxFromSnapshotParams(
                name=request.sandbox_id,
                snapshot=self.config.base_snapshot,
                env_vars=self._build_env(request),
                labels=self._build_labels(request),
                auto_stop_interval=self.config.auto_stop_interval_minutes,
                auto_archive_interval=self.config.auto_archive_interval_minutes,
                public=False,
            )
        )

        code_server_url, code_server_password, tunnel_urls = self._build_tunnel_urls(
            sandbox,
            request.timeout_seconds,
            request.code_server_enabled,
            request.sandbox_settings,
            request.sandbox_id,
        )

        return {
            "sandboxId": request.sandbox_id,
            "providerObjectId": sandbox.id,
            "status": str(sandbox.state),
            "createdAt": int(time.time() * 1000),
            "codeServerUrl": code_server_url,
            "codeServerPassword": code_server_password,
            "tunnelUrls": tunnel_urls,
        }

    def resume_sandbox(self, request: ResumeSandboxRequest) -> dict[str, Any]:
        """Resume or recover a stopped Daytona sandbox."""
        client = self._client()

        try:
            sandbox = client.get(request.provider_object_id)
            if str(sandbox.state) in {"error", "build_failed"} and sandbox.recoverable:
                sandbox.recover()
            elif str(sandbox.state) != "started":
                sandbox.start()
            else:
                sandbox.refresh_data()
        except DaytonaNotFoundError:
            return {
                "success": False,
                "error": "Sandbox no longer exists in Daytona",
                "shouldSpawnFresh": True,
            }

        # Tunnel URL generation runs after the sandbox is started so that a
        # preview-URL failure doesn't mask a successful start.  The control
        # plane will still see the sandbox as resumed and can retry tunnels on
        # the next reconnect.
        try:
            code_server_url, code_server_password, tunnel_urls = self._build_tunnel_urls(
                sandbox,
                request.timeout_seconds,
                request.code_server_enabled,
                request.sandbox_settings,
                request.sandbox_id,
            )
        except Exception:
            code_server_url = None
            code_server_password = None
            tunnel_urls = None

        return {
            "success": True,
            "providerObjectId": sandbox.id,
            "codeServerUrl": code_server_url,
            "codeServerPassword": code_server_password,
            "tunnelUrls": tunnel_urls,
        }

    def stop_sandbox(self, request: StopSandboxRequest) -> dict[str, Any]:
        """Stop a Daytona sandbox explicitly."""
        client = self._client()

        try:
            sandbox = client.get(request.provider_object_id)
        except DaytonaNotFoundError:
            return {"success": True}

        try:
            sandbox.stop()
        except DaytonaNotFoundError:
            return {"success": True}

        return {"success": True}
