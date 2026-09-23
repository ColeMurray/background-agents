import json
import os
import sys
from pathlib import Path
from unittest.mock import MagicMock

import httpx
import pytest

from sandbox_runtime import opencode_models_catalog
from sandbox_runtime.opencode_models_catalog import (
    OPENCODE_MODELS_URL,
    OpenCodeModelsCatalog,
    catalog_override,
    resolve_opencode_models_cache_path,
)

CATALOG = {"openai": {"id": "openai", "models": {"gpt-6-sol": {"id": "gpt-6-sol"}}}}
REJECTED = {"reject": {"id": "reject", "models": {}}}
OVERRIDE_ENV_VARS = (
    "OPENCODE_MODELS_PATH",
    "OPENCODE_MODELS_URL",
    "OPENCODE_DISABLE_MODELS_FETCH",
)

# Stands in for the pinned binary: records how it was run and refuses any
# catalog carrying a "reject" provider, as OpenCode refuses one it cannot load.
FAKE_OPENCODE = """\
import json, os, sys, time
catalog = json.load(open(os.environ["OPENCODE_MODELS_PATH"]))
with open(os.environ["FAKE_OPENCODE_RECORD"], "w") as record:
    json.dump({"argv": sys.argv[1:], "env": dict(os.environ), "cwd": os.getcwd()}, record)
if "hang" in catalog:
    time.sleep(30)
if "reject" in catalog:
    print("Error: Unexpected error", file=sys.stderr)
    sys.exit(1)
"""


@pytest.fixture(autouse=True)
def default_catalog_environment(monkeypatch):
    for name in OVERRIDE_ENV_VARS:
        monkeypatch.delenv(name, raising=False)


@pytest.fixture
def fake_opencode(tmp_path, monkeypatch):
    command = tmp_path / "bin" / "opencode"
    command.parent.mkdir()
    command.write_text(f"#!{sys.executable}\n{FAKE_OPENCODE}")
    command.chmod(0o755)
    record = tmp_path / "opencode-run.json"
    monkeypatch.setenv("FAKE_OPENCODE_RECORD", str(record))
    return command, record


def _catalog(path, body, fake_opencode):
    command, _record = fake_opencode
    requests = []

    def respond(request):
        requests.append(request)
        return body(request) if callable(body) else body

    log = MagicMock()
    catalog = OpenCodeModelsCatalog(
        log, path=path, opencode_command=str(command), transport=httpx.MockTransport(respond)
    )
    return catalog, log, requests


def _cache_dir(tmp_path):
    directory = tmp_path / "cache" / "opencode"
    directory.mkdir(parents=True)
    return directory


async def test_refresh_installs_a_catalog_opencode_loads(tmp_path, fake_opencode):
    path = _cache_dir(tmp_path) / "models.json"
    body = json.dumps(CATALOG).encode()
    catalog, log, requests = _catalog(path, httpx.Response(200, content=body), fake_opencode)

    assert await catalog.refresh() is True

    assert [str(request.url) for request in requests] == [OPENCODE_MODELS_URL]
    assert path.read_bytes() == body
    assert path.stat().st_mode & 0o777 == 0o644
    assert list(path.parent.iterdir()) == [path]
    log.info.assert_called_once_with(
        "opencode_models.refreshed", path=str(path), size_bytes=len(body)
    )


async def test_opencode_loads_the_staged_bytes_in_an_isolated_home(
    tmp_path, fake_opencode, monkeypatch
):
    path = _cache_dir(tmp_path) / "models.json"
    monkeypatch.setenv("OPENCODE_CONFIG_CONTENT", '{"model": "configured/model"}')
    catalog, _log, _requests = _catalog(path, httpx.Response(200, json=CATALOG), fake_opencode)

    assert await catalog.refresh() is True

    run = json.loads(fake_opencode[1].read_text())
    staged = Path(run["env"]["OPENCODE_MODELS_PATH"])
    assert run["argv"] == ["models"]
    assert staged.parent == path.parent and staged != path
    assert run["env"]["OPENCODE_DISABLE_MODELS_FETCH"] == "1"
    assert "OPENCODE_CONFIG_CONTENT" not in run["env"]
    scratch = Path(run["cwd"]).resolve()
    assert Path(run["env"]["HOME"]).resolve() == scratch != Path.home().resolve()
    assert not scratch.exists()


@pytest.mark.parametrize(
    "response",
    [
        httpx.Response(503, json=CATALOG),
        httpx.Response(200, text="<html>maintenance</html>"),
        httpx.Response(200, json=[CATALOG]),
        httpx.Response(200, json=REJECTED),
    ],
    ids=["http-error", "not-json", "not-an-object", "opencode-cannot-load"],
)
async def test_failed_refresh_keeps_the_existing_catalog(tmp_path, fake_opencode, response):
    path = _cache_dir(tmp_path) / "models.json"
    path.write_text("previous")
    catalog, log, _requests = _catalog(path, response, fake_opencode)

    assert await catalog.refresh() is False

    assert path.read_text() == "previous"
    assert list(path.parent.iterdir()) == [path]
    assert log.warn.call_args.args == ("opencode_models.refresh_failed",)


async def test_opencode_rejection_is_logged_with_its_error(tmp_path, fake_opencode):
    path = _cache_dir(tmp_path) / "models.json"
    catalog, log, _requests = _catalog(path, httpx.Response(200, json=REJECTED), fake_opencode)

    assert await catalog.refresh() is False

    error = log.warn.call_args.kwargs["exc"]
    assert "exit 1" in str(error) and "Unexpected error" in str(error)
    assert not path.exists()


