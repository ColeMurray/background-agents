import json
import os
import sys
from pathlib import Path
from unittest.mock import MagicMock

import pytest

from sandbox_runtime import opencode_models_catalog
from sandbox_runtime.opencode_models_catalog import (
    OpenCodeModelsCatalog,
    catalog_override,
    resolve_opencode_models_cache_path,
)

CATALOG = '{"openai": {"id": "openai", "models": {}}}'
OVERRIDE_ENV_VARS = (
    "OPENCODE_MODELS_PATH",
    "OPENCODE_MODELS_URL",
    "OPENCODE_DISABLE_MODELS_FETCH",
)

# Stands in for `opencode models --refresh`, including its two quirks: an
# unreachable source still exits 0 without writing, and a catalog it cannot
# load is written before it exits 1.
FAKE_OPENCODE = """\
import json, os, sys, time
with open(os.environ["FAKE_OPENCODE_RECORD"], "w") as record:
    json.dump({"argv": sys.argv[1:], "env": dict(os.environ), "cwd": os.getcwd()}, record)
behavior = os.environ["FAKE_OPENCODE_BEHAVIOR"]
if behavior == "hang":
    time.sleep(30)
cache = os.path.join(os.environ["XDG_CACHE_HOME"], "opencode")
os.makedirs(cache, exist_ok=True)
if behavior != "unreachable":
    with open(os.path.join(cache, "models.json"), "w") as catalog:
        catalog.write(os.environ["FAKE_OPENCODE_CATALOG"])
print("Models cache refreshed", file=sys.stderr)
if behavior == "unloadable":
    print("Error: Unexpected error", file=sys.stderr)
    sys.exit(1)
"""


@pytest.fixture(autouse=True)
def default_catalog_environment(monkeypatch):
    for name in OVERRIDE_ENV_VARS:
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("FAKE_OPENCODE_CATALOG", CATALOG)
    monkeypatch.setenv("FAKE_OPENCODE_BEHAVIOR", "refresh")


@pytest.fixture
def opencode_run(tmp_path, monkeypatch):
    """Path of the record the fake ``opencode`` writes about how it was run."""
    record = tmp_path / "opencode-run.json"
    monkeypatch.setenv("FAKE_OPENCODE_RECORD", str(record))
    return record


@pytest.fixture
def catalog(tmp_path, opencode_run):
    command = tmp_path / "bin" / "opencode"
    command.parent.mkdir()
    command.write_text(f"#!{sys.executable}\n{FAKE_OPENCODE}")
    command.chmod(0o755)
    path = tmp_path / "cache" / "opencode" / "models.json"
    path.parent.mkdir(parents=True)
    return OpenCodeModelsCatalog(MagicMock(), path=path, opencode_command=str(command))


async def test_refresh_installs_the_catalog_opencode_downloaded(catalog, opencode_run):
    assert await catalog.refresh() is True

    run = json.loads(opencode_run.read_text())
    assert run["argv"] == ["models", "--refresh"]
    assert catalog.path.read_text() == CATALOG
    assert catalog.path.stat().st_mode & 0o777 == 0o644
    assert list(catalog.path.parent.iterdir()) == [catalog.path]
    catalog.log.info.assert_called_once_with(
        "opencode_models.refreshed", path=str(catalog.path), size_bytes=len(CATALOG)
    )


async def test_refresh_runs_opencode_in_a_throwaway_home(catalog, opencode_run, monkeypatch):
    monkeypatch.setenv("OPENCODE_CONFIG_CONTENT", '{"model": "configured/model"}')

    assert await catalog.refresh() is True

    run = json.loads(opencode_run.read_text())
    scratch = Path(run["cwd"]).resolve()
    assert scratch.parent == catalog.path.parent.resolve()
    assert Path(run["env"]["HOME"]).resolve() == scratch
    assert Path(run["env"]["XDG_CACHE_HOME"]).resolve() == scratch / "cache"
    assert not any(name.startswith("OPENCODE_") for name in run["env"])
    assert not scratch.exists()


@pytest.mark.parametrize("behavior", ["unreachable", "unloadable"])
async def test_failed_refresh_keeps_the_existing_catalog(catalog, monkeypatch, behavior):
    catalog.path.write_text("previous")
    monkeypatch.setenv("FAKE_OPENCODE_BEHAVIOR", behavior)

    assert await catalog.refresh() is False

    assert catalog.path.read_text() == "previous"
    assert list(catalog.path.parent.iterdir()) == [catalog.path]
    assert catalog.log.warn.call_args.args == ("opencode_models.refresh_failed",)


async def test_unloadable_catalog_is_logged_with_opencodes_error(catalog, monkeypatch):
    monkeypatch.setenv("FAKE_OPENCODE_BEHAVIOR", "unloadable")

    assert await catalog.refresh() is False

    error = str(catalog.log.warn.call_args.kwargs["exc"])
    assert "exited 1" in error and "Unexpected error" in error
    assert not catalog.path.exists()


async def test_opencode_that_never_finishes_is_killed(catalog, monkeypatch):
    monkeypatch.setattr(opencode_models_catalog, "REFRESH_TIMEOUT_SECONDS", 0.5)
    monkeypatch.setenv("FAKE_OPENCODE_BEHAVIOR", "hang")

    assert await catalog.refresh() is False

    assert isinstance(catalog.log.warn.call_args.kwargs["exc"], TimeoutError)
    assert list(catalog.path.parent.iterdir()) == []


async def test_missing_opencode_is_not_fatal(catalog, tmp_path):
    catalog.opencode_command = str(tmp_path / "missing" / "opencode")

    assert await catalog.refresh() is False
    assert list(catalog.path.parent.iterdir()) == []


async def test_unwritable_cache_directory_is_not_fatal(catalog, tmp_path):
    (tmp_path / "blocked").write_text("a file where the directory should be")
    catalog.path = tmp_path / "blocked" / "opencode" / "models.json"

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


async def test_operator_catalog_override_skips_the_refresh(catalog, opencode_run, monkeypatch):
    monkeypatch.setenv("OPENCODE_DISABLE_MODELS_FETCH", "1")

    assert await catalog.refresh() is False

    assert not opencode_run.exists()
    assert not catalog.path.exists()
    catalog.log.info.assert_called_once_with(
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


@pytest.mark.skipif(
    not BINARY, reason="set OPENCODE_TEST_BINARY to refresh with a real OpenCode (uses the network)"
)
async def test_pinned_opencode_refreshes_the_published_catalog(tmp_path):
    path = tmp_path / "cache" / "opencode" / "models.json"
    catalog = OpenCodeModelsCatalog(MagicMock(), path=path, opencode_command=BINARY)

    assert await catalog.refresh() is True

    assert "models" in json.loads(path.read_text())["openai"]
    assert list(path.parent.iterdir()) == [path]
