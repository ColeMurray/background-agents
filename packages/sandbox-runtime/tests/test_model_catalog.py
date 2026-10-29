"""Catalog publication and recovery without relying on disposable cache state."""

import asyncio
import json
import logging
import os
import stat
from pathlib import Path
from unittest.mock import MagicMock

import httpx
import pytest

from sandbox_runtime import model_catalog
from sandbox_runtime.log_config import get_logger
from sandbox_runtime.model_catalog import (
    catalog_is_usable,
    configure_model_catalog,
    ensure_model_catalog,
    validate_catalog,
)
from sandbox_runtime.model_prices import default_catalog_path

CATALOG = (Path(__file__).parent / "fixtures/reasoning-models.json").read_bytes()


def serve_catalog(monkeypatch, handler):
    client_type = httpx.AsyncClient
    monkeypatch.setattr(
        model_catalog.httpx,
        "AsyncClient",
        lambda **kwargs: client_type(transport=httpx.MockTransport(handler), **kwargs),
    )


def test_persistent_path_respects_home_and_explicit_override(tmp_path):
    environment = {"HOME": str(tmp_path), "XDG_CACHE_HOME": str(tmp_path / "cache")}
    path = configure_model_catalog(environment)
    assert path == tmp_path / ".local/share/openinspect/models.json"
    assert default_catalog_path(environment) == path
    environment["OPENCODE_MODELS_PATH"] = str(tmp_path / "custom.json")
    assert configure_model_catalog(environment) == tmp_path / "custom.json"


@pytest.mark.parametrize("previous", [None, b"{invalid", b'{"openai":{"models":{}}}'])
@pytest.mark.parametrize("override", [False, True])
async def test_startup_recovers_missing_or_invalid_prices(
    tmp_path, monkeypatch, previous, override
):
    environment = {"HOME": str(tmp_path), "OPENCODE_MODELS_URL": "https://mirror.test/"}
    if override:
        environment["OPENCODE_MODELS_PATH"] = str(tmp_path / "custom/prices.json")
    path = configure_model_catalog(environment)
    if previous is not None:
        path.parent.mkdir(parents=True)
        path.write_bytes(previous)
    requests = []

    def respond(request):
        requests.append(str(request.url))
        return httpx.Response(200, content=CATALOG)

    serve_catalog(monkeypatch, respond)
    assert await ensure_model_catalog(environment, MagicMock())
    assert requests == ["https://mirror.test/api.json"]
    assert path.read_bytes() == CATALOG
    assert catalog_is_usable(path)
    assert list(path.parent.iterdir()) == [path]


@pytest.mark.parametrize(
    ("base_path", "catalog_path"),
    [
        ("", b"/api.json"),
        ("/", b"/api.json"),
        ("/catalog", b"/catalog/api.json"),
        ("/catalog/", b"/catalog/api.json"),
        ("/catalog%2Fv1/", b"/catalog%2Fv1/api.json"),
    ],
)
@pytest.mark.parametrize(
    ("query", "fragment"),
    [
        ("token=secret", ""),
        ("token=a%2Fb%3F%26%3D&v=2&tag=one&tag=two&blank=&literal=a+b", "#catalog"),
    ],
)
async def test_catalog_fetch_appends_to_path_and_preserves_query(
    tmp_path, monkeypatch, base_path, catalog_path, query, fragment
):
    environment = {
        "HOME": str(tmp_path),
        "OPENCODE_MODELS_URL": f"https://mirror.test{base_path}?{query}{fragment}",
    }
    requests = []

    def respond(request):
        requests.append(request.url)
        assert request.url.raw_path.split(b"?", 1)[0] == catalog_path
        assert request.url.query == query.encode("ascii")
        return httpx.Response(200, content=CATALOG)

    serve_catalog(monkeypatch, respond)
    assert await ensure_model_catalog(environment, MagicMock())
    assert len(requests) == 1
    path = configure_model_catalog(environment)
    assert path.read_bytes() == CATALOG
    assert catalog_is_usable(path)


@pytest.mark.parametrize("existing", [False, True])
@pytest.mark.parametrize("failure", ["http", "network", "timeout", "invalid", "write"])
async def test_failed_refresh_preserves_old_prices_and_reports_availability(
    tmp_path, monkeypatch, existing, failure
):
    environment = {"HOME": str(tmp_path)}
    path = configure_model_catalog(environment)
    if existing:
        path.parent.mkdir(parents=True)
        path.write_bytes(CATALOG)

    async def respond(request):
        if failure == "network":
            raise httpx.ConnectError("offline", request=request)
        if failure == "timeout":
            await asyncio.sleep(1)
        return httpx.Response(
            503 if failure == "http" else 200,
            content=b"not json" if failure == "invalid" else CATALOG,
        )

    serve_catalog(monkeypatch, respond)
    if failure == "timeout":
        monkeypatch.setattr(model_catalog, "MODEL_CATALOG_FETCH_TIMEOUT_SECONDS", 0.01)
    if failure == "write":
        monkeypatch.setattr(Path, "replace", MagicMock(side_effect=OSError("disk full")))
    log = MagicMock()
    assert await ensure_model_catalog(environment, log, refresh=True) is existing
    log.warn.assert_called_once()
    if existing:
        assert path.read_bytes() == CATALOG
    else:
        assert not path.exists()
    assert not path.parent.exists() or list(path.parent.iterdir()) == ([path] if existing else [])


