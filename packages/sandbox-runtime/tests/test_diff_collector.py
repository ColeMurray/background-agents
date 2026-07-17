import subprocess
from pathlib import Path

import pytest

from sandbox_runtime.diff_collector import CaptureLimits, DiffCaptureError, collect_repository_diff
from sandbox_runtime.repo_config import RepoEntry


def _git(repo: Path, *args: str) -> str:
    result = subprocess.run(["git", *args], cwd=repo, check=True, capture_output=True, text=True)
    return result.stdout.strip()


def _repository(tmp_path: Path) -> tuple[RepoEntry, str]:
    repo_path = tmp_path / "viewer"
    repo_path.mkdir()
    _git(repo_path, "init", "-b", "main")
    _git(repo_path, "config", "user.name", "Diff Test")
    _git(repo_path, "config", "user.email", "diff@example.com")
    (repo_path / "app.ts").write_text("const value = 1;\n")
    _git(repo_path, "add", "app.ts")
    _git(repo_path, "commit", "-m", "baseline")
    return RepoEntry("open-inspect", "viewer", "main", repo_path), _git(
        repo_path, "rev-parse", "HEAD"
    )


@pytest.mark.asyncio
async def test_collects_a_text_change_relative_to_the_fixed_baseline(tmp_path: Path) -> None:
    repository, base_sha = _repository(tmp_path)
    (repository.path / "app.ts").write_text("const value = 2;\nconst added = true;\n")

    capture = await collect_repository_diff(repository, base_sha, CaptureLimits.defaults())

    assert capture.head_sha == base_sha
    assert capture.truncated is False
    assert capture.omitted_file_count == 0
    assert len(capture.files) == 1
    changed = capture.files[0]
    assert changed.path == "app.ts"
    assert changed.status == "modified"
    assert changed.additions == 2
    assert changed.deletions == 1
    assert changed.render_state == "renderable"
    assert "-const value = 1;" in changed.patch
    assert "+const value = 2;" in changed.patch


@pytest.mark.asyncio
async def test_collects_committed_staged_and_unstaged_changes(tmp_path: Path) -> None:
    repository, base_sha = _repository(tmp_path)
    (repository.path / "committed.txt").write_text("committed\n")
    _git(repository.path, "add", "committed.txt")
    _git(repository.path, "commit", "-m", "session commit")
    (repository.path / "staged.txt").write_text("staged\n")
    _git(repository.path, "add", "staged.txt")
    (repository.path / "app.ts").write_text("const value = 2;\n")

    capture = await collect_repository_diff(repository, base_sha, CaptureLimits.defaults())

    changes = {changed.path: changed for changed in capture.files}
    assert capture.head_sha != base_sha
    assert set(changes) == {"app.ts", "committed.txt", "staged.txt"}
    assert changes["app.ts"].status == "modified"
    assert changes["committed.txt"].status == "added"
    assert changes["staged.txt"].status == "added"


@pytest.mark.asyncio
async def test_collects_deletions_and_omits_reverted_edits(tmp_path: Path) -> None:
    repository, _ = _repository(tmp_path)
    (repository.path / "reverted.txt").write_text("original\n")
    _git(repository.path, "add", "reverted.txt")
    _git(repository.path, "commit", "-m", "add revert fixture")
    base_sha = _git(repository.path, "rev-parse", "HEAD")
    (repository.path / "app.ts").unlink()
    (repository.path / "reverted.txt").write_text("temporary edit\n")
    (repository.path / "reverted.txt").write_text("original\n")

    capture = await collect_repository_diff(repository, base_sha, CaptureLimits.defaults())

    assert len(capture.files) == 1
    changed = capture.files[0]
    assert changed.path == "app.ts"
    assert changed.status == "deleted"
    assert changed.render_state == "renderable"


