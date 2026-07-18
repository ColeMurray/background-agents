import os
import subprocess
import time
from pathlib import Path

import pytest

import sandbox_runtime.diff_collector as diff_collector_module
from sandbox_runtime.diff_collector import (
    CapturedFile,
    CaptureLimits,
    DiffCaptureError,
    RepositoryCapture,
    collect_repository_diff,
    collect_session_diff_bundle,
)
from sandbox_runtime.git_excludes import install_runtime_git_excludes
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
async def test_ignores_replacement_refs_when_resolving_the_fixed_baseline(tmp_path: Path) -> None:
    repository, base_sha = _repository(tmp_path)
    (repository.path / "app.ts").write_text("const value = 2;\n")
    _git(repository.path, "add", "app.ts")
    _git(repository.path, "commit", "-m", "replacement object")
    replacement_sha = _git(repository.path, "rev-parse", "HEAD")
    _git(repository.path, "reset", "--hard", base_sha)
    _git(repository.path, "replace", base_sha, replacement_sha)
    (repository.path / "app.ts").write_text("const value = 2;\n")

    capture = await collect_repository_diff(repository, base_sha, CaptureLimits.defaults())

    assert [changed.path for changed in capture.files] == ["app.ts"]
    assert capture.files[0].status == "modified"
    assert "-const value = 1;" in (capture.files[0].patch or "")
    assert "+const value = 2;" in (capture.files[0].patch or "")


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
async def test_returns_an_empty_ready_diff_for_an_unchanged_checkout(tmp_path: Path) -> None:
    repository, base_sha = _repository(tmp_path)

    capture = await collect_repository_diff(repository, base_sha, CaptureLimits.defaults())

    assert capture.head_sha == base_sha
    assert capture.files == ()
    assert capture.truncated is False


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
async def test_checkout_local_runtime_excludes_do_not_hide_other_opencode_changes(
    tmp_path: Path,
) -> None:
    repository, base_sha = _repository(tmp_path)
    runtime_file = repository.path / ".opencode" / "tool" / "spawn-task.js"
    runtime_file.parent.mkdir(parents=True)
    runtime_file.write_text("// runtime\n")
    user_file = repository.path / ".opencode" / "command" / "review.md"
    user_file.parent.mkdir(parents=True)
    user_file.write_text("user-authored command\n")
    install_runtime_git_excludes(repository.path, {".opencode/tool/spawn-task.js"})

    capture = await collect_repository_diff(repository, base_sha, CaptureLimits.defaults())

    assert [changed.path for changed in capture.files] == [".opencode/command/review.md"]


@pytest.mark.asyncio
async def test_runtime_ownership_overrides_gitignore_negation(tmp_path: Path) -> None:
    repository, _ = _repository(tmp_path)
    (repository.path / ".gitignore").write_text("!.opencode/tool/spawn-task.js\n")
    _git(repository.path, "add", ".gitignore")
    _git(repository.path, "commit", "-m", "re-include runtime tool")
    base_sha = _git(repository.path, "rev-parse", "HEAD")
    runtime_file = repository.path / ".opencode" / "tool" / "spawn-task.js"
    runtime_file.parent.mkdir(parents=True)
    runtime_file.write_text("// runtime\n")
    install_runtime_git_excludes(repository.path, {".opencode/tool/spawn-task.js"})

    assert _git(repository.path, "ls-files", "--others", "--exclude-standard") == (
        ".opencode/tool/spawn-task.js"
    )

    capture = await collect_repository_diff(repository, base_sha, CaptureLimits.defaults())

    assert capture.files == ()


