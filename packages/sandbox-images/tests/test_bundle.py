"""Exercise the same plan/pack boundary used by native builders and Terraform."""

import errno
import json
import shutil
from pathlib import Path

import pytest

from sandbox_images.bundle import pack_bundle, plan_image, validate_toolchain

REPO_ROOT = Path(__file__).resolve().parents[3]


def test_agent_browser_native_binary_requires_a_repository_checksum():
    tools = json.loads((REPO_ROOT / "packages/sandbox-images/toolchain.json").read_text())
    validate_toolchain(tools)
    del tools["agentBrowserSha256"]
    with pytest.raises(ValueError, match="agent-browser native binary"):
        validate_toolchain(tools)


@pytest.mark.parametrize("extra", [".env", ".cache/credentials", "node_modules/secret", "empty/"])
def test_published_bundle_rejects_all_unmanifested_entries(tmp_path, extra):
    from sandbox_images.bundle import _assert_same_bundle

    expected, existing = tmp_path / "expected", tmp_path / "existing"
    expected.mkdir()
    existing.mkdir()
    path = existing / extra
    if extra.endswith("/"):
        path.mkdir()
    else:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("must not be uploaded")
    with pytest.raises(RuntimeError, match="modified"):
        _assert_same_bundle(expected, existing)


@pytest.mark.parametrize("provider", ["modal", "daytona", "e2b", "vercel", "opencomputer"])
@pytest.mark.parametrize("stale", ["runtime-environments.json", "locks/runtime.txt"])
def test_canonical_pack_rejects_stale_generated_inputs(tmp_path, provider, stale):
    checkout = tmp_path / "checkout"
    shutil.copytree(
        REPO_ROOT,
        checkout,
        ignore=shutil.ignore_patterns(
            ".git", "node_modules", ".venv", ".cache", "__pycache__", ".terraform"
        ),
    )
    path = checkout / "packages/sandbox-images" / stale
    path.write_text(path.read_text() + "\n")
    with pytest.raises(ValueError, match="stale"):
        pack_bundle(checkout, provider, tmp_path / "bundles")
    assert not (tmp_path / "bundles").exists()


def test_bundled_skill_change_invalidates_every_provider_and_is_packed(tmp_path: Path) -> None:
    checkout = tmp_path / "checkout"
    shutil.copytree(
        REPO_ROOT,
        checkout,
        ignore=shutil.ignore_patterns(".git", "node_modules", ".venv", ".cache", "__pycache__"),
    )
    skill = "packages/sandbox-runtime/src/sandbox_runtime/skills/agent-browser/SKILL.md"
    before = {
        p: plan_image(checkout, p)["recipeDigest"]
        for p in ("modal", "daytona", "e2b", "vercel", "opencomputer")
    }
    (checkout / skill).write_text("A changed bundled skill.\n")
    for provider, digest in before.items():
        plan = plan_image(checkout, provider)
        assert plan["recipeDigest"] != digest
        bundle = pack_bundle(checkout, provider, tmp_path / "bundles")
        assert (bundle / skill).read_text() == "A changed bundled skill.\n"
        assert (
            json.loads((bundle / "image-plan.json").read_text())["recipeDigest"]
            == plan["recipeDigest"]
        )


def test_modal_cache_buster_changes_recipe_and_copied_bundle(tmp_path: Path) -> None:
    checkout = tmp_path / "checkout"
    shutil.copytree(
        REPO_ROOT,
        checkout,
        ignore=shutil.ignore_patterns(".git", "node_modules", ".venv", ".cache", "__pycache__"),
    )
    base_path = Path("packages/modal-infra/src/images/base.py")
    original = (checkout / base_path).read_text()
    assert "CACHE_BUSTER = RUNTIME_VERSION" in original
    before = plan_image(checkout, "modal")
    other_before = plan_image(checkout, "e2b")["recipeDigest"]
    old_bundle = pack_bundle(checkout, "modal", tmp_path / "bundles")

    changed = original.replace(
        "CACHE_BUSTER = RUNTIME_VERSION", 'CACHE_BUSTER = "manual-refresh"', 1
    )
    (checkout / base_path).write_text(changed)
    after = plan_image(checkout, "modal")
    new_bundle = pack_bundle(checkout, "modal", tmp_path / "bundles")

    assert after["recipeDigest"] != before["recipeDigest"]
    assert after["runtimeVersion"] == before["runtimeVersion"]
    assert plan_image(checkout, "e2b")["recipeDigest"] == other_before
    assert new_bundle != old_bundle
    assert not (new_bundle / base_path).exists()
    assert (
        json.loads((new_bundle / "image-plan.json").read_text())["cacheBuster"] == "manual-refresh"
    )
    assert (
        json.loads((old_bundle / "image-plan.json").read_text())["cacheBuster"]
        == before["cacheBuster"]
    )
    assert (new_bundle / "image-plan.json").read_bytes() != (
        old_bundle / "image-plan.json"
    ).read_bytes()


def test_unrelated_docs_and_caches_do_not_change_the_recipe(tmp_path: Path) -> None:
    checkout = tmp_path / "checkout"
    shutil.copytree(
        REPO_ROOT,
        checkout,
        ignore=shutil.ignore_patterns(".git", "node_modules", ".venv", ".cache", "__pycache__"),
    )
    before = plan_image(checkout, "e2b")
    (checkout / "packages/sandbox-runtime/src/sandbox_runtime/__pycache__").mkdir()
    (
        checkout / "packages/sandbox-runtime/src/sandbox_runtime/__pycache__/generated.pyc"
    ).write_bytes(b"cache")
    (checkout / "README.md").write_text("Unrelated documentation")
    assert plan_image(checkout, "e2b") == before


