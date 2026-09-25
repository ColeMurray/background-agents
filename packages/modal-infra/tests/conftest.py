"""Register test functions with an inert image reference, without provider access."""

import importlib
import os
from unittest.mock import AsyncMock, Mock, patch

import pytest

# Production imports require a verified image. Tests mock all native operations;
# keep their declaration-only reference out of the environment used by tests.
with (
    patch("modal.is_local", return_value=False),
    patch.dict(os.environ, {"OPENINSPECT_MODAL_BASE_IMAGE_ID": "im-test-functions"}),
):
    importlib.import_module("src")


@pytest.fixture(autouse=True)
def fake_llm_secret(monkeypatch):
    """Avoid Modal RPCs for sandbox secret hydration in launch tests."""
    from modal import Secret

    original_from_name = Secret.from_name
    created = []

    def from_name(name, **kwargs):
        if name != "llm-api-keys":
            return original_from_name(name, **kwargs)
        secret = Mock()
        secret.hydrate.aio = AsyncMock()
        created.append(secret)
        return secret

    monkeypatch.setattr(Secret, "from_name", from_name)
    return created