@pytest.mark.asyncio
async def test_checkout_local_excludes_do_not_hide_tracked_changes(tmp_path: Path) -> None:
    repository, _ = _repository(tmp_path)
    runtime_file = repository.path / ".opencode" / "tool" / "spawn-task.js"
    runtime_file.parent.mkdir(parents=True)
    runtime_file.write_text("// checked in\n")
    _git(repository.path, "add", ".opencode/tool/spawn-task.js")
    _git(repository.path, "commit", "-m", "track opencode tool")
    base_sha = _git(repository.path, "rev-parse", "HEAD")
    install_runtime_git_excludes(repository.path, {".opencode/tool/spawn-task.js"})
    runtime_file.write_text("// runtime overwrite\n")

    capture = await collect_repository_diff(repository, base_sha, CaptureLimits.defaults())

    assert [changed.path for changed in capture.files] == [".opencode/tool/spawn-task.js"]


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
async def test_treats_repository_filenames_as_literal_git_pathspecs(tmp_path: Path) -> None:
    repository, _ = _repository(tmp_path)
    magic_path = ":(glob)*.txt"
    other_path = "other.txt"
    (repository.path / magic_path).write_text("magic before\n")
    (repository.path / other_path).write_text("other before\n")
    _git(repository.path, "add", "--all")
    _git(repository.path, "commit", "-m", "add pathspec fixtures")
    base_sha = _git(repository.path, "rev-parse", "HEAD")
    (repository.path / magic_path).write_text("magic after\n")
    (repository.path / other_path).write_text("other after\n")

    capture = await collect_repository_diff(repository, base_sha, CaptureLimits.defaults())

    changes = {changed.path: changed for changed in capture.files}
    assert set(changes) == {magic_path, other_path}
    magic_patch = changes[magic_path].patch or ""
    assert "+magic after" in magic_patch
    assert "other.txt" not in magic_patch


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
async def test_preserves_a_rename_with_content_changes(tmp_path: Path) -> None:
    repository, _ = _repository(tmp_path)
    original = "\n".join(f"const value{index} = {index};" for index in range(5)) + "\n"
    (repository.path / "app.ts").write_text(original)
    _git(repository.path, "add", "app.ts")
    _git(repository.path, "commit", "--amend", "--no-edit")
    base_sha = _git(repository.path, "rev-parse", "HEAD")
    _git(repository.path, "mv", "app.ts", "renamed.ts")
    (repository.path / "renamed.ts").write_text(f"{original}const added = true;\n")

    capture = await collect_repository_diff(repository, base_sha, CaptureLimits.defaults())

    assert len(capture.files) == 1
    changed = capture.files[0]
    assert changed.status == "renamed"
    assert changed.old_path == "app.ts"
    assert changed.path == "renamed.ts"
    assert changed.render_state == "renderable"
    assert "+const added = true;" in (changed.patch or "")


@pytest.mark.asyncio
async def test_reports_an_unmerged_path_without_traversing_conflict_stages(tmp_path: Path) -> None:
    repository, base_sha = _repository(tmp_path)
    _git(repository.path, "checkout", "-b", "other")
    (repository.path / "app.ts").write_text("const value = 'other';\n")
    _git(repository.path, "add", "app.ts")
    _git(repository.path, "commit", "-m", "other change")
    _git(repository.path, "checkout", "main")
    (repository.path / "app.ts").write_text("const value = 'main';\n")
    _git(repository.path, "add", "app.ts")
    _git(repository.path, "commit", "-m", "main change")
    merge = subprocess.run(
        ["git", "merge", "other"],
        cwd=repository.path,
        check=False,
        capture_output=True,
        text=True,
    )
    assert merge.returncode != 0

    capture = await collect_repository_diff(repository, base_sha, CaptureLimits.defaults())

    changed = next(file for file in capture.files if file.path == "app.ts")
    assert changed.status == "unmerged"


@pytest.mark.asyncio
async def test_marks_binary_content_without_attempting_to_render_it(tmp_path: Path) -> None:
    repository, base_sha = _repository(tmp_path)
    (repository.path / "asset.bin").write_bytes(b"\x00before")
    _git(repository.path, "add", "asset.bin")
    _git(repository.path, "commit", "-m", "add binary")
    base_sha = _git(repository.path, "rev-parse", "HEAD")
    (repository.path / "asset.bin").write_bytes(b"\x00after")
    (repository.path / "asset.bin").chmod(0o755)

    capture = await collect_repository_diff(repository, base_sha, CaptureLimits.defaults())

    changed = capture.files[0]
    assert changed.render_state == "binary"
    assert changed.additions is None
    assert changed.deletions is None
    assert changed.patch is None
    assert changed.old_mode == "100644"
    assert changed.new_mode == "100755"


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

    limits = CaptureLimits(
        max_files=1_000,
        max_patch_bytes=1,
        max_capture_bytes=20_000_000,
        command_timeout_seconds=5,
    )

    capture = await collect_repository_diff(repository, base_sha, limits)

    changed = next(file for file in capture.files if file.path == "vendor/lib")
    assert changed.status == "submodule"
    assert changed.render_state == "metadata_only"
    assert changed.old_submodule_sha == first
    assert changed.new_submodule_sha == second


