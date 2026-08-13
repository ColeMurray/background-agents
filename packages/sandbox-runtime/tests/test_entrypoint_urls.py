"""Tests for RepositorySynchronizer._build_repo_url().

The supervisor no longer embeds credentials in remote URLs — authentication
flows through the system-wide git credential helper, which fetches fresh
tokens from the control plane per request. The URL builder is therefore
purely a function of host, owner, and name.
"""

from unittest.mock import patch

from sandbox_runtime.repository_boot import RepositoryBoot
from tests.runtime_helpers import make_repository_boot


def _make_repository_boot(env_overrides: dict[str, str] | None = None) -> RepositoryBoot:
    """Create a RepositoryBoot with controlled env vars."""
    base_env = {
        "SANDBOX_ID": "test-sandbox",
        "CONTROL_PLANE_URL": "https://cp.example.com",
        "SANDBOX_AUTH_TOKEN": "tok",
        "REPO_OWNER": "acme",
        "REPO_NAME": "app",
    }
    if env_overrides:
        base_env.update(env_overrides)
    with patch.dict("os.environ", base_env, clear=True):
        return make_repository_boot()


class TestBuildRepoUrl:
    def test_github_default(self) -> None:
        sup = _make_repository_boot({"VCS_HOST": "github.com"})
        assert (
            sup.synchronizer._build_repo_url(sup.repositories[0])
            == "https://github.com/acme/app.git"
        )

    def test_bitbucket(self) -> None:
        sup = _make_repository_boot({"VCS_HOST": "bitbucket.org"})
        assert (
            sup.synchronizer._build_repo_url(sup.repositories[0])
            == "https://bitbucket.org/acme/app.git"
        )

    def test_defaults_to_github(self) -> None:
        sup = _make_repository_boot()
        assert (
            sup.synchronizer._build_repo_url(sup.repositories[0])
            == "https://github.com/acme/app.git"
        )

    def test_token_env_vars_are_ignored(self) -> None:
        """Stale snapshot tokens in env must NOT leak into the remote URL."""
        sup = _make_repository_boot(
            {
                "VCS_CLONE_TOKEN": "ghp_stale",
                "GITHUB_APP_TOKEN": "ghp_legacy",
                "GITHUB_TOKEN": "ghp_legacy_2",
            }
        )
        assert (
            sup.synchronizer._build_repo_url(sup.repositories[0])
            == "https://github.com/acme/app.git"
        )
