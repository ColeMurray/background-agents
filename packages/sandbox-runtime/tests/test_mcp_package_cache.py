"""Behavioral checks for prebuilt, restored, restarted, and incomplete MCP installs."""

import asyncio
import io
import json
import shutil
import subprocess
import tarfile
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from sandbox_runtime.mcp_packages import McpPackageInstaller, _packages


def servers(*packages):
    return [{"type": "local", "command": ["npx", "-y", package]} for package in packages]


def installed(root, name="@scope/mcp", version="1.2.3"):
    package = root / name
    package.mkdir(parents=True, exist_ok=True)
    (package / "package.json").write_text(
        json.dumps({"name": name, "version": version, "bin": {"mcp": "cli.js"}})
    )
    cli = package / "cli.js"
    cli.write_text("#!/usr/bin/env node\nconsole.log('ready');\n")
    cli.chmod(0o755)
    binary = root.parent.parent / "bin" / "mcp"
    binary.parent.mkdir(parents=True, exist_ok=True)
    binary.unlink(missing_ok=True)
    binary.symlink_to(cli)
    return package


@pytest.fixture
def installer(tmp_path):
    result = McpPackageInstaller(MagicMock())
    result._root = tmp_path / "prefix/lib/node_modules"
    result._root.mkdir(parents=True)
    return result


def process(returncode=0):
    result = MagicMock()
    result.returncode = returncode
    result.communicate = AsyncMock(return_value=(b"", b""))
    result.wait = AsyncMock()
    return result


@pytest.mark.parametrize("bins", [{"mcp": "cli.js"}, "cli.js"])
async def test_prebuilt_pinned_package_needs_no_npm_process(installer, bins):
    package = installed(installer._root)
    manifest_path = package / "package.json"
    manifest = json.loads(manifest_path.read_text())
    manifest["bin"] = bins
    manifest_path.write_text(json.dumps(manifest))
    with patch("asyncio.create_subprocess_exec") as spawn:
        await installer.install(servers("@scope/mcp@1.2.3"))
    spawn.assert_not_called()
    assert not (installer._root / ".openinspect-mcp-installing.json").exists()


@pytest.mark.parametrize("missing_bin", [True, False], ids=["missing-bin", "empty-bin"])
async def test_missing_executable_metadata_is_reinstalled(installer, missing_bin):
    package = installed(installer._root)
    manifest_path = package / "package.json"
    manifest = json.loads(manifest_path.read_text())
    if missing_bin:
        del manifest["bin"]
    else:
        manifest["bin"] = {}
    manifest_path.write_text(json.dumps(manifest))

    with patch("asyncio.create_subprocess_exec", return_value=process()) as spawn:
        await installer.install(servers("@scope/mcp@1.2.3"))

    spawn.assert_called_once()
    assert spawn.call_args.args == ("npm", "install", "-g", "@scope/mcp@1.2.3")


@pytest.mark.parametrize("damage", ["version", "manifest", "binary", "link", "executable"])
async def test_missing_or_changed_package_is_reinstalled(installer, damage):
    package = installed(installer._root)
    if damage == "version":
        installed(installer._root, version="1.2.2")
    elif damage == "manifest":
        (package / "package.json").write_text("not json")
    elif damage == "binary":
        (package / "cli.js").unlink()
    elif damage == "link":
        (installer._root.parent.parent / "bin/mcp").unlink()
    else:
        (package / "cli.js").chmod(0o644)
    with patch("asyncio.create_subprocess_exec", return_value=process()) as spawn:
        await installer.install(servers("@scope/mcp@1.2.3"))
    assert spawn.call_args.args == ("npm", "install", "-g", "@scope/mcp@1.2.3")


async def test_installs_only_misses_in_mixed_configuration(installer):
    installed(installer._root)
    with patch("asyncio.create_subprocess_exec", return_value=process()) as spawn:
        await installer.install(servers("@scope/mcp@1.2.3", "another@2.0.0"))
    assert spawn.call_args.args == ("npm", "install", "-g", "another@2.0.0")


@pytest.mark.parametrize("spec", ["@scope/mcp", "@scope/mcp@latest", "@scope/mcp@next"])
async def test_floating_versions_reuse_only_successful_installs_in_this_boot(installer, spec):
    installed(installer._root)
    with patch("asyncio.create_subprocess_exec", return_value=process()) as spawn:
        await installer.install(servers(spec))
        await installer.install(servers(spec))
        assert spawn.call_count == 1
        restored = McpPackageInstaller(MagicMock())
        restored._root = installer._root
        await restored.install(servers(spec))
        assert spawn.call_count == 2


async def test_restart_rechecks_installed_version_for_floating_spec(installer):
    installed(installer._root)
    with patch("asyncio.create_subprocess_exec", return_value=process()) as spawn:
        await installer.install(servers("@scope/mcp"))
        installed(installer._root, version="9.0.0")
        await installer.install(servers("@scope/mcp"))
    assert spawn.call_count == 2


async def test_conflicting_versions_are_not_reordered_by_cache_hits(installer):
    installed(installer._root)
    with patch("asyncio.create_subprocess_exec", return_value=process()) as spawn:
        await installer.install(servers("@scope/mcp@1.2.2", "@scope/mcp@1.2.3"))
    assert spawn.call_args.args == ("npm", "install", "-g", "@scope/mcp@1.2.2", "@scope/mcp@1.2.3")


