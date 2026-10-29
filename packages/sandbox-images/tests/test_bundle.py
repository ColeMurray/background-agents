"""Shared payload staging and conservative build invalidation."""

import json
import re
import shutil
import subprocess
from pathlib import Path

import pytest

from sandbox_images.bundle import PROVIDERS, pack_bundle, plan_image, validate_toolchain
from sandbox_images.locks import update_locks

REPO_ROOT = Path(__file__).resolve().parents[3]


@pytest.fixture
def checkout(tmp_path):
    path = tmp_path / "checkout"
    shutil.copytree(
        REPO_ROOT,
        path,
        ignore=shutil.ignore_patterns(
            ".git", "node_modules", ".venv", ".cache", "__pycache__", ".terraform"
        ),
    )
    return path


@pytest.mark.parametrize("provider", PROVIDERS)
def test_runtime_user_global_pnpm_commands_are_on_path(provider):
    environment = plan_image(REPO_ROOT, provider)["runtimeEnv"]
    assert environment["PNPM_HOME"] in environment["PATH"].split(":")
    assert "VIRTUAL_ENV" not in environment


@pytest.mark.parametrize("provider", PROVIDERS)
def test_image_bin_directory_heads_the_launch_path(provider):
    environment = plan_image(REPO_ROOT, provider)["runtimeEnv"]
    assert environment["PATH"].split(":")[0] == "/opt/openinspect/bin"
    tools = (REPO_ROOT / "packages/sandbox-images/install/tools.sh").read_text()
    languages = (REPO_ROOT / "packages/sandbox-images/install/languages.sh").read_text()
    for command in ("agent-browser", "code-server", "ttyd", "google-chrome", "codex"):
        assert f"/opt/openinspect/bin/{command}" in tools
    assert '"/opt/openinspect/bin/$command"' in languages


def test_binary_checksum_and_minimum_tool_version_are_required():
    tools = json.loads((REPO_ROOT / "packages/sandbox-images/toolchain.json").read_text())
    validate_toolchain(tools)
    tools["opencode"] = "1.18.14"
    with pytest.raises(ValueError, match="OpenCode"):
        validate_toolchain(tools)
    tools["opencode"] = "1.18.29"
    del tools["agentBrowserSha256"]
    with pytest.raises(ValueError, match="agent-browser"):
        validate_toolchain(tools)


def test_npm_overrides_require_exact_versions():
    tools = json.loads((REPO_ROOT / "packages/sandbox-images/toolchain.json").read_text())
    tools["npmOverrides"]["toml"] = "^5.0.1"
    with pytest.raises(ValueError, match="exact release versions"):
        validate_toolchain(tools)


def test_lock_check_rejects_npm_lock_that_ignores_overrides(tmp_path):
    package = tmp_path / "packages/sandbox-images"
    shutil.copytree(REPO_ROOT / "packages/sandbox-images/locks", package / "locks")
    shutil.copy(REPO_ROOT / "packages/sandbox-images/toolchain.json", package)
    lock_path = package / "locks/tools/package-lock.json"
    lock = json.loads(lock_path.read_text())
    lock["packages"]["node_modules/toml"]["version"] = "4.3.0"
    lock_path.write_text(json.dumps(lock))
    with pytest.raises(ValueError, match=re.escape("tools npm lock resolves toml to 4.3.0")):
        update_locks(tmp_path, check=True)


def test_codex_pin_matches_protocol_and_requires_checksum():
    tools = json.loads((REPO_ROOT / "packages/sandbox-images/toolchain.json").read_text())
    source = (
        REPO_ROOT / "packages/sandbox-runtime/src/sandbox_runtime/harness/codex/env.py"
    ).read_text()
    assert f'CODEX_VERSION = "{tools["codex"]["version"]}"' in source
    tools["codex"]["sha256"] = "invalid"
    with pytest.raises(ValueError, match="SHA-256"):
        validate_toolchain(tools)


def test_debian_installs_disable_recommended_packages():
    script = (REPO_ROOT / "packages/sandbox-images/install/os/debian.sh").read_text()
    install_commands = [line for line in script.splitlines() if line.startswith("apt-get install ")]
    assert install_commands
    assert all("--no-install-recommends" in command for command in install_commands)


def test_debian_restores_shared_tmp_before_using_apt():
    script = (REPO_ROOT / "packages/sandbox-images/install/os/debian.sh").read_text()
    assert script.index("install -d -m 1777 /tmp") < script.index("apt-get update")


