"""Shared fixtures for the modal-infra test suite."""

import importlib

import pytest
from modal.exception import NotFoundError

# `src/__init__.py` binds the name `app` to the App object, so `src.app` as an
# attribute is that object rather than the module the secret lives in.
app_module = importlib.import_module("src.app")


class StubHydrate:
    """Stands in for `Secret.hydrate`, a synchronicity wrapper called through `.aio`."""

    def __init__(self, error: Exception | None = None) -> None:
        self._error = error
        self.calls = 0

    async def aio(self) -> None:
        self.calls += 1
        if self._error is not None:
            raise self._error


class StubSecret:
    """A deployment-wide LLM secret that resolves, or fails with `error` when absent."""

    def __init__(self, error: Exception | None = None) -> None:
        self.hydrate = StubHydrate(error)


def _install(monkeypatch: pytest.MonkeyPatch, secret: StubSecret) -> StubSecret:
    monkeypatch.setattr(app_module, "_llm_secret", secret)
    monkeypatch.setattr(app_module, "_llm_secret_absent", False)
    return secret


@pytest.fixture(autouse=True)
def configured_llm_secret(monkeypatch: pytest.MonkeyPatch) -> StubSecret:
    """Resolve the deployment-wide LLM secret without reaching Modal.

    `llm_secrets()` hydrates the secret the first time a sandbox launches and
    caches an absent one for the life of the container, so every test starts from
    an unresolved cache and a secret that exists. Tests covering a deployment that
    configured no LLM keys ask for `unconfigured_llm_secret` instead, which
    overrides this one.
    """
    return _install(monkeypatch, StubSecret())


@pytest.fixture
def unconfigured_llm_secret(monkeypatch: pytest.MonkeyPatch) -> StubSecret:
    """Stand in for a deployment that created no deployment-wide LLM secret."""
    return _install(monkeypatch, StubSecret(NotFoundError("Secret 'llm-api-keys' not found")))