async def test_failed_install_is_not_cached_after_supervisor_recreation(installer):
    async def incomplete_install(*_args, **_kwargs):
        installed(installer._root)
        return process(returncode=1)

    with patch("asyncio.create_subprocess_exec", side_effect=incomplete_install):
        await installer.install(servers("@scope/mcp@1.2.3"))
    marker = installer._root / ".openinspect-mcp-installing.json"
    assert json.loads(marker.read_text()) == ["@scope/mcp"]
    restored = McpPackageInstaller(MagicMock())
    restored._root = installer._root
    with patch("asyncio.create_subprocess_exec", return_value=process()) as spawn:
        await restored.install(servers("@scope/mcp@1.2.3"))
        await restored.install(servers("@scope/mcp@1.2.3"))
    assert spawn.call_count == 1
    assert not marker.exists()


async def test_corrupt_marker_requires_install(installer):
    installed(installer._root)
    (installer._root / ".openinspect-mcp-installing.json").write_text("[")
    with patch("asyncio.create_subprocess_exec", return_value=process()) as spawn:
        await installer.install(servers("@scope/mcp@1.2.3"))
    assert spawn.call_count == 1


@pytest.mark.parametrize("cancel", [False, True])
async def test_interrupted_installs_reap_process_and_remain_uncached(
    installer, monkeypatch, cancel
):
    monkeypatch.setattr("sandbox_runtime.mcp_packages.MCP_PACKAGE_INSTALL_TIMEOUT_SECONDS", 0.01)
    child = process(returncode=None)
    child.pid = None
    started = asyncio.Event()

    async def hang():
        installed(installer._root)
        started.set()
        await asyncio.Event().wait()

    child.communicate.side_effect = hang
    with patch("asyncio.create_subprocess_exec", return_value=child):
        task = asyncio.create_task(installer.install(servers("@scope/mcp@1.2.3")))
        await started.wait()
        if cancel:
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task
        else:
            await task
    child.kill.assert_called_once()
    child.wait.assert_awaited_once()
    assert (installer._root / ".openinspect-mcp-installing.json").exists()


async def test_root_lookup_failure_falls_back_to_install():
    installer = McpPackageInstaller(MagicMock())
    with patch("asyncio.create_subprocess_exec", side_effect=[process(1), process()]) as spawn:
        await installer.install(servers("@scope/mcp@1.2.3"))
    assert spawn.call_count == 2
    assert spawn.call_args.args == ("npm", "install", "-g", "@scope/mcp@1.2.3")


@pytest.mark.parametrize(
    ("command", "expected"),
    [
        (["npx", "-y", "@scope/mcp@1.2.3", "-p", "server-option"], ["@scope/mcp@1.2.3"]),
        (["npx", "-p", "one@1.0.0", "--package=two@2.0.0", "binary"], ["one@1.0.0", "two@2.0.0"]),
        (["npx", "--registry", "https://registry.example", "pkg"], []),
        (["npx", "--", "pkg@1.2.3+build.1"], ["pkg@1.2.3+build.1"]),
        (["npx", "pkg\n"], []),
        (["npx", "-p"], []),
    ],
)
def test_package_options_do_not_consume_server_arguments(command, expected):
    assert _packages([{"type": "local", "command": command}]) == expected


@pytest.mark.skipif(shutil.which("npm") is None, reason="npm required for offline integration")
async def test_real_npm_prebuild_install_is_reused_without_registry(tmp_path, monkeypatch):
    """Real npm layout and binaries, an offline tarball, no host global writes."""
    archive = tmp_path / "fixture.tgz"
    manifest = {"name": "oi-mcp-cache-fixture", "version": "1.0.0", "bin": {"oi-cache": "cli.js"}}
    with tarfile.open(archive, "w:gz") as tar:
        for filename, body, mode in [
            ("package.json", json.dumps(manifest), 0o644),
            ("cli.js", "#!/usr/bin/env node\nconsole.log('ready');\n", 0o755),
        ]:
            data = body.encode()
            info = tarfile.TarInfo(f"package/{filename}")
            info.size, info.mode = len(data), mode
            tar.addfile(info, io.BytesIO(data))
    prefix = tmp_path / "prefix"
    monkeypatch.setenv("NPM_CONFIG_PREFIX", str(prefix))
    monkeypatch.setenv("NPM_CONFIG_CACHE", str(tmp_path / "npm-cache"))
    monkeypatch.setenv("NPM_CONFIG_OFFLINE", "true")
    subprocess.run(
        ["npm", "install", "-g", "--ignore-scripts", "--no-audit", "--no-fund", str(archive)],
        check=True,
        capture_output=True,
        timeout=30,
    )
    assert subprocess.check_output([str(prefix / "bin/oi-cache")], text=True).strip() == "ready"
    with patch("asyncio.create_subprocess_exec", wraps=asyncio.create_subprocess_exec) as spawn:
        for _ in range(2):
            await McpPackageInstaller(MagicMock()).install(servers("oi-mcp-cache-fixture@1.0.0"))
    assert [call.args for call in spawn.call_args_list] == [("npm", "root", "--global")] * 2
