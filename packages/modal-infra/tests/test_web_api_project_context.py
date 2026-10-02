"""Project context survives fresh and restored sandbox launch assembly."""

import pytest

from tests.web_api_launch_helpers import (
    CREATE_REQUEST,
    RESTORE_REQUEST,
    _call_create_sandbox,
    _call_restore_sandbox,
    _patch_auth,
    _patch_manager,
    _patch_restore_manager,
)


@pytest.mark.asyncio
async def test_fresh_and_restored_launch_preserve_project_context(monkeypatch):
    captured = {}
    _patch_auth(monkeypatch)
    _patch_manager(monkeypatch, captured)
    project = {"id": "p", "slug": "billing", "injectionBytes": 123, "toolEnabled": True}
    await _call_create_sandbox({**CREATE_REQUEST, "project": project})
    assert captured["config"].session_config.project == project
    _patch_restore_manager(monkeypatch, captured)
    await _call_restore_sandbox(
        {
            **RESTORE_REQUEST,
            "session_config": {**RESTORE_REQUEST["session_config"], "project": project},
        }
    )
    assert captured["restore"]["session_config"]["project"] == project
