"""Exercise the same plan/pack boundary used by native builders and Terraform."""

import json
import shutil
from pathlib import Path

import pytest

from sandbox_images.bundle import pack_bundle, plan_image

REPO_ROOT = Path(__file__).resolve().parents[3]


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
