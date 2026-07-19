"""Tests for the canonical session repository model."""

import json
from pathlib import Path

import pytest

from sandbox_runtime.repo_config import (
    RepoConfigError,
    RepoEntry,
    dump_repo_manifest,
    find_repo_entry,
    is_safe_repo_segment,
    load_repo_manifest,
    parse_repositories,
    read_repo_manifest,
)

WORKSPACE = Path("/workspace")


def _config(*entries: dict) -> dict:
    return {"repositories": list(entries)}


class TestIsSafeRepoSegment:
    @pytest.mark.parametrize("value", ["repo", "my-repo_1.2", ".github", "a"])
    def test_accepts_single_segments(self, value):
        assert is_safe_repo_segment(value) is True

    @pytest.mark.parametrize(
        "value",
        ["", ".", "..", "a/b", "/etc", "a\\b", "../escape", "a b", "a\x00b", "~user"],
    )
    def test_rejects_separators_and_traversal(self, value):
        assert is_safe_repo_segment(value) is False


class TestParseRepositories:
    def test_rejects_traversal_repo_name(self):
        config = _config({"repo_owner": "acme", "repo_name": "../../etc"})

        with pytest.raises(RepoConfigError, match="repo_name"):
            parse_repositories(config, workspace_path=WORKSPACE)

    def test_rejects_absolute_repo_name(self):
        config = _config({"repo_owner": "acme", "repo_name": "/tmp/x"})

        with pytest.raises(RepoConfigError, match="repo_name"):
            parse_repositories(config, workspace_path=WORKSPACE)

    def test_accepts_nested_namespace_owner(self):
        # Owners may be nested namespaces (e.g. GitLab subgroups); the owner is
        # never a filesystem path (checkout dirs derive from repo_name), so
        # slashes between safe segments are allowed.
        config = _config(
            {"repo_owner": "chattermill/frontend", "repo_name": "react-app", "branch": "master"},
            {"repo_owner": "chattermill/backend", "repo_name": "inspect", "branch": "main"},
        )

        entries = parse_repositories(config, workspace_path=WORKSPACE)

        assert [(e.owner, e.name) for e in entries] == [
            ("chattermill/frontend", "react-app"),
            ("chattermill/backend", "inspect"),
        ]

    @pytest.mark.parametrize("owner", ["a/../b", "..", "/etc", "a//b", "a/", "a b/c"])
    def test_rejects_unsafe_owner(self, owner):
        config = _config({"repo_owner": owner, "repo_name": "app"})

        with pytest.raises(RepoConfigError, match="repo_owner"):
            parse_repositories(config, workspace_path=WORKSPACE)

    def test_rejects_duplicate_names_across_owners_case_insensitively(self):
        config = _config(
            {"repo_owner": "acme", "repo_name": "App"},
            {"repo_owner": "globex", "repo_name": "app"},
        )

        with pytest.raises(RepoConfigError, match="duplicate"):
            parse_repositories(config, workspace_path=WORKSPACE)

    def test_skips_entries_missing_owner_or_name(self):
        config = _config(
            {"repo_owner": "acme", "repo_name": "app"},
            {"repo_owner": "", "repo_name": "ghost"},
            {"repo_name": "ghost2"},
            "not-a-dict",
        )

        entries = parse_repositories(config, workspace_path=WORKSPACE)

        assert [(e.owner, e.name) for e in entries] == [("acme", "app")]

    def test_validates_scalar_fallback(self):
        with pytest.raises(RepoConfigError, match="repo_name"):
            parse_repositories(
                {},
                workspace_path=WORKSPACE,
                scalar_owner="acme",
                scalar_name="../escape",
            )

    def test_paths_derive_from_workspace(self):
        config = _config({"repo_owner": "acme", "repo_name": "app", "branch": "dev"})

        entries = parse_repositories(config, workspace_path=WORKSPACE)

        assert entries == [
            RepoEntry(owner="acme", name="app", branch="dev", path=WORKSPACE / "app")
        ]

    @pytest.mark.parametrize("base_sha", ["abc123", "g" * 40, "a" * 41])
    def test_rejects_invalid_repository_baselines(self, base_sha):
        config = _config({"repo_owner": "acme", "repo_name": "app", "base_sha": base_sha})

        with pytest.raises(RepoConfigError, match="base_sha"):
            parse_repositories(config, workspace_path=WORKSPACE)

    def test_rejects_an_invalid_scalar_baseline(self):
        with pytest.raises(RepoConfigError, match="base_sha"):
            parse_repositories(
                {"base_sha": "not-a-sha"},
                workspace_path=WORKSPACE,
                scalar_owner="acme",
                scalar_name="app",
            )