@pytest.mark.parametrize(
    "raw",
    [
        b"null",
        b"[]",
        b"{}",
        b'{"openai":{"models":[]}}',
        b'{"openai":{"models":{"test":{"cost":{"input":0,"output":0}}}}}',
        b'{"openai":{"models":{"test":{"cost":{"input":-1,"output":2}}}}}',
    ],
)
def test_verification_rejects_catalogs_without_usable_prices(raw):
    with pytest.raises(ValueError):
        validate_catalog(raw)


def test_check_is_offline_and_fails_for_an_absent_catalog(tmp_path, monkeypatch):
    monkeypatch.setenv("OPENCODE_MODELS_PATH", str(tmp_path / "models.json"))
    monkeypatch.setattr("sys.argv", ["model_catalog", "--check"])
    monkeypatch.setattr(model_catalog.httpx, "AsyncClient", MagicMock(side_effect=AssertionError))
    with pytest.raises(SystemExit, match="Model price catalog unavailable"):
        model_catalog.main()
    (tmp_path / "models.json").write_bytes(CATALOG)
    model_catalog.main()


async def test_invalid_source_is_nonfatal(tmp_path):
    log = MagicMock()
    environment = {"HOME": str(tmp_path), "OPENCODE_MODELS_URL": "https://models.test:not-a-port"}
    assert not await ensure_model_catalog(environment, log)
    assert log.warn.call_args.kwargs["error_type"] == "InvalidURL"
    assert "exc" not in log.warn.call_args.kwargs


@pytest.mark.parametrize("outcome", ["success", "status", "network"])
async def test_catalog_url_credentials_do_not_reach_logs(tmp_path, monkeypatch, caplog, outcome):
    source = "https://catalog-user:catalog-password@mirror.test/path-secret?token=query-secret"
    environment = {"HOME": str(tmp_path), "OPENCODE_MODELS_URL": source}

    def respond(request):
        if outcome == "network":
            raise httpx.ConnectError(f"Cannot connect to {request.url}", request=request)
        return httpx.Response(503 if outcome == "status" else 200, content=CATALOG)

    serve_catalog(monkeypatch, respond)
    previous_filters = list(logging.getLogger("httpx").filters)
    with caplog.at_level(logging.INFO):
        assert await ensure_model_catalog(environment, get_logger("catalog_test")) is (
            outcome == "success"
        )
    assert logging.getLogger("httpx").filters == previous_filters
    for secret in ("catalog-user", "catalog-password", "path-secret", "query-secret"):
        assert secret not in caplog.text
    assert not any(record.name == "httpx" for record in caplog.records)
    if outcome != "success":
        [failure] = [r for r in caplog.records if r.message == "model_catalog.refresh_failed"]
        assert failure.exc_info is None
        assert failure.error_type == ("HTTPStatusError" if outcome == "status" else "ConnectError")
        assert failure.status_code == (503 if outcome == "status" else None)


async def test_catalog_fetch_does_not_mute_other_httpx_requests(tmp_path, monkeypatch, caplog):
    started, release = asyncio.Event(), asyncio.Event()

    async def respond(request):
        if request.url.host == "mirror.test":
            started.set()
            await release.wait()
        return httpx.Response(200, content=CATALOG)

    serve_catalog(monkeypatch, respond)
    environment = {"HOME": str(tmp_path), "OPENCODE_MODELS_URL": "https://mirror.test/secret"}
    with caplog.at_level(logging.INFO):
        fetch = asyncio.create_task(ensure_model_catalog(environment, get_logger("catalog_test")))
        try:
            await asyncio.wait_for(started.wait(), 1)
            async with httpx.AsyncClient() as client:
                await client.get("https://other.test/during")
        finally:
            release.set()
            assert await fetch
        async with httpx.AsyncClient() as client:
            await client.get("https://other.test/after")
    assert "https://other.test/during" in caplog.text
    assert "https://other.test/after" in caplog.text
    assert "https://mirror.test/secret" not in caplog.text


async def test_relative_override_is_shared_across_working_directories(tmp_path, monkeypatch):
    supervisor, repository = tmp_path / "supervisor", tmp_path / "repo"
    supervisor.mkdir()
    repository.mkdir()
    monkeypatch.chdir(supervisor)
    environment = {"OPENCODE_MODELS_PATH": "models.json"}
    path = configure_model_catalog(environment)
    assert path == supervisor / "models.json"
    assert environment["OPENCODE_MODELS_PATH"] == str(path)
    serve_catalog(monkeypatch, lambda _: httpx.Response(200, content=CATALOG))
    assert await ensure_model_catalog(environment, MagicMock())

    monkeypatch.chdir(repository)
    monkeypatch.setattr(model_catalog.httpx, "AsyncClient", MagicMock(side_effect=AssertionError))
    assert await ensure_model_catalog(environment, MagicMock())
    assert default_catalog_path(environment) == path
    assert Path(environment["OPENCODE_MODELS_PATH"]).read_bytes() == CATALOG
    assert not (repository / "models.json").exists()


