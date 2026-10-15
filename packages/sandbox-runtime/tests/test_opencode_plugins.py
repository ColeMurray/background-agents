"""Workspace plugin selection survives the runtime configuration boundary."""

import asyncio
import json
import shutil
import socket
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import pytest

from sandbox_runtime.opencode_plugins import install_plugin, plugin_cache_dir
from sandbox_runtime.runtime_config import RuntimeConfig
from tests.runtime_helpers import make_opencode_server


def test_workspace_plugins_reach_opencode_config(tmp_path):
    config = RuntimeConfig.from_env(
        {"SESSION_CONFIG": json.dumps({"opencode_plugins": ["@company/audit@1.2.3"]})},
        workspace_path=tmp_path,
    )
    assert getattr(config.opencode_config(), "plugins", ()) == ("@company/audit@1.2.3",)


def cache_plugin(spec, source, *, engines=None):
    name, version = spec.rsplit("@", 1)
    directory = plugin_cache_dir() / spec
    package = directory / "node_modules" / name
    package.mkdir(parents=True)
    (package / "package.json").write_text(
        json.dumps(
            {
                "name": name,
                "version": version,
                "type": "module",
                "main": "index.js",
                **({"engines": engines} if engines else {}),
            }
        )
    )
    (package / "index.js").write_text(source)
    (directory / ".openinspect-complete").touch()
    return directory


@pytest.fixture
def isolated_opencode(tmp_path, monkeypatch):
    for variable, directory in (
        ("XDG_CONFIG_HOME", "config"),
        ("XDG_CACHE_HOME", "cache"),
        ("XDG_DATA_HOME", "data"),
        ("XDG_STATE_HOME", "state"),
    ):
        monkeypatch.setenv(variable, str(tmp_path / directory))
    monkeypatch.setenv("OPENCODE_CONFIG_DIR", str(tmp_path / "config/opencode"))
    monkeypatch.setenv("OPENCODE_DISABLE_MODELS_FETCH", "1")
    monkeypatch.setenv("OPENCODE_DISABLE_DEFAULT_PLUGINS", "true")
    monkeypatch.setenv(
        "OPENCODE_MODELS_PATH", str(Path(__file__).parent / "fixtures/reasoning-models.json")
    )
    for variable in (
        "OPENAI_OAUTH_MANAGED",
        "XAI_OAUTH_MANAGED",
        "OPENCODE_CONFIG",
        "OPENCODE_CONFIG_CONTENT",
    ):
        monkeypatch.delenv(variable, raising=False)
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    monkeypatch.setattr("sandbox_runtime.opencode_server.OPENCODE_PORT", port)
    return port


async def test_pinned_cache_hit_does_not_run_npm(isolated_opencode):
    cache_plugin("@company/audit@1.2.3", "export default async () => ({})")
    with patch("sandbox_runtime.opencode_plugins.asyncio.create_subprocess_exec") as spawn:
        await install_plugin("@company/audit@1.2.3", plugin_cache_dir())
    spawn.assert_not_called()


async def test_invalid_specs_never_run_npm(tmp_path):
    with patch("sandbox_runtime.opencode_plugins.asyncio.create_subprocess_exec") as spawn:
        for spec in (
            "audit",
            "audit@latest",
            "audit@^1.0.0",
            "file:///tmp/plugin.js",
            "--help",
            "a/../../b@1.0.0",
        ):
            with pytest.raises(ValueError):
                await install_plugin(spec, tmp_path)
    spawn.assert_not_called()


async def test_install_errors_do_not_prevent_other_plugins(tmp_path):
    specs = ["missing@1.0.0", "slow@1.0.0", "good@1.0.0"]
    server = make_opencode_server(
        {"SESSION_CONFIG": json.dumps({"opencode_plugins": specs})}, workspace_path=tmp_path
    )
    server.record_boot_warning = MagicMock()
    with patch(
        "sandbox_runtime.opencode_server.install_plugin",
        new_callable=AsyncMock,
        side_effect=[RuntimeError(), TimeoutError(), None],
    ):
        assert await server._prepare_plugins() == ["good@1.0.0"]
    assert server._plugin_status == {
        "missing@1.0.0": "skipped",
        "slow@1.0.0": "skipped",
        "good@1.0.0": "pending",
    }
    assert server.record_boot_warning.call_count == 2