FIND_ENTRIES = [
    RepoEntry(owner="Acme", name="Frontend", branch="main", path=WORKSPACE / "Frontend"),
    RepoEntry(owner="acme", name="backend", branch="dev", path=WORKSPACE / "backend"),
]


class TestFindRepoEntry:
    def test_matches_case_insensitively_returning_canonical_entry(self):
        entry = find_repo_entry(FIND_ENTRIES, "ACME", "frontend")

        assert entry is FIND_ENTRIES[0]

    def test_returns_none_for_non_member(self):
        assert find_repo_entry(FIND_ENTRIES, "acme", "missing") is None


class TestRepoManifest:
    def test_round_trips_entries(self, tmp_path):
        entries = [
            RepoEntry(owner="acme", name="frontend", branch="main", path=WORKSPACE / "frontend"),
            RepoEntry(owner="acme", name="backend", branch="dev", path=WORKSPACE / "backend"),
        ]
        manifest = tmp_path / "manifest.json"
        manifest.write_text(dump_repo_manifest(entries))

        assert load_repo_manifest(manifest) == entries

    def test_round_trips_the_immutable_session_diff_baseline(self, tmp_path):
        baseline = "a" * 40
        entries = [
            RepoEntry(
                owner="acme",
                name="frontend",
                branch="main",
                path=WORKSPACE / "frontend",
                base_sha=baseline,
            )
        ]
        manifest = tmp_path / "manifest.json"
        manifest.write_text(dump_repo_manifest(entries))

        assert load_repo_manifest(manifest)[0].base_sha == baseline

    def test_missing_file_loads_empty(self, tmp_path):
        assert load_repo_manifest(tmp_path / "absent.json") == []

    def test_malformed_file_loads_empty(self, tmp_path):
        manifest = tmp_path / "manifest.json"
        manifest.write_text("{not json")

        assert load_repo_manifest(manifest) == []

    def test_strict_reader_accepts_an_explicit_empty_manifest(self, tmp_path):
        manifest = tmp_path / "manifest.json"
        manifest.write_text('{"repositories": []}')

        assert read_repo_manifest(manifest) == []

    @pytest.mark.parametrize("content", [None, "{not json", "{}", '{"repositories": {}}'])
    def test_strict_reader_rejects_missing_or_malformed_manifests(self, tmp_path, content):
        manifest = tmp_path / "manifest.json"
        if content is not None:
            manifest.write_text(content)

        with pytest.raises(RepoConfigError, match="repository manifest"):
            read_repo_manifest(manifest)

    def test_invalid_baseline_loads_empty(self, tmp_path):
        manifest = tmp_path / "manifest.json"
        manifest.write_text(
            json.dumps(
                {
                    "repositories": [
                        {
                            "owner": "acme",
                            "name": "app",
                            "branch": "main",
                            "path": "/workspace/app",
                            "baseSha": "not-a-sha",
                        }
                    ]
                }
            )
        )

        assert load_repo_manifest(manifest) == []

    def test_skips_incomplete_entries(self, tmp_path):
        manifest = tmp_path / "manifest.json"
        manifest.write_text(
            json.dumps(
                {
                    "repositories": [
                        {"owner": "acme", "name": "app", "path": "/workspace/app"},
                        {"owner": "acme", "name": "no-path"},
                        {"name": "no-owner", "path": "/workspace/x"},
                    ]
                }
            )
        )

        entries = load_repo_manifest(manifest)

        assert [(e.owner, e.name) for e in entries] == [("acme", "app")]
