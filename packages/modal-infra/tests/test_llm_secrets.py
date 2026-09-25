"""No LLM API key is required to launch a sandbox.

The `llm-api-keys` secret carries whichever providers the deployment configured,
and a deployment that configured none holds empty values rather than a key. It is
attached to every sandbox either way, so nothing asserts a particular provider's
key is present.
"""

import pytest

from src.sandbox.manager import SandboxConfig, SandboxManager


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


async def test_create_attaches_the_deployment_wide_secret(captured_launch, fake_llm_secret):
    await SandboxManager().create_sandbox(SandboxConfig(repo_owner="acme", repo_name="repo"))

    assert len(fake_llm_secret) == 1
    assert captured_launch["secrets"] == fake_llm_secret
    fake_llm_secret[0].hydrate.aio.assert_awaited_once_with()


async def test_restore_attaches_the_deployment_wide_secret(
    captured_launch, monkeypatch, fake_llm_secret
):
    class FakeImage:
        object_id = "img-llm-secrets"

    monkeypatch.setattr("src.sandbox.manager.modal.Image.from_id", lambda *a, **k: FakeImage())

    await SandboxManager().restore_from_snapshot(
        snapshot_image_id="img-abc",
        session_config={"repo_owner": "acme", "repo_name": "repo", "session_id": "sess-1"},
    )

    assert len(fake_llm_secret) == 1
    assert captured_launch["secrets"] == fake_llm_secret
    fake_llm_secret[0].hydrate.aio.assert_awaited_once_with()


async def test_each_launch_resolves_a_fresh_secret(captured_launch, fake_llm_secret):
    config = SandboxConfig(repo_owner="acme", repo_name="repo")
    await SandboxManager().create_sandbox(config)
    first_secret = captured_launch["secrets"][0]
    await SandboxManager().create_sandbox(config)

    assert len(fake_llm_secret) == 2
    assert captured_launch["secrets"] == [fake_llm_secret[1]]
    assert fake_llm_secret[1] is not first_secret
    for secret in fake_llm_secret:
        secret.hydrate.aio.assert_awaited_once_with()
