"""Interactive launch wire contracts and direct version-to-command decoders.

Legacy compatibility stays here; this module does not import Modal or provider operations.
"""

from dataclasses import dataclass
from pathlib import Path
from typing import Annotated, Any, Literal, Self

from fastapi import HTTPException
from pydantic import AnyUrl, BaseModel, ConfigDict, Field, TypeAdapter, model_validator

from sandbox_runtime.repo_config import parse_repositories
from sandbox_runtime.types import SessionConfig

from .request_validation import ModalRequestModel, NonEmptyString, parse_request


class InteractiveRepositoryRequest(ModalRequestModel):
    repo_owner: NonEmptyString
    repo_name: NonEmptyString
    branch: str | None = None
    base_sha: str | None = None


class RestoreRepositoryRequest(InteractiveRepositoryRequest):
    model_config = ConfigDict(extra="allow", strict=True)


class _RepositoryContextModel(ModalRequestModel):
    repo_owner: str | None = None
    repo_name: str | None = None

    @model_validator(mode="after")
    def validate_repository_context(self) -> Self:
        self.repo_owner, self.repo_name = _normalize_optional_repository_context(
            self.repo_owner, self.repo_name
        )
        return self


class CreateSandboxRequest(_RepositoryContextModel):
    session_id: NonEmptyString
    sandbox_id: str | None = None
    control_plane_url: NonEmptyString
    sandbox_auth_token: NonEmptyString
    agent_session_id: str | None = None
    opencode_session_id: str | None = None
    harness: str | None = None
    provider: str | None = None
    model: str | None = None
    branch: str | None = None
    base_sha: str | None = None
    mcp_servers: list[dict[str, Any]] | None = None
    repositories: list[InteractiveRepositoryRequest] | None = None
    working_branch_name: str | None = None
    user_env_vars: dict[str, str] | None = None
    repo_image_id: str | None = None
    repo_image_sha: str | None = None
    timeout_seconds: int | None = Field(default=None, gt=0)
    code_server_enabled: bool = False
    vnc_enabled: bool | None = None
    agent_slack_notify_enabled: bool = False
    sandbox_settings: dict[str, Any] | None = None


class RestoreSessionConfigRequest(_RepositoryContextModel):
    # Snapshot SESSION_CONFIG may contain fields introduced by a newer control
    # plane, so preserve unknown nested keys while validating known launch data.
    model_config = ConfigDict(extra="allow", strict=True)

    session_id: str | None = None
    branch: str | None = None
    base_sha: str | None = None
    agent_session_id: str | None = None
    opencode_session_id: str | None = None
    harness: str | None = None
    provider: str | None = None
    model: str | None = None
    mcp_servers: list[dict[str, Any]] | None = None
    repositories: list[RestoreRepositoryRequest] | None = None
    working_branch_name: str | None = None


class RestoreSandboxRequest(ModalRequestModel):
    snapshot_image_id: NonEmptyString
    session_config: RestoreSessionConfigRequest
    sandbox_id: str | None = None
    control_plane_url: NonEmptyString
    sandbox_auth_token: NonEmptyString
    user_env_vars: dict[str, str] | None = None
    timeout_seconds: int | None = Field(default=None, gt=0)
    code_server_enabled: bool = False
    vnc_enabled: bool | None = None
    agent_slack_notify_enabled: bool = False
    sandbox_settings: dict[str, Any] | None = None


class LaunchMcpServerV1(BaseModel):
    """Validate known runtime inputs without dropping future MCP extensions."""

    model_config = ConfigDict(extra="allow", strict=True)
    name: NonEmptyString
    type: Literal["local", "remote"]
    id: NonEmptyString
    command: list[str] | None = None
    url: str | None = None
    env: dict[str, str] | None = None
    headers: dict[str, str] | None = None
    repoScopes: list[str] | None = None
    enabled: bool

    @model_validator(mode="after")
    def validate_transport(self) -> Self:
        if self.type == "local" and not self.command:
            raise ValueError("Local MCP servers require a nonempty command")
        if self.type == "remote":
            if not self.url:
                raise ValueError("Remote MCP servers require a URL")
            # Validate without rewriting a signed URL or adding a trailing slash.
            TypeAdapter(AnyUrl).validate_python(self.url)
        return self