async def test_publication_syncs_private_file_before_replace_and_directory_after(
    tmp_path, monkeypatch
):
    environment = {"HOME": str(tmp_path)}
    path = configure_model_catalog(environment)
    path.parent.mkdir(parents=True)
    path.write_bytes(CATALOG)
    replacement = CATALOG + b"\n"
    serve_catalog(monkeypatch, lambda _: httpx.Response(200, content=replacement))
    synced = []
    real_fsync = os.fsync

    def fsync(descriptor):
        if stat.S_ISDIR(os.fstat(descriptor).st_mode):
            synced.append("directory")
            assert path.read_bytes() == replacement
        else:
            synced.append("file")
            assert path.read_bytes() == CATALOG
        real_fsync(descriptor)

    monkeypatch.setattr(os, "fsync", fsync)
    assert await ensure_model_catalog(environment, MagicMock(), refresh=True)
    assert synced == ["file", "directory"]
    assert stat.S_IMODE(path.stat().st_mode) == 0o600
    assert list(path.parent.iterdir()) == [path]


async def test_custom_source_does_not_reuse_baked_default_catalog(tmp_path, monkeypatch):
    default_path = configure_model_catalog({"HOME": str(tmp_path)})
    default_path.parent.mkdir(parents=True)
    default_path.write_bytes(CATALOG)
    custom_catalog = json.loads(CATALOG)
    custom_catalog["openai"]["models"]["gpt-6.1-sol"]["cost"]["input"] = 9
    replacement = json.dumps(custom_catalog).encode("utf-8")
    requests = []

    def respond(request):
        requests.append(str(request.url))
        return httpx.Response(200, content=replacement)

    serve_catalog(monkeypatch, respond)
    environment = {"HOME": str(tmp_path), "OPENCODE_MODELS_URL": "https://mirror.test"}
    assert await ensure_model_catalog(environment, MagicMock())
    custom_path = configure_model_catalog(environment)
    assert custom_path != default_path
    assert custom_path.read_bytes() == replacement
    assert default_path.read_bytes() == CATALOG
    assert requests == ["https://mirror.test/api.json"]

    # A new boot reuses only this source's persisted catalog without a request.
    restored = {"HOME": str(tmp_path), "OPENCODE_MODELS_URL": "https://mirror.test"}
    assert await ensure_model_catalog(restored, MagicMock())
    assert configure_model_catalog(restored) == custom_path
    assert requests == ["https://mirror.test/api.json"]
    assert configure_model_catalog({"HOME": str(tmp_path)}) == default_path


def test_explicit_path_remains_authoritative_for_custom_sources(tmp_path):
    path = tmp_path / "custom.json"
    for source in ("https://mirror.test/one", "https://mirror.test/two"):
        environment = {"OPENCODE_MODELS_PATH": str(path), "OPENCODE_MODELS_URL": source}
        assert configure_model_catalog(environment) == path


@pytest.mark.parametrize(
    "invalid",
    [
        CATALOG.replace(b'"input": 2', b'"input": NaN', 1),
        CATALOG.replace(b'"input": 2', b'"input": Infinity', 1),
        CATALOG.replace(b'"input": 2', b'"input": -Infinity', 1),
        CATALOG.decode("utf-8").encode("utf-16"),
        CATALOG.decode("utf-8").encode("utf-32"),
        b"\xef\xbb\xbf" + CATALOG,
    ],
    ids=["nan", "infinity", "negative_infinity", "utf16", "utf32", "utf8_bom"],
)
async def test_nonstandard_json_cannot_replace_usable_prices(tmp_path, monkeypatch, invalid):
    environment = {"HOME": str(tmp_path)}
    path = configure_model_catalog(environment)
    path.parent.mkdir(parents=True)
    path.write_bytes(invalid)
    assert not catalog_is_usable(path)
    path.write_bytes(CATALOG)
    serve_catalog(monkeypatch, lambda _: httpx.Response(200, content=invalid))

    log = MagicMock()
    assert await ensure_model_catalog(environment, log, refresh=True)
    log.warn.assert_called_once()
    assert path.read_bytes() == CATALOG
    assert catalog_is_usable(path)


async def test_redirect_to_valid_catalog_is_followed(tmp_path, monkeypatch, caplog):
    requests = []

    def respond(request):
        requests.append(str(request.url))
        if len(requests) == 1:
            return httpx.Response(
                302, headers={"Location": "https://cdn.test/catalog?token=secret"}
            )
        return httpx.Response(200, content=CATALOG)

    serve_catalog(monkeypatch, respond)
    environment = {"HOME": str(tmp_path)}
    with caplog.at_level(logging.INFO):
        assert await ensure_model_catalog(environment, MagicMock())
    assert requests == [
        "https://models.opencode.ai/api.json",
        "https://cdn.test/catalog?token=secret",
    ]
    assert configure_model_catalog(environment).read_bytes() == CATALOG
    assert "token=secret" not in caplog.text