@pytest.mark.asyncio
async def test_resolves_an_unstaged_submodule_head_move(tmp_path: Path) -> None:
    repository, _ = _repository(tmp_path)
    submodule_path = repository.path / "vendor/lib"
    submodule_path.mkdir(parents=True)
    _git(submodule_path, "init", "-b", "main")
    _git(submodule_path, "config", "user.name", "Diff Test")
    _git(submodule_path, "config", "user.email", "diff@example.com")
    (submodule_path / "value.txt").write_text("first\n")
    _git(submodule_path, "add", "value.txt")
    _git(submodule_path, "commit", "-m", "first submodule revision")
    first = _git(submodule_path, "rev-parse", "HEAD")
    _git(repository.path, "add", "vendor/lib")
    _git(repository.path, "commit", "-m", "add submodule checkout")
    base_sha = _git(repository.path, "rev-parse", "HEAD")
    (submodule_path / "value.txt").write_text("second\n")
    _git(submodule_path, "add", "value.txt")
    _git(submodule_path, "commit", "-m", "second submodule revision")
    second = _git(submodule_path, "rev-parse", "HEAD")

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
    (repository.path / "app.ts").chmod(0o755)
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
    assert capture.files[0].old_mode == "100644"
    assert capture.files[0].new_mode == "100755"


@pytest.mark.asyncio
async def test_marks_patches_over_the_aggregate_budget_as_too_large(tmp_path: Path) -> None:
    repository, base_sha = _repository(tmp_path)
    (repository.path / "app.ts").write_text("const value = 2;\n")
    (repository.path / "second.ts").write_text("export const second = true;\n")
    limits = CaptureLimits(
        max_files=1_000,
        max_patch_bytes=10_000,
        max_capture_bytes=200,
        command_timeout_seconds=5,
    )

    capture = await collect_repository_diff(repository, base_sha, limits)

    assert len(capture.files) == 2
    assert [file.render_state for file in capture.files].count("renderable") == 1
    assert [file.render_state for file in capture.files].count("too_large") == 1


