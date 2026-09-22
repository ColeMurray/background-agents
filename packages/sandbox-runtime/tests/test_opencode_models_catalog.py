import json
from unittest.mock import MagicMock

import httpx
import pytest

from sandbox_runtime.opencode_models_catalog import (
    CATALOG_OVERRIDE_ENV_VARS,
    OPENCODE_MODELS_URL,
    OpenCodeModelsCatalog,
    is_models_catalog,
    resolve_opencode_models_cache_path,
)

CATALOG = {
    "openai": {"id": "openai", "models": {"gpt-6-sol": {"id": "gpt-6-sol"}}},
    "anthropic": {"id": "anthropic", "models": {}},
}


@pytest.fixture(autouse=True)
def default_catalog_environment(monkeypatch):
    for name in CATALOG_OVERRIDE_ENV_VARS:
        monkeypatch.delenv(name, raising=False)


def _catalog(path, handler):
    requests = []

    def record(request):
        requests.append(request)
        return handler(request)

    log = MagicMock()
    catalog = OpenCodeModelsCatalog(log, path=path, transport=httpx.MockTransport(record))
    return catalog, log, requests


async def test_refresh_replaces_the_cached_catalog(tmp_path):
    path = tmp_path / "opencode" / "models.json"
    body = json.dumps(CATALOG).encode()
    catalog, log, requests = _catalog(path, lambda _request: httpx.Response(200, content=body))

    assert await catalog.refresh() is True

    assert [str(request.url) for request in requests] == [OPENCODE_MODELS_URL]
    assert path.read_bytes() == body
    assert list(path.parent.iterdir()) == [path]
    log.info.assert_called_once_with(
        "opencode_models.refreshed", path=str(path), size_bytes=len(body)
    )


@pytest.mark.parametrize(
    "response",
    [
        httpx.Response(503, json=CATALOG),
        httpx.Response(200, text="<html>maintenance</html>"),
        httpx.Response(200, json={}),
        httpx.Response(200, json={"openai": {"id": "openai"}}),
        httpx.Response(200, json=[CATALOG]),
    ],
    ids=["http-error", "not-json", "empty", "provider-without-models", "not-an-object"],
)
async def test_failed_refresh_keeps_the_existing_catalog(tmp_path, response):
    path = tmp_path / "models.json"
    path.write_text("previous")
    catalog, log, _requests = _catalog(path, lambda _request: response)

    assert await catalog.refresh() is False

    assert path.read_text() == "previous"
    assert list(tmp_path.iterdir()) == [path]
    assert log.warn.call_args.args == ("opencode_models.refresh_failed",)


async def test_unreachable_catalog_is_not_fatal(tmp_path):
    path = tmp_path / "models.json"

    def unreachable(request):
        raise httpx.ConnectError("unreachable", request=request)

    catalog, _log, _requests = _catalog(path, unreachable)

    assert await catalog.refresh() is False
    assert not path.exists()


@pytest.mark.parametrize("name", CATALOG_OVERRIDE_ENV_VARS)
async def test_operator_catalog_override_skips_the_refresh(tmp_path, monkeypatch, name):
    monkeypatch.setenv(name, "1")
    catalog, log, requests = _catalog(
        tmp_path / "models.json", lambda _request: httpx.Response(200, json=CATALOG)
    )

    assert await catalog.refresh() is False

    assert requests == []
    assert not (tmp_path / "models.json").exists()
    log.info.assert_called_once_with("opencode_models.refresh_skipped", reason=name)


def test_cache_path_follows_xdg_cache_home(tmp_path, monkeypatch):
    monkeypatch.setenv("XDG_CACHE_HOME", str(tmp_path / "xdg"))

    assert resolve_opencode_models_cache_path() == tmp_path / "xdg" / "opencode" / "models.json"


def test_cache_path_defaults_to_home_cache(tmp_path, monkeypatch):
    monkeypatch.delenv("XDG_CACHE_HOME", raising=False)
    monkeypatch.setenv("HOME", str(tmp_path))

    assert resolve_opencode_models_cache_path() == tmp_path / ".cache" / "opencode" / "models.json"


def test_catalog_shape():
    assert is_models_catalog(CATALOG)
    assert not is_models_catalog({})
    assert not is_models_catalog({"openai": {"models": []}})
    assert not is_models_catalog({"openai": "models"})
