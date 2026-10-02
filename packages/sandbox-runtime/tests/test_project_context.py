"""Provider-independent snapshot transport, budget, and restore cleanup contracts."""

import os
from types import SimpleNamespace

import httpx
import pytest

from sandbox_runtime.project_context import prepare_project_context
from sandbox_runtime.types import SessionConfig


def config(project=True):
    return SimpleNamespace(
        control_plane_url="https://control.test",
        session_id="session/one",
        sandbox_token="bound-token",
        session_config={"project": {"id": "p"}} if project else {},
    )


@pytest.mark.asyncio
async def test_fetches_bound_snapshot_and_enables_tools(tmp_path, monkeypatch):
    monkeypatch.delenv("AGENT_PROJECT_CONTEXT_ENABLED", raising=False)

    def respond(request):
        assert (
            str(request.url)
            == "https://control.test/sessions/session%2Fone/project-context?part=injection"
        )
        assert request.headers["Authorization"] == "Bearer bound-token"
        return httpx.Response(200, json={"text": "untrusted project data"})

    path = tmp_path / "context.md"
    await prepare_project_context(config(), transport=httpx.MockTransport(respond), path=path)
    assert path.read_text() == "untrusted project data"
    assert os.environ["AGENT_PROJECT_CONTEXT_ENABLED"] == "true"


@pytest.mark.asyncio
async def test_children_get_tool_without_injection_and_unassigned_restores_clear_stale_files(
    tmp_path, monkeypatch
):
    monkeypatch.setenv("AGENT_PROJECT_CONTEXT_ENABLED", "true")
    path = tmp_path / "context.md"
    path.write_text("previous session")
    await prepare_project_context(
        config(),
        transport=httpx.MockTransport(lambda _: httpx.Response(200, json={"text": ""})),
        path=path,
    )
    assert not path.exists()
    assert os.environ["AGENT_PROJECT_CONTEXT_ENABLED"] == "true"
    await prepare_project_context(config(False), path=path)
    assert "AGENT_PROJECT_CONTEXT_ENABLED" not in os.environ


@pytest.mark.asyncio
async def test_failed_or_oversized_fetch_never_keeps_old_context(tmp_path, monkeypatch):
    monkeypatch.setenv("AGENT_PROJECT_CONTEXT_ENABLED", "true")
    path = tmp_path / "context.md"
    path.write_text("stale")
    with pytest.raises(ValueError, match="Invalid project context"):
        await prepare_project_context(
            config(),
            transport=httpx.MockTransport(
                lambda _: httpx.Response(200, json={"text": "🦊" * 4000})
            ),
            path=path,
        )
    assert not path.exists()
    assert "AGENT_PROJECT_CONTEXT_ENABLED" not in os.environ
    with pytest.raises(httpx.HTTPStatusError):
        await prepare_project_context(
            config(), transport=httpx.MockTransport(lambda _: httpx.Response(403)), path=path
        )


def test_provider_session_config_preserves_project():
    project = {"id": "p", "slug": "billing", "injectionBytes": 10}
    assert SessionConfig(session_id="s", project=project).model_dump()["project"] == project


@pytest.mark.asyncio
async def test_removed_project_keeps_original_snapshot_but_disables_live_tool(
    tmp_path, monkeypatch
):
    monkeypatch.setenv("AGENT_PROJECT_CONTEXT_ENABLED", "true")
    removed = config()
    removed.session_config["project"]["toolEnabled"] = False
    path = tmp_path / "context.md"
    await prepare_project_context(
        removed,
        transport=httpx.MockTransport(
            lambda _: httpx.Response(200, json={"text": "Original snapshot"})
        ),
        path=path,
    )
    assert path.read_text() == "Original snapshot"
    assert "AGENT_PROJECT_CONTEXT_ENABLED" not in os.environ
    assert os.environ["AGENT_PROJECT_SNAPSHOT_READY"] == "true"