async def test_initialization_timeout_restarts_without_managed_plugins(tmp_path):
    server = make_opencode_server(
        {"SESSION_CONFIG": '{"opencode_plugins":["slow@1.0.0"]}'}, workspace_path=tmp_path
    )
    server.record_boot_warning = MagicMock()
    configs = []

    async def spawn(*args, **kwargs):
        configs.append(json.loads(kwargs["env"]["OPENCODE_CONFIG_CONTENT"]))
        return MagicMock(stdout=None)

    with (
        patch.object(server, "_prepare_opencode_filesystem", return_value=set()),
        patch.object(server, "_wait_for_health", new_callable=AsyncMock),
        patch.object(
            server, "_initialize_plugins", new_callable=AsyncMock, side_effect=TimeoutError
        ),
        patch.object(server, "stop", new_callable=AsyncMock) as stop,
        patch("sandbox_runtime.opencode_server.install_plugin", new_callable=AsyncMock),
        patch("sandbox_runtime.opencode_server.asyncio.create_subprocess_exec", side_effect=spawn),
        patch(
            "sandbox_runtime.opencode_server.asyncio.create_task",
            side_effect=lambda coro: coro.close(),
        ),
    ):
        await server.start((), tmp_path)
    assert configs[0]["plugin"] == ["slow@1.0.0"]
    assert "plugin" not in configs[1]
    stop.assert_awaited_once()
    assert server._plugin_status == {"slow@1.0.0": "skipped"}


async def test_shutdown_during_startup_does_not_restart_or_skip_plugins(
    tmp_path, isolated_opencode
):
    server = make_opencode_server(
        {"SESSION_CONFIG": '{"opencode_plugins":["audit@1.0.0"]}'}, workspace_path=tmp_path
    )
    server.record_boot_warning = MagicMock()

    async def spawn(*args, **kwargs):
        # Shutdown begins while the first process is being created. The real
        # health check must abort startup without launching the fallback.
        server.shutdown_event.set()
        return MagicMock(stdout=None)

    with (
        patch.object(server, "_prepare_opencode_filesystem", return_value=set()),
        patch.object(server, "_initialize_plugins", new_callable=AsyncMock) as initialize,
        patch.object(server, "stop", new_callable=AsyncMock) as stop,
        patch("sandbox_runtime.opencode_server.install_plugin", new_callable=AsyncMock),
        patch(
            "sandbox_runtime.opencode_server.asyncio.create_subprocess_exec",
            side_effect=spawn,
        ) as process_spawn,
        patch(
            "sandbox_runtime.opencode_server.asyncio.create_task",
            side_effect=lambda coro: coro.close(),
        ),
        pytest.raises(RuntimeError, match="Shutdown requested during startup"),
    ):
        await server.start((), tmp_path)
    assert process_spawn.call_count == 1
    stop.assert_not_awaited()
    initialize.assert_not_awaited()
    server.record_boot_warning.assert_not_called()
    assert server._plugin_status == {"audit@1.0.0": "pending"}
    assert server.plugins == ("audit@1.0.0",)


