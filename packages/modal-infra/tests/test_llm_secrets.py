"""The deployment-wide LLM secret is optional.

A deployment can supply model credentials per repository through the control
plane's secret store, so sandboxes must launch whether or not the `llm-api-keys`
Modal secret exists, and whichever providers it holds.
"""

import pytest

from src.app import llm_secrets
from src.sandbox.manager import SandboxConfig, SandboxManager

from .conftest import StubSecret


@pytest.fixture
def captured_launch(monkeypatch):
    """Capture the kwargs of the next sandbox launch instead of creating one."""
    captured: dict = {}

    async def fake_create_aio(*args, **kwargs):
        captured.update(kwargs)

        class FakeSandbox:
            object_id = "obj-llm-secrets"
            stdout = None

        return FakeSandbox()

    fake_create_aio.aio = fake_create_aio
    monkeypatch.setattr("src.sandbox.manager.modal.Sandbox.create", fake_create_aio)
    return captured


async def test_configured_secret_is_attached_to_the_sandbox(
    captured_launch, configured_llm_secret: StubSecret
):
    await SandboxManager().create_sandbox(SandboxConfig(repo_owner="acme", repo_name="repo"))

    assert captured_launch["secrets"] == [configured_llm_secret]


async def test_sandbox_launches_when_no_llm_secret_is_configured(
    captured_launch, unconfigured_llm_secret: StubSecret
):
    await SandboxManager().create_sandbox(SandboxConfig(repo_owner="acme", repo_name="repo"))

    assert captured_launch["secrets"] == []


async def test_restore_launches_when_no_llm_secret_is_configured(
    captured_launch, unconfigured_llm_secret: StubSecret, monkeypatch
):
    class FakeImage:
        object_id = "img-llm-secrets"

    monkeypatch.setattr("src.sandbox.manager.modal.Image.from_id", lambda *a, **k: FakeImage())

    await SandboxManager().restore_from_snapshot(
        snapshot_image_id="img-abc",
        session_config={"repo_owner": "acme", "repo_name": "repo", "session_id": "sess-1"},
    )

    assert captured_launch["secrets"] == []


async def test_an_absent_secret_is_looked_up_once_per_container(
    unconfigured_llm_secret: StubSecret,
):
    assert await llm_secrets() == []
    assert await llm_secrets() == []

    assert unconfigured_llm_secret.hydrate.calls == 1


async def test_a_configured_secret_is_returned_on_every_call(
    configured_llm_secret: StubSecret,
):
    assert await llm_secrets() == [configured_llm_secret]
    assert await llm_secrets() == [configured_llm_secret]
