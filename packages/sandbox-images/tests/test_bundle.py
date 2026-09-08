"""Shared payload staging and conservative build invalidation."""

import json
import shutil
from pathlib import Path

import pytest

from sandbox_images.bundle import PROVIDERS, pack_bundle, plan_image, validate_toolchain

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


def test_debian_installs_disable_recommended_packages():
    script = (REPO_ROOT / "packages/sandbox-images/install/os/debian.sh").read_text()
    install_commands = [line for line in script.splitlines() if line.startswith("apt-get install ")]
    assert install_commands
    assert all("--no-install-recommends" in command for command in install_commands)


def test_debian_restores_shared_tmp_before_using_apt():
    script = (REPO_ROOT / "packages/sandbox-images/install/os/debian.sh").read_text()
    assert script.index("install -d -m 1777 /tmp") < script.index("apt-get update")


@pytest.mark.parametrize("provider", PROVIDERS)
def test_pack_rejects_stale_locks_before_creating_context(checkout, tmp_path, provider):
    path = checkout / "packages/sandbox-images/locks/runtime.txt"
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


def test_runtime_assets_are_packed_without_per_file_manifest(checkout, tmp_path):
    skill = "packages/sandbox-runtime/src/sandbox_runtime/skills/agent-browser/SKILL.md"
    (checkout / skill).write_text("updated skill")
    packed = pack_bundle(checkout, "e2b", tmp_path / "bundles")
    assert (packed / skill).read_text() == "updated skill"
    config = json.loads((packed / "build-config.json").read_text())
    assert set(config) == {"provider", "target", "runtimeVersion", "runtimeEnv", "buildHash"}
    assert not (packed / "packages/e2b-infra").exists()


def test_each_caller_gets_a_fresh_context_without_reusing_extra_files(tmp_path):
    first = pack_bundle(REPO_ROOT, "e2b", tmp_path)
    (first / ".env").write_text("must not leak")
    second = pack_bundle(REPO_ROOT, "e2b", tmp_path)
    assert first != second
    assert not (second / ".env").exists()


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
    copied = packed / "packages/sandbox-runtime/src/sandbox_runtime"
    assert (copied / "probe-link.sh").is_symlink()
    assert (copied / "probe.sh").stat().st_mode & 0o111
    (directory / "probe.sh").chmod(0o644)
    assert plan_image(checkout, "e2b")["buildHash"] != before
    (directory / "escape.sh").symlink_to(tmp_path / "outside")
    with pytest.raises(ValueError, match="symlink"):
        plan_image(checkout, "e2b")
