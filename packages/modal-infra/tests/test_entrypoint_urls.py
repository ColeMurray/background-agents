"""Tests for SandboxSupervisor._build_repo_url()."""

from unittest.mock import patch

from src.sandbox.entrypoint import SandboxSupervisor


def _make_supervisor(env_overrides: dict[str, str] | None = None) -> SandboxSupervisor:
    """Create a SandboxSupervisor with controlled env vars."""
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
        return SandboxSupervisor()


class TestBuildRepoUrl:
    def test_github_authenticated(self):
        sup = _make_supervisor(
            {
                "VCS_HOST": "github.com",
                "VCS_CLONE_USERNAME": "x-access-token",
                "VCS_CLONE_TOKEN": "ghp_abc123",
            }
        )
        url = sup._build_repo_url()
        assert url == "https://x-access-token:ghp_abc123@github.com/acme/app.git"

    def test_github_unauthenticated(self):
        sup = _make_supervisor(
            {
                "VCS_HOST": "github.com",
                "VCS_CLONE_USERNAME": "x-access-token",
            }
        )
        url = sup._build_repo_url()
        assert url == "https://github.com/acme/app.git"

    def test_bitbucket_authenticated(self):
        sup = _make_supervisor(
            {
                "VCS_HOST": "bitbucket.org",
                "VCS_CLONE_USERNAME": "x-token-auth",
                "VCS_CLONE_TOKEN": "bb_token_xyz",
            }
        )
        url = sup._build_repo_url()
        assert url == "https://x-token-auth:bb_token_xyz@bitbucket.org/acme/app.git"

    def test_bitbucket_unauthenticated(self):
        sup = _make_supervisor(
            {
                "VCS_HOST": "bitbucket.org",
                "VCS_CLONE_USERNAME": "x-token-auth",
            }
        )
        url = sup._build_repo_url()
        assert url == "https://bitbucket.org/acme/app.git"

    def test_authenticated_false_with_token(self):
        """authenticated=False returns unauthenticated URL even when token is present."""
        sup = _make_supervisor(
            {
                "VCS_HOST": "github.com",
                "VCS_CLONE_USERNAME": "x-access-token",
                "VCS_CLONE_TOKEN": "ghp_abc123",
            }
        )
        url = sup._build_repo_url(authenticated=False)
        assert url == "https://github.com/acme/app.git"

    def test_defaults_to_github(self):
        """No VCS_* env vars → falls back to github.com defaults."""
        sup = _make_supervisor()
        url = sup._build_repo_url()
        assert url == "https://github.com/acme/app.git"

    def test_legacy_github_app_token_fallback(self):
        """VCS_CLONE_TOKEN unset, GITHUB_APP_TOKEN set → uses legacy fallback."""
        sup = _make_supervisor(
            {
                "VCS_HOST": "github.com",
                "VCS_CLONE_USERNAME": "x-access-token",
                "GITHUB_APP_TOKEN": "ghp_legacy",
            }
        )
        url = sup._build_repo_url()
        assert url == "https://x-access-token:ghp_legacy@github.com/acme/app.git"