class LaunchSessionConfigV1(_RepositoryContextModel):
    """Explicit session policy; preserve future runtime fields on both launch paths."""

    model_config = ConfigDict(extra="allow", strict=True)
    session_id: NonEmptyString
    repo_owner: str | None
    repo_name: str | None
    harness: Literal["opencode", "claude"]
    provider: NonEmptyString
    model: NonEmptyString
    branch: str | None
    mcp_servers: list[LaunchMcpServerV1]
    repositories: list[RestoreRepositoryRequest] | None
    bridge_early_connect: bool
    base_sha: str | None = None
    agent_session_id: str | None = None
    opencode_session_id: str | None = None
    working_branch_name: str | None = None

    @model_validator(mode="after")
    def validate_runtime_repositories(self) -> Self:
        # Validate both forms independently: the runtime parser otherwise returns
        # a nonempty member list without checking the scalar environment fallback.
        members = parse_repositories(
            {"repositories": [repo.model_dump() for repo in self.repositories or []]},
            workspace_path=Path("/workspace"),
        )
        scalar = parse_repositories(
            {"base_sha": self.base_sha},
            workspace_path=Path("/workspace"),
            scalar_owner=self.repo_owner or "",
            scalar_name=self.repo_name or "",
            scalar_branch=self.branch or "main",
        )
        if len(members) != len(self.repositories or []):
            raise ValueError("Repository entries require owner and name")
        if members:
            primary = members[0]
            if not scalar or (primary.owner.lower(), primary.name.lower(), primary.branch) != (
                scalar[0].owner.lower(),
                scalar[0].name.lower(),
                scalar[0].branch,
            ):
                raise ValueError("Scalar repository must match the primary member")
            if scalar[0].base_sha and scalar[0].base_sha != primary.base_sha:
                raise ValueError("Scalar revision must match the primary member")
        for repo, entry in zip(self.repositories or [], members, strict=True):
            repo.repo_owner, repo.repo_name = entry.owner, entry.name
            if "branch" in repo.model_fields_set and repo.branch is not None:
                repo.branch = entry.branch
            if "base_sha" in repo.model_fields_set:
                repo.base_sha = entry.base_sha
        return self


Port = Annotated[int, Field(ge=1, le=65535)]


class LaunchSettingsV1(BaseModel):
    """Required effective defaults. Other provider settings retain their existing semantics."""

    model_config = ConfigDict(extra="allow", strict=True)
    codeServerPort: Port
    vncPort: Port
    terminalPort: Port
    terminalEnabled: bool
    tunnelPorts: list[Port]
    cpuCores: Annotated[float, Field(gt=0, allow_inf_nan=False)] | None = None
    memoryMib: Annotated[int, Field(gt=0)] | None = None


class _LaunchRequestV1(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    contract_version: Literal[1]
    session_config: LaunchSessionConfigV1
    sandbox_id: NonEmptyString
    control_plane_url: NonEmptyString
    sandbox_auth_token: NonEmptyString
    user_env_vars: dict[str, str]
    timeout_seconds: Annotated[int, Field(gt=0)]
    code_server_enabled: bool
    vnc_enabled: bool
    agent_slack_notify_enabled: bool
    sandbox_settings: LaunchSettingsV1


class CreateSandboxV1Request(_LaunchRequestV1):
    repo_image_id: str | None
    repo_image_sha: str | None
    agent_session_id: str | None


class RestoreSandboxV1Request(_LaunchRequestV1):
    snapshot_image_id: NonEmptyString


def launch_contract_label(request: dict[str, object]) -> Literal["legacy", 1, "unsupported"]:
    if "contract_version" not in request:
        return "legacy"
    value = request["contract_version"]
    return 1 if type(value) is int and value == 1 else "unsupported"


def _launch_contract_version(request: dict[str, object]) -> Literal["legacy", 1]:
    version = launch_contract_label(request)
    if version == "unsupported":
        raise HTTPException(status_code=400, detail="Unsupported launch contract version")
    return version


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
    request: dict[str, Any], *, repo_owner: str | None, repo_name: str | None
) -> SessionConfig:
    """Build the create-path SessionConfig from the flat wire request.

    Create is a lossy reconstruction — the manager re-serializes this typed
    model into SESSION_CONFIG — while restore forwards its session_config
    dict verbatim. Wire fields share their names with SessionConfig fields,
    so the model's own field list drives the pickup: a new field only needs
    the SessionConfig change, not another line here. repo_owner/repo_name
    are set from the normalized pair, never the raw request.
    """
    fields = {
        name: request[name]
        for name in SessionConfig.model_fields
        if name in request and request[name] is not None
    }
    fields["repo_owner"] = repo_owner
    fields["repo_name"] = repo_name
    return SessionConfig(**fields)