@pytest.mark.parametrize(
    "build_path",
    [
        "packages/sandbox-images/src/sandbox_images/releases.py",
        "package-lock.json",
        "packages/control-plane/src/logger.ts",
        "packages/control-plane/src/sandbox/request-deadline.ts",
        "packages/shared/src/logger.ts",
    ],
)
def test_build_inputs_invalidate_orchestration_without_changing_image(tmp_path, build_path):
    checkout = tmp_path / "checkout"
    shutil.copytree(
        REPO_ROOT,
        checkout,
        ignore=shutil.ignore_patterns(
            ".git", "node_modules", ".venv", ".cache", "__pycache__", ".terraform"
        ),
    )
    before = plan_image(checkout, "vercel")
    original_bundle = pack_bundle(checkout, "vercel", tmp_path / "bundles")
    path = checkout / build_path
    path.write_text(path.read_text() + "\n")
    after = plan_image(checkout, "vercel")
    assert after["recipeDigest"] == before["recipeDigest"]
    assert after["buildDigest"] != before["buildDigest"]
    assert pack_bundle(checkout, "vercel", tmp_path / "bundles") == original_bundle
    assert not (original_bundle / build_path).exists()
    baked = json.loads((original_bundle / "image-plan.json").read_text())
    assert "buildInputs" not in baked and "buildDigest" not in baked


def test_incomplete_declared_input_cannot_be_silently_omitted(tmp_path: Path) -> None:
    import pytest

    checkout = tmp_path / "checkout"
    shutil.copytree(
        REPO_ROOT,
        checkout,
        ignore=shutil.ignore_patterns(".git", "node_modules", ".venv", ".cache", "__pycache__"),
    )
    (checkout / "packages/sandbox-runtime/uv.lock").unlink()
    with pytest.raises(FileNotFoundError, match=r"uv\.lock"):
        plan_image(checkout, "e2b")


def test_provider_lock_is_a_required_input(tmp_path: Path) -> None:
    checkout = tmp_path / "checkout"
    shutil.copytree(
        REPO_ROOT,
        checkout,
        ignore=shutil.ignore_patterns(".git", "node_modules", ".venv", ".cache", "__pycache__"),
    )
    (checkout / "packages/e2b-infra/uv.lock").unlink()
    with pytest.raises(FileNotFoundError, match=r"e2b-infra/uv\.lock"):
        plan_image(checkout, "e2b")


def test_opencode_floor_cannot_be_accidentally_lowered_by_a_tool_pin(tmp_path: Path) -> None:
    checkout = tmp_path / "checkout"
    shutil.copytree(
        REPO_ROOT,
        checkout,
        ignore=shutil.ignore_patterns(".git", "node_modules", ".venv", ".cache", "__pycache__"),
    )
    path = checkout / "packages/sandbox-images/toolchain.json"
    manifest = json.loads(path.read_text())
    manifest["opencode"] = "1.18.14"
    path.write_text(json.dumps(manifest))
    with pytest.raises(ValueError, match="OpenCode"):
        plan_image(checkout, "e2b")


def test_packing_is_immutable_and_rejects_tampered_reuse(tmp_path: Path) -> None:
    bundle = pack_bundle(REPO_ROOT, "e2b", tmp_path)
    assert pack_bundle(REPO_ROOT, "e2b", tmp_path) == bundle
    (bundle / "image-config.sh").write_text("tampered")
    with pytest.raises(RuntimeError, match="modified"):
        pack_bundle(REPO_ROOT, "e2b", tmp_path)
    assert (bundle / "image-config.sh").read_text() == "tampered"


@pytest.mark.parametrize("error_number", [errno.ENOTEMPTY, errno.EEXIST])
def test_packing_accepts_identical_concurrent_publication(monkeypatch, tmp_path, error_number):
    def concurrent_rename(source, destination):
        shutil.copytree(source, destination)
        raise OSError(error_number, "Concurrent publisher")

    monkeypatch.setattr(Path, "rename", concurrent_rename)
    bundle = pack_bundle(REPO_ROOT, "modal", tmp_path)
    assert (bundle / "image-plan.json").is_file()


def test_packing_preserves_rename_error_without_destination(monkeypatch, tmp_path):
    def failed_rename(source, destination):
        raise OSError(errno.EACCES, "Permission denied")

    monkeypatch.setattr(Path, "rename", failed_rename)
    with pytest.raises(OSError) as failure:
        pack_bundle(REPO_ROOT, "modal", tmp_path)
    assert failure.value.errno == errno.EACCES


def test_relative_symlinks_and_executable_modes_survive_pack(tmp_path: Path) -> None:
    checkout = tmp_path / "checkout"
    shutil.copytree(
        REPO_ROOT,
        checkout,
        ignore=shutil.ignore_patterns(".git", "node_modules", ".venv", ".cache", "__pycache__"),
    )
    directory = checkout / "packages/sandbox-runtime/src/sandbox_runtime"
    (directory / "probe.sh").write_text("#!/bin/sh\nexit 0\n")
    (directory / "probe.sh").chmod(0o755)
    (directory / "probe-link.sh").symlink_to("probe.sh")
    bundle = pack_bundle(checkout, "e2b", tmp_path / "bundles")
    copied = bundle / "packages/sandbox-runtime/src/sandbox_runtime"
    assert (copied / "probe-link.sh").read_text() == "#!/bin/sh\nexit 0\n"
    assert (copied / "probe.sh").stat().st_mode & 0o111
    (directory / "escape.sh").symlink_to(tmp_path / "outside")
    with pytest.raises(ValueError, match="symlink"):
        plan_image(checkout, "e2b")