@pytest.mark.asyncio
async def test_collects_untracked_files_and_excludes_ignored_files(tmp_path: Path) -> None:
    repository, base_sha = _repository(tmp_path)
    (repository.path / ".gitignore").write_text("ignored.log\n")
    _git(repository.path, "add", ".gitignore")
    _git(repository.path, "commit", "-m", "ignore generated logs")
    base_sha = _git(repository.path, "rev-parse", "HEAD")
    (repository.path / "new file.txt").write_text("first\nsecond\n")
    (repository.path / "ignored.log").write_text("secret\n")

    capture = await collect_repository_diff(repository, base_sha, CaptureLimits.defaults())

    assert [file.path for file in capture.files] == ["new file.txt"]
    assert capture.files[0].status == "added"
    assert capture.files[0].additions == 2
    assert "new file.txt" in (capture.files[0].patch or "")


@pytest.mark.asyncio
async def test_normalizes_a_staged_deletion_recreated_as_untracked(tmp_path: Path) -> None:
    repository, base_sha = _repository(tmp_path)
    _git(repository.path, "rm", "--cached", "app.ts")

    capture = await collect_repository_diff(repository, base_sha, CaptureLimits.defaults())

    assert len(capture.files) == 1
    changed = capture.files[0]
    assert changed.path == "app.ts"
    assert changed.status == "modified"
    assert changed.additions == 1
    assert changed.deletions == 1
    assert changed.render_state == "metadata_only"
    assert changed.patch is None


@pytest.mark.asyncio
async def test_reports_the_exact_uploaded_size_for_non_utf8_text(tmp_path: Path) -> None:
    repository, base_sha = _repository(tmp_path)
    (repository.path / "legacy.txt").write_bytes(b"caf\xe9\n")

    capture = await collect_repository_diff(repository, base_sha, CaptureLimits.defaults())

    changed = capture.files[0]
    assert changed.render_state == "renderable"
    assert changed.patch is not None
    assert "\ufffd" in changed.patch
    assert changed.patch_bytes == len(changed.patch.encode("utf-8"))


@pytest.mark.asyncio
async def test_preserves_unicode_whitespace_and_newline_filename_edges(tmp_path: Path) -> None:
    repository, base_sha = _repository(tmp_path)
    path = "caf\u00e9 line\nbreak.txt"
    (repository.path / path).write_text("no trailing newline")

    capture = await collect_repository_diff(repository, base_sha, CaptureLimits.defaults())

    changed = capture.files[0]
    assert changed.path == path
    assert changed.status == "added"
    assert changed.additions == 1
    assert changed.render_state == "renderable"
    assert "No newline at end of file" in (changed.patch or "")


@pytest.mark.asyncio
async def test_represents_a_mode_only_change_as_metadata(tmp_path: Path) -> None:
    repository, base_sha = _repository(tmp_path)
    (repository.path / "app.ts").chmod(0o755)

    capture = await collect_repository_diff(repository, base_sha, CaptureLimits.defaults())

    assert len(capture.files) == 1
    changed = capture.files[0]
    assert changed.path == "app.ts"
    assert changed.render_state == "metadata_only"
    assert changed.old_mode == "100644"
    assert changed.new_mode == "100755"
    assert changed.patch is None


@pytest.mark.asyncio
async def test_collects_a_symlink_target_change(tmp_path: Path) -> None:
    repository, _ = _repository(tmp_path)
    (repository.path / "target-a").write_text("a\n")
    (repository.path / "target-b").write_text("b\n")
    (repository.path / "current").symlink_to("target-a")
    _git(repository.path, "add", ".")
    _git(repository.path, "commit", "-m", "add symlink")
    base_sha = _git(repository.path, "rev-parse", "HEAD")
    (repository.path / "current").unlink()
    (repository.path / "current").symlink_to("target-b")

    capture = await collect_repository_diff(repository, base_sha, CaptureLimits.defaults())

    changed = capture.files[0]
    assert changed.path == "current"
    assert changed.status == "modified"
    assert changed.render_state == "renderable"
    assert "-target-a" in (changed.patch or "")
    assert "+target-b" in (changed.patch or "")