@dataclass(frozen=True, kw_only=True)
class LaunchCommand:
    """Decoded interactive launch inputs; no wire-version logic reaches provider calls."""

    session_config: dict[str, Any]
    repo_owner: str | None
    repo_name: str | None
    sandbox_id: str | None
    control_plane_url: str
    sandbox_auth_token: str
    user_env_vars: dict[str, str] | None
    timeout_seconds: int | None
    code_server_enabled: bool
    vnc_enabled: bool | None
    agent_slack_notify_enabled: bool
    sandbox_settings: dict[str, Any] | None
    repo_image_id: str | None = None
    repo_image_sha: str | None = None
    snapshot_image_id: str | None = None


def _command(
    request: CreateSandboxRequest | RestoreSandboxRequest | _LaunchRequestV1,
    session_config: dict[str, Any],
    repo_owner: str | None,
    repo_name: str | None,
    *,
    repo_image_id: str | None = None,
    repo_image_sha: str | None = None,
    snapshot_image_id: str | None = None,
) -> LaunchCommand:
    settings = request.sandbox_settings
    return LaunchCommand(
        session_config=session_config,
        repo_owner=repo_owner,
        repo_name=repo_name,
        sandbox_id=request.sandbox_id,
        control_plane_url=request.control_plane_url,
        sandbox_auth_token=request.sandbox_auth_token,
        user_env_vars=request.user_env_vars,
        timeout_seconds=request.timeout_seconds,
        code_server_enabled=request.code_server_enabled,
        vnc_enabled=request.vnc_enabled,
        agent_slack_notify_enabled=request.agent_slack_notify_enabled,
        sandbox_settings=settings.model_dump(exclude_unset=True)
        if isinstance(settings, LaunchSettingsV1)
        else settings,
        repo_image_id=repo_image_id,
        repo_image_sha=repo_image_sha,
        snapshot_image_id=snapshot_image_id,
    )


def decode_create_launch(request: dict[str, Any]) -> LaunchCommand:
    if _launch_contract_version(request) == 1:
        v1 = parse_request(CreateSandboxV1Request, request)
        session = v1.session_config.model_dump(exclude_unset=True)
        if v1.agent_session_id:
            session["agent_session_id"] = v1.agent_session_id
        return _command(
            v1,
            session,
            v1.session_config.repo_owner,
            v1.session_config.repo_name,
            repo_image_id=v1.repo_image_id,
            repo_image_sha=v1.repo_image_sha,
        )
    legacy = parse_request(CreateSandboxRequest, request)
    session = _session_config_from_create_request(
        request,
        repo_owner=legacy.repo_owner,
        repo_name=legacy.repo_name,
    ).model_dump()
    return _command(
        legacy,
        session,
        legacy.repo_owner,
        legacy.repo_name,
        repo_image_id=legacy.repo_image_id,
        repo_image_sha=legacy.repo_image_sha,
    )


def decode_restore_launch(request: dict[str, Any]) -> LaunchCommand:
    if _launch_contract_version(request) == 1:
        parsed = parse_request(RestoreSandboxV1Request, request)
        return _command(
            parsed,
            parsed.session_config.model_dump(exclude_unset=True),
            parsed.session_config.repo_owner,
            parsed.session_config.repo_name,
            snapshot_image_id=parsed.snapshot_image_id,
        )
    legacy = parse_request(RestoreSandboxRequest, request)
    return _command(
        legacy,
        legacy.session_config.model_dump(exclude_unset=True),
        legacy.session_config.repo_owner,
        legacy.session_config.repo_name,
        snapshot_image_id=legacy.snapshot_image_id,
    )