async def test_opencode_that_never_finishes_is_killed(tmp_path, fake_opencode, monkeypatch):
    monkeypatch.setattr(opencode_models_catalog, "VERIFY_TIMEOUT_SECONDS", 0.5)
    path = _cache_dir(tmp_path) / "models.json"
    catalog, log, _requests = _catalog(
        path, httpx.Response(200, json={**CATALOG, "hang": {"models": {}}}), fake_opencode
    )

    assert await catalog.refresh() is False

    assert isinstance(log.warn.call_args.kwargs["exc"], TimeoutError)
    assert list(path.parent.iterdir()) == []


async def test_missing_opencode_is_not_fatal(tmp_path, fake_opencode):
    path = _cache_dir(tmp_path) / "models.json"
    catalog, _log, _requests = _catalog(path, httpx.Response(200, json=CATALOG), fake_opencode)
    catalog.opencode_command = str(tmp_path / "missing" / "opencode")

    assert await catalog.refresh() is False
    assert list(path.parent.iterdir()) == []


async def test_unreachable_catalog_is_not_fatal(tmp_path, fake_opencode):
    path = _cache_dir(tmp_path) / "models.json"

    def unreachable(request):
        raise httpx.ConnectError("unreachable", request=request)

    catalog, _log, _requests = _catalog(path, unreachable, fake_opencode)

    assert await catalog.refresh() is False
    assert not path.exists()


async def test_failed_cleanup_does_not_escape(tmp_path, fake_opencode, monkeypatch):
    path = _cache_dir(tmp_path) / "models.json"
    catalog, log, _requests = _catalog(path, httpx.Response(200, json=REJECTED), fake_opencode)

    def refuse_unlink(self, missing_ok=False):
        raise PermissionError(13, "Permission denied", str(self))

    monkeypatch.setattr(Path, "unlink", refuse_unlink)

    assert await catalog.refresh() is False
    assert log.warn.call_args.args == ("opencode_models.refresh_failed",)


async def test_unwritable_cache_directory_is_not_fatal(tmp_path, fake_opencode):
    path = tmp_path / "models.json" / "models.json"
    (tmp_path / "models.json").write_text("a file where the directory should be")
    catalog, _log, _requests = _catalog(path, httpx.Response(200, json=CATALOG), fake_opencode)

    assert await catalog.refresh() is False


@pytest.mark.parametrize(
    ("name", "value", "override"),
    [
        ("OPENCODE_MODELS_PATH", "/etc/opencode/models.json", True),
        ("OPENCODE_MODELS_PATH", "", True),
        ("OPENCODE_MODELS_URL", "https://models.example.com", True),
        ("OPENCODE_MODELS_URL", "", False),
        ("OPENCODE_DISABLE_MODELS_FETCH", "true", True),
        ("OPENCODE_DISABLE_MODELS_FETCH", "TRUE", True),
        ("OPENCODE_DISABLE_MODELS_FETCH", "1", True),
        ("OPENCODE_DISABLE_MODELS_FETCH", "false", False),
        ("OPENCODE_DISABLE_MODELS_FETCH", "0", False),
        ("OPENCODE_DISABLE_MODELS_FETCH", "", False),
    ],
)
def test_catalog_override_follows_opencode_flag_rules(name, value, override):
    assert catalog_override({name: value}) == (name if override else None)


async def test_operator_catalog_override_skips_the_refresh(tmp_path, fake_opencode, monkeypatch):
    monkeypatch.setenv("OPENCODE_DISABLE_MODELS_FETCH", "1")
    path = tmp_path / "models.json"
    catalog, log, requests = _catalog(path, httpx.Response(200, json=CATALOG), fake_opencode)

    assert await catalog.refresh() is False

    assert requests == []
    assert not path.exists()
    log.info.assert_called_once_with(
        "opencode_models.refresh_skipped", reason="OPENCODE_DISABLE_MODELS_FETCH"
    )


def test_cache_path_follows_xdg_cache_home(tmp_path, monkeypatch):
    monkeypatch.setenv("XDG_CACHE_HOME", str(tmp_path / "xdg"))

    assert resolve_opencode_models_cache_path() == tmp_path / "xdg" / "opencode" / "models.json"


def test_cache_path_defaults_to_home_cache(tmp_path, monkeypatch):
    monkeypatch.delenv("XDG_CACHE_HOME", raising=False)
    monkeypatch.setenv("HOME", str(tmp_path))

    assert resolve_opencode_models_cache_path() == tmp_path / ".cache" / "opencode" / "models.json"


BINARY = os.environ.get("OPENCODE_TEST_BINARY")
FROZEN_CATALOG = Path(__file__).parent / "fixtures/reasoning-models.json"


@pytest.mark.skipif(not BINARY, reason="set OPENCODE_TEST_BINARY to load catalogs with OpenCode")
@pytest.mark.parametrize(
    ("catalog_document", "installed"),
    [
        (json.loads(FROZEN_CATALOG.read_text()), True),
        (CATALOG, False),
        ({"error": {"models": {}}}, False),
    ],
    ids=["published-catalog", "models-missing-required-fields", "error-envelope"],
)
async def test_pinned_opencode_decides_what_is_installed(tmp_path, catalog_document, installed):
    path = _cache_dir(tmp_path) / "models.json"
    path.write_text("previous")
    catalog = OpenCodeModelsCatalog(
        MagicMock(),
        path=path,
        opencode_command=BINARY,
        transport=httpx.MockTransport(lambda _request: httpx.Response(200, json=catalog_document)),
    )

    assert await catalog.refresh() is installed

    assert (
        (json.loads(path.read_text()) == catalog_document)
        if installed
        else (path.read_text() == "previous")
    )
    assert list(path.parent.iterdir()) == [path]