@pytest.mark.asyncio
async def test_preserves_a_pure_rename_as_one_zero_stat_record(tmp_path: Path) -> None:
    repository, base_sha = _repository(tmp_path)
    _git(repository.path, "mv", "app.ts", "renamed app.ts")

    capture = await collect_repository_diff(repository, base_sha, CaptureLimits.defaults())

    assert len(capture.files) == 1
    changed = capture.files[0]
    assert changed.status == "renamed"
    assert changed.old_path == "app.ts"
    assert changed.path == "renamed app.ts"
    assert changed.additions == 0
    assert changed.deletions == 0


@pytest.mark.asyncio
async def test_marks_binary_content_without_attempting_to_render_it(tmp_path: Path) -> None:
    repository, base_sha = _repository(tmp_path)
    (repository.path / "asset.bin").write_bytes(b"\x00before")
    _git(repository.path, "add", "asset.bin")
    _git(repository.path, "commit", "-m", "add binary")
    base_sha = _git(repository.path, "rev-parse", "HEAD")
    (repository.path / "asset.bin").write_bytes(b"\x00after")

    capture = await collect_repository_diff(repository, base_sha, CaptureLimits.defaults())

    changed = capture.files[0]
    assert changed.render_state == "binary"
    assert changed.additions is None
    assert changed.deletions is None
    assert changed.patch is None


@pytest.mark.asyncio
async def test_reports_submodule_gitlinks_and_object_ids_as_metadata(tmp_path: Path) -> None:
    repository, _ = _repository(tmp_path)
    first = _git(repository.path, "rev-parse", "HEAD")
    (repository.path / "other.txt").write_text("second object\n")
    _git(repository.path, "add", "other.txt")
    _git(repository.path, "commit", "-m", "second object")
    second = _git(repository.path, "rev-parse", "HEAD")
    _git(repository.path, "clone", ".", "vendor/lib")
    _git(repository.path, "update-index", "--add", "--cacheinfo", f"160000,{first},vendor/lib")
    _git(repository.path, "commit", "-m", "add gitlink")
    base_sha = _git(repository.path, "rev-parse", "HEAD")
    _git(repository.path, "update-index", "--cacheinfo", f"160000,{second},vendor/lib")

    capture = await collect_repository_diff(repository, base_sha, CaptureLimits.defaults())

    changed = next(file for file in capture.files if file.path == "vendor/lib")
    assert changed.status == "submodule"
    assert changed.render_state == "metadata_only"
    assert changed.old_submodule_sha == first
    assert changed.new_submodule_sha == second


@pytest.mark.asyncio
async def test_enforces_file_and_capture_byte_limits_with_explicit_states(tmp_path: Path) -> None:
    repository, base_sha = _repository(tmp_path)
    (repository.path / "app.ts").write_text("const changed = 'a fairly long line';\n")
    (repository.path / "new.ts").write_text("export const value = 1;\n")
    limits = CaptureLimits(
        max_files=1,
        max_patch_bytes=10,
        max_capture_bytes=10,
        command_timeout_seconds=5,
    )

    capture = await collect_repository_diff(repository, base_sha, limits)

    assert capture.truncated is True
    assert capture.omitted_file_count == 1
    assert capture.files[0].render_state == "too_large"
    assert capture.files[0].patch is None


@pytest.mark.asyncio
async def test_fails_safely_when_change_metadata_exceeds_its_memory_limit(tmp_path: Path) -> None:
    repository, base_sha = _repository(tmp_path)
    (repository.path / "app.ts").write_text("const value = 2;\n")
    limits = CaptureLimits(
        max_files=1_000,
        max_patch_bytes=1_000_000,
        max_capture_bytes=20_000_000,
        command_timeout_seconds=5,
        max_metadata_bytes=4,
    )

    with pytest.raises(DiffCaptureError, match="change metadata exceeded"):
        await collect_repository_diff(repository, base_sha, limits)