@pytest.mark.skipif(
    not shutil.which("opencode") or not Path("/app/opencode-deps").is_dir(),
    reason="requires pinned OpenCode binary",
)
async def test_real_opencode_loads_pinned_plugins_and_survives_failures(
    tmp_path, isolated_opencode
):
    """No npm network or inference: real loader, cached synthetic npm packages."""
    import subprocess

    assert subprocess.check_output(["opencode", "--version"], text=True).strip() == "1.18.29"
    marker = tmp_path / "loaded.txt"
    specs = ["@company/good@1.0.0", "bad-import@1.0.0", "bad-init@1.0.0"]
    cache_plugin(
        specs[0],
        f'import {{ writeFileSync }} from "node:fs"; export default async () => {{ writeFileSync({json.dumps(str(marker))}, "initialized"); return {{}}; }}',
    )
    cache_plugin(
        specs[1], 'throw new Error("synthetic import failure"); export default async () => ({})'
    )
    cache_plugin(
        specs[2],
        'export default async () => { throw new Error("synthetic initialization failure") }',
    )
    v1_marker = tmp_path / "v1.txt"
    repo_marker = tmp_path / "repo.txt"
    specs.extend(["v1-plugin@1.0.0", "incompatible@1.0.0"])
    cache_plugin(
        specs[3],
        f'import {{ writeFileSync }} from "node:fs"; export default {{ server: async () => {{ writeFileSync({json.dumps(str(v1_marker))}, "v1"); return {{}}; }} }}',
    )
    cache_plugin(specs[4], "export default async () => ({})", engines={"opencode": ">=999.0.0"})
    cache_plugin(
        "repo-only@1.0.0",
        f'import {{ writeFileSync }} from "node:fs"; export default async () => {{ writeFileSync({json.dumps(str(repo_marker))}, "repository"); return {{}}; }}',
    )
    (tmp_path / ".opencode").mkdir()
    (tmp_path / ".opencode/opencode.json").write_text('{"plugin":["repo-only@1.0.0"]}')
    server = make_opencode_server(
        {"SESSION_CONFIG": json.dumps({"opencode_plugins": specs})}, workspace_path=tmp_path
    )
    server.record_boot_warning = MagicMock()
    server.record_plugin_status = MagicMock()

    def stage(*args):
        for path in (tmp_path / ".opencode", tmp_path / "config/opencode"):
            path.mkdir(parents=True, exist_ok=True)
            server._stage_opencode_deps(Path("/app/opencode-deps"), path)
        return set()

    try:
        with patch.object(server, "_prepare_opencode_filesystem", side_effect=stage):
            await server.start((), tmp_path)
        await asyncio.sleep(0.1)  # Drain the subprocess's log pipe.
        assert marker.read_text() == "initialized"
        assert v1_marker.read_text() == "v1"
        assert repo_marker.read_text() == "repository"
        async with httpx.AsyncClient() as client:
            response = await client.post(f"http://127.0.0.1:{isolated_opencode}/session", json={})
        assert response.status_code == 200
        assert server._plugin_status == {
            specs[0]: "loaded",
            specs[1]: "skipped",
            specs[2]: "skipped",
            specs[3]: "loaded",
            specs[4]: "skipped",
        }
        assert server.record_boot_warning.call_count == 3
    finally:
        await server.stop()


async def test_incomplete_install_is_retried_and_completed_install_reused(tmp_path, monkeypatch):
    """Execute the installer protocol through a synthetic npm executable, offline."""
    import os
    import sys

    npm = tmp_path / "bin/npm"
    npm.parent.mkdir()
    npm.write_text(
        f"#!{sys.executable}\n"
        + """import json
import pathlib
import sys
assert sys.argv[1:8] == ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--save-exact", "--", "audit@1.0.0"]
package = pathlib.Path("node_modules/audit")
package.mkdir(parents=True, exist_ok=True)
(package / "package.json").write_text(json.dumps({"name": "audit", "version": "1.0.0"}))
pathlib.Path("installed").touch()
"""
    )
    npm.chmod(0o755)
    monkeypatch.setenv("PATH", str(npm.parent) + os.pathsep + os.environ["PATH"])
    cache = tmp_path / "cache"
    partial = cache / "audit@1.0.0/node_modules/audit"
    partial.mkdir(parents=True)
    (partial / "package.json").write_text('{"name":"audit","version":"1.0.0"}')
    await install_plugin("audit@1.0.0", cache)
    assert (cache / "audit@1.0.0/.openinspect-complete").is_file()
    assert (cache / "audit@1.0.0/installed").is_file()
    npm.write_text(f"#!{sys.executable}\nraise RuntimeError('cache miss')\n")
    await install_plugin("audit@1.0.0", cache)


async def test_install_timeout_kills_npm_and_leaves_no_complete_marker(tmp_path, monkeypatch):
    import os
    import sys

    npm = tmp_path / "npm"
    pid = tmp_path / "pid"
    npm.write_text(
        f"#!{sys.executable}\nimport os, pathlib, time\npathlib.Path({str(pid)!r}).write_text(str(os.getpid()))\ntime.sleep(30)\n"
    )
    npm.chmod(0o755)
    monkeypatch.setenv("PATH", str(tmp_path) + os.pathsep + os.environ["PATH"])
    monkeypatch.setattr("sandbox_runtime.opencode_plugins.PLUGIN_INSTALL_TIMEOUT_SECONDS", 0.2)
    with pytest.raises(TimeoutError):
        await install_plugin("audit@1.0.0", tmp_path / "cache")
    assert not (tmp_path / "cache/audit@1.0.0/.openinspect-complete").exists()
    with pytest.raises(ProcessLookupError):
        os.kill(int(pid.read_text()), 0)