def test_agent_browser_installs_as_checked_native_binary():
    script = (REPO_ROOT / "packages/sandbox-images/install/tools.sh").read_text()
    assert 'install -m 0755 "$download_dir/agent-browser" /usr/local/bin/agent-browser' in script
    assert "node_modules/agent-browser" not in script
    loop = next(line for line in script.splitlines() if line.startswith("for command in "))
    commands = loop.removeprefix("for command in ").removesuffix("; do").split()
    assert "agent-browser" not in commands


@pytest.mark.parametrize("provider", PROVIDERS)
def test_pack_rejects_stale_locks_before_creating_context(checkout, tmp_path, provider):
    path = checkout / "packages/sandbox-images/locks/python-tools.txt"
    path.write_text(path.read_text() + "\n")
    with pytest.raises(ValueError, match="stale"):
        pack_bundle(checkout, provider, tmp_path / "bundles")
    assert not (tmp_path / "bundles").exists()


@pytest.mark.parametrize(
    "source",
    [
        "packages/sandbox-runtime/src/sandbox_runtime/skills/agent-browser/SKILL.md",
        "packages/modal-infra/src/images/base.py",
        "packages/modal-infra/deploy.py",
        "terraform/modules/modal-app/scripts/deploy.sh",
        "packages/sandbox-images/src/sandbox_images/native.py",
    ],
)
def test_one_hash_covers_payload_builder_and_deployment(checkout, source):
    before = plan_image(checkout, "modal")["buildHash"]
    path = checkout / source
    path.write_text(path.read_text() + "\n")
    assert plan_image(checkout, "modal")["buildHash"] != before


@pytest.mark.parametrize(
    "source",
    [
        "package-lock.json",
        "packages/control-plane/src/logger.ts",
        "packages/control-plane/src/sandbox/request-deadline.ts",
        "packages/shared/src/logger.ts",
    ],
)
def test_vercel_transitive_build_inputs_are_covered(checkout, source):
    before = plan_image(checkout, "vercel")["buildHash"]
    path = checkout / source
    path.write_text(path.read_text() + "\n")
    assert plan_image(checkout, "vercel")["buildHash"] != before


@pytest.mark.parametrize(
    "source",
    [
        "packages/boat-infra/launcher.sh",
        "packages/boat-infra/build-template.py",
        "terraform/modules/boat-infra/scripts/build-snapshot.sh",
    ],
)
def test_boat_hash_covers_launcher_builder_and_deployment(checkout, source):
    before = plan_image(checkout, "boat")["buildHash"]
    path = checkout / source
    path.write_text(path.read_text() + "\n")
    assert plan_image(checkout, "boat")["buildHash"] != before


def test_pack_exports_runtime_requirements_from_uv_lock(checkout, tmp_path):
    lock = checkout / "packages/sandbox-runtime/uv.lock"
    packed = pack_bundle(checkout, "e2b", tmp_path / "bundles")
    requirements = (packed.directory / "runtime-requirements.txt").read_text()
    pinned = re.search(r'name = "cryptography"\nversion = "([^"]+)"', lock.read_text())
    assert pinned
    assert f"cryptography=={pinned[1]} \\\n    --hash=sha256:" in requirements


def test_pack_rejects_runtime_uv_lock_out_of_sync_with_pyproject(checkout, tmp_path):
    pyproject = checkout / "packages/sandbox-runtime/pyproject.toml"
    pyproject.write_text(
        pyproject.read_text().replace("dependencies = [", 'dependencies = [\n    "six",', 1)
    )
    with pytest.raises(subprocess.CalledProcessError):
        pack_bundle(checkout, "e2b", tmp_path / "bundles")
    assert not (tmp_path / "bundles").exists()


def test_runtime_assets_are_packed_without_per_file_manifest(checkout, tmp_path):
    skill = "packages/sandbox-runtime/src/sandbox_runtime/skills/agent-browser/SKILL.md"
    (checkout / skill).write_text("updated skill")
    packed = pack_bundle(checkout, "e2b", tmp_path / "bundles")
    assert (packed.directory / skill).read_text() == "updated skill"
    config = json.loads((packed.directory / "build-config.json").read_text())
    assert config == packed.plan
    assert set(config) == {"provider", "target", "runtimeVersion", "runtimeEnv", "buildHash"}
    assert not (packed.directory / "packages/e2b-infra").exists()


