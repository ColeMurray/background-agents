"""Frozen pre-handoff Modal restore schema contract from 19e7993."""

from typing import Annotated, Any

import pytest
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from src.sandbox.launch_policy import ModalBackend
from src.web_api import RestoreSessionConfigRequest


class _OldModalRequestModel(BaseModel):
    model_config = ConfigDict(extra="ignore", strict=True)


NonEmptyString = Annotated[str, Field(min_length=1)]


class OldRestoreSandboxRequest(_OldModalRequestModel):
    # Freeze the original top-level shape, rather than derive it from today's model.
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
    sandbox_backend: ModalBackend = "modal"
    retire_sandbox_id: str | None = None
    launch_deadline_at_ms: int | None = Field(default=None, gt=0)


@pytest.mark.parametrize(
    "clone_fields",
    [
        {
            "clone_token": "provided-token",
            "clone_host": "gitlab.example",
            "clone_username": "oauth2",
        },
        {"clone_token": None, "clone_host": "gitlab.example", "clone_username": "oauth2"},
        {"clone_token": None, "clone_host": None, "clone_username": None},
    ],
)
@pytest.mark.parametrize(
    "repo_fields",
    [{"repo_owner": "acme", "repo_name": "repo"}, {"repo_owner": None, "repo_name": None}],
)
def test_new_worker_restore_fields_are_ignored_by_old_modal(clone_fields, repo_fields):
    legacy_request = {
        "snapshot_image_id": "im-snapshot",
        "session_config": {"session_id": "sess-1", **repo_fields},
        "control_plane_url": "https://control-plane.example",
        "sandbox_auth_token": "sandbox-token",
    }

    parsed = OldRestoreSandboxRequest.model_validate({**legacy_request, **clone_fields})

    assert parsed.model_dump(exclude_unset=True) == legacy_request
    assert parsed.model_fields_set.isdisjoint(clone_fields)


def test_old_modal_restore_contract_remains_strict():
    with pytest.raises(ValidationError):
        OldRestoreSandboxRequest.model_validate(
            {
                "snapshot_image_id": "im-snapshot",
                "session_config": {"session_id": "sess-1"},
                "control_plane_url": "https://control-plane.example",
                "sandbox_auth_token": "sandbox-token",
                "code_server_enabled": "false",
            }
        )
