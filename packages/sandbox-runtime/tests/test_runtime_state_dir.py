"""Cross-boot runtime state lives where the provider says, in the temp directory otherwise."""

from pathlib import Path

from sandbox_runtime.constants import REPO_MANIFEST_FILE_NAME, STATE_DIR_ENV_VAR, runtime_state_dir


def test_defaults_to_the_given_directory_without_the_env():
    assert runtime_state_dir("/tmp", {}) == Path("/tmp")
    assert runtime_state_dir("/var/tmp", {STATE_DIR_ENV_VAR: ""}) == Path("/var/tmp")


def test_the_provider_state_directory_wins(tmp_path):
    assert runtime_state_dir("/tmp", {STATE_DIR_ENV_VAR: str(tmp_path)}) == tmp_path


def test_manifest_file_name_is_stable():
    assert REPO_MANIFEST_FILE_NAME == "oi-repo-manifest.json"