def test_each_caller_gets_a_fresh_context_without_reusing_extra_files(tmp_path):
    first = pack_bundle(REPO_ROOT, "e2b", tmp_path)
    (first.directory / ".env").write_text("must not leak")
    second = pack_bundle(REPO_ROOT, "e2b", tmp_path)
    assert first.directory != second.directory
    assert not (second.directory / ".env").exists()


def test_missing_payload_fails_closed(checkout):
    (checkout / "packages/sandbox-runtime/uv.lock").unlink()
    with pytest.raises(FileNotFoundError):
        plan_image(checkout, "e2b")


def test_symlinks_and_executable_modes(checkout, tmp_path):
    directory = checkout / "packages/sandbox-runtime/src/sandbox_runtime"
    (directory / "probe.sh").write_text("#!/bin/sh\nexit 0\n")
    (directory / "probe.sh").chmod(0o755)
    (directory / "probe-link.sh").symlink_to("probe.sh")
    before = plan_image(checkout, "e2b")["buildHash"]
    packed = pack_bundle(checkout, "e2b", tmp_path / "bundles")
    copied = packed.directory / "packages/sandbox-runtime/src/sandbox_runtime"
    assert (copied / "probe-link.sh").is_symlink()
    assert (copied / "probe.sh").stat().st_mode & 0o111
    (directory / "probe.sh").chmod(0o644)
    assert plan_image(checkout, "e2b")["buildHash"] != before
    (directory / "escape.sh").symlink_to(tmp_path / "outside")
    with pytest.raises(ValueError, match="symlink"):
        plan_image(checkout, "e2b")


def test_docker_variant_pins_debian_packages_by_checksum():
    tools = json.loads((REPO_ROOT / "packages/sandbox-images/toolchain.json").read_text())
    assert set(tools["docker"]) == {"engine", "cli", "containerd", "buildx", "compose"}
    tools["docker"]["engine"]["file"] = "docker-ce_latest.tgz"
    with pytest.raises(ValueError, match="Debian amd64"):
        validate_toolchain(tools)
    tools = json.loads((REPO_ROOT / "packages/sandbox-images/toolchain.json").read_text())
    tools["docker"]["compose"]["sha256"] = "deadbeef"
    with pytest.raises(ValueError, match="SHA-256"):
        validate_toolchain(tools)
    del tools["docker"]["buildx"]
    with pytest.raises(ValueError, match="exactly"):
        validate_toolchain(tools)


def test_docker_variant_installs_only_checked_packages_and_never_runs_at_boot():
    script = (REPO_ROOT / "packages/sandbox-images/install/docker.sh").read_text()
    assert "download_checked" in script
    assert "get.docker.com" not in script
    assert "docker pull" not in script
    install_commands = [line for line in script.splitlines() if "apt-get install" in line]
    assert install_commands
    assert all("--no-install-recommends" in command for command in install_commands)
    assert "/etc/docker/daemon.json" in script
    # The default image's installer never includes the Docker phase.
    install = (REPO_ROOT / "packages/sandbox-images/install/install.sh").read_text()
    assert "docker" not in install


def test_docker_daemon_config_uses_overlay2_and_avoids_modal_networks():
    config = json.loads(
        (REPO_ROOT / "packages/sandbox-images/install/docker-daemon.json").read_text()
    )
    assert config["storage-driver"] == "overlay2"
    assert config["features"]["containerd-snapshotter"] is False
    assert config["bip"].startswith("10.")
    assert all(pool["base"].startswith("10.") for pool in config["default-address-pools"])


def test_docker_pins_reach_the_installer_as_shell_variables(checkout, tmp_path):
    bundle = pack_bundle(checkout, "modal", tmp_path / "out")
    config = (bundle.directory / "image-config.sh").read_text()
    for package in ("ENGINE", "CLI", "CONTAINERD", "BUILDX", "COMPOSE"):
        assert f"export DOCKER_{package}_FILE=" in config
        assert f"export DOCKER_{package}_SHA256=" in config


def test_docker_daemon_shutdown_timeout_fits_inside_the_runtime_stop_deadline():
    config = json.loads(
        (REPO_ROOT / "packages/sandbox-images/install/docker-daemon.json").read_text()
    )
    runtime = (
        REPO_ROOT / "packages/sandbox-runtime/src/sandbox_runtime/docker_service.py"
    ).read_text()
    stop_deadline = float(
        re.search(r"^DOCKER_STOP_TIMEOUT_SECONDS = ([0-9.]+)", runtime, re.M).group(1)
    )
    assert config["shutdown-timeout"] < stop_deadline