@pytest.mark.asyncio
async def test_sheds_largest_patches_until_the_encoded_bundle_fits(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    repository = RepoEntry("open-inspect", "viewer", "main", tmp_path / "viewer", base_sha="a" * 40)
    repository.path.mkdir()
    files = tuple(
        CapturedFile(
            id=f"file-{index}",
            path=f"src/{index}.ts",
            old_path=None,
            status="modified",
            additions=1,
            deletions=1,
            render_state="renderable",
            patch="x" * size,
            patch_bytes=size,
        )
        for index, size in enumerate((600, 300))
    )

    async def collect(*_args, **_kwargs):
        return RepositoryCapture(repository, "a" * 40, "b" * 40, files, False, 0)

    monkeypatch.setattr(diff_collector_module, "collect_repository_diff", collect)
    limits = CaptureLimits(
        max_files=1_000,
        max_patch_bytes=1_000,
        max_capture_bytes=2_000,
        command_timeout_seconds=5,
        max_bundle_bytes=1_000,
    )

    bundle = await collect_session_diff_bundle(
        [repository], trigger_message_id="message-1", captured_at=100, limits=limits
    )

    changed = bundle["repositories"][0]["files"]
    assert changed[0]["renderState"] == "too_large"
    assert "patch" not in changed[0]
    assert changed[1]["renderState"] == "renderable"
    assert len(diff_collector_module.encode_bundle(bundle)) <= limits.max_bundle_bytes


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


@pytest.mark.asyncio
async def test_fails_a_repository_when_git_exceeds_the_command_timeout(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    repository, base_sha = _repository(tmp_path)
    bin_path = tmp_path / "bin"
    bin_path.mkdir()
    git = bin_path / "git"
    git.write_text("#!/usr/bin/env python3\nimport time\ntime.sleep(10)\n")
    git.chmod(0o755)
    monkeypatch.setenv("PATH", f"{bin_path}:{os.environ['PATH']}")
    limits = CaptureLimits(
        max_files=1_000,
        max_patch_bytes=1_000_000,
        max_capture_bytes=20_000_000,
        command_timeout_seconds=0.01,
    )
    started_at = time.monotonic()

    with pytest.raises(DiffCaptureError, match="Git command timed out"):
        await collect_repository_diff(repository, base_sha, limits)

    assert time.monotonic() - started_at < 1


@pytest.mark.asyncio
async def test_rejects_a_missing_start_commit(tmp_path: Path) -> None:
    repository, _ = _repository(tmp_path)

    with pytest.raises(DiffCaptureError, match="Git command failed"):
        await collect_repository_diff(repository, "f" * 40, CaptureLimits.defaults())


@pytest.mark.asyncio
async def test_bounds_a_multi_repository_bundle_to_one_thousand_files(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    repositories = [
        RepoEntry("open-inspect", "web", "main", tmp_path / "web", base_sha="a" * 40),
        RepoEntry("open-inspect", "api", "main", tmp_path / "api", base_sha="b" * 40),
    ]
    for repository in repositories:
        repository.path.mkdir()

    async def collect(repository: RepoEntry, base_sha: str, limits: CaptureLimits):
        requested = 800 if repository.name == "web" else 300
        count = min(requested, limits.max_files)
        files = tuple(
            CapturedFile(
                id=f"{repository.name}-{index}",
                path=f"src/{index}.ts",
                old_path=None,
                status="modified",
                additions=0,
                deletions=0,
                render_state="metadata_only",
                patch=None,
                patch_bytes=None,
            )
            for index in range(count)
        )
        return RepositoryCapture(
            repository,
            base_sha,
            "c" * 40,
            files,
            count < requested,
            requested - count,
        )

    monkeypatch.setattr(diff_collector_module, "collect_repository_diff", collect)

    bundle = await collect_session_diff_bundle(
        repositories,
        trigger_message_id=None,
        captured_at=100,
    )

    outcomes = bundle["repositories"]
    assert sum(len(outcome["files"]) for outcome in outcomes) == 1_000
    assert outcomes[1]["truncated"] is True
    assert outcomes[1]["omittedFileCount"] == 100


@pytest.mark.asyncio
async def test_disables_external_diff_and_textconv_drivers(tmp_path: Path) -> None:
    repository, _ = _repository(tmp_path)
    marker = tmp_path / "driver-ran"
    driver = tmp_path / "diff-driver.sh"
    driver.write_text(f"#!/bin/sh\ntouch '{marker}'\ncat \"$1\"\n")
    driver.chmod(0o755)
    (repository.path / ".gitattributes").write_text("app.ts diff=custom\n")
    _git(repository.path, "add", ".gitattributes")
    _git(repository.path, "commit", "-m", "add diff attributes")
    base_sha = _git(repository.path, "rev-parse", "HEAD")
    _git(repository.path, "config", "diff.external", str(driver))
    _git(repository.path, "config", "diff.custom.textconv", str(driver))
    (repository.path / "app.ts").write_text("const value = 2;\n")

    capture = await collect_repository_diff(repository, base_sha, CaptureLimits.defaults())

    assert capture.files[0].render_state == "renderable"
    assert marker.exists() is False


def test_rejects_unknown_git_status_letter() -> None:
    record = f":100644 100644 {'a' * 40} {'b' * 40} Q".encode() + b"\0file.txt\0"

    with pytest.raises(DiffCaptureError, match="Unsupported Git status letter"):
        diff_collector_module._parse_raw_changes(record)


def test_truncates_errors_by_utf16_code_units_not_code_points() -> None:
    limit = diff_collector_module.SESSION_DIFF_MAX_ERROR_LENGTH
    astral = "\U0001f4a5" * 1_500  # each character is two UTF-16 code units

    truncated = diff_collector_module.truncate_error_message(astral)

    assert truncated == "\U0001f4a5" * (limit // 2)
    assert len(truncated.encode("utf-16-le")) // 2 == limit
    assert diff_collector_module.truncate_error_message("a" * (limit + 1_000)) == "a" * limit
    assert diff_collector_module.truncate_error_message("short") == "short"
