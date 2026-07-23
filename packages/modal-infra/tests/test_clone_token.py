"""Tests for VCS clone token resolution."""

import pytest

from src.clone_token import resolve_clone_token


@pytest.fixture(autouse=True)
def clear_clone_token_env(monkeypatch: pytest.MonkeyPatch) -> None:
    for name in [
        "SCM_PROVIDER",
        "GITLAB_ACCESS_TOKEN",
        "GITHUB_APP_ID",
        "GITHUB_APP_PRIVATE_KEY",
        "GITHUB_APP_INSTALLATION_ID",
    ]:
        monkeypatch.delenv(name, raising=False)


def test_resolve_clone_token_uses_gitlab_access_token(monkeypatch):
    monkeypatch.setenv("SCM_PROVIDER", "gitlab")
    monkeypatch.setenv("GITLAB_ACCESS_TOKEN", "glpat-token")

    assert resolve_clone_token() == "glpat-token"


def test_resolve_clone_token_returns_none_for_missing_gitlab_token(monkeypatch):
    monkeypatch.setenv("SCM_PROVIDER", "gitlab")

    assert resolve_clone_token() is None


def test_resolve_clone_token_generates_github_installation_token(monkeypatch):
    monkeypatch.setenv("GITHUB_APP_ID", "123")
    monkeypatch.setenv("GITHUB_APP_PRIVATE_KEY", "private-key")
    monkeypatch.setenv("GITHUB_APP_INSTALLATION_ID", "456")
    captured = {}

    def fake_generate_installation_token(**kwargs):
        captured.update(kwargs)
        return "ghs-token"

    monkeypatch.setattr("src.auth.generate_installation_token", fake_generate_installation_token)

    assert resolve_clone_token() == "ghs-token"
    assert captured == {
        "app_id": "123",
        "private_key": "private-key",
        "installation_id": "456",
    }


def test_resolve_clone_token_returns_none_when_github_credentials_incomplete(monkeypatch):
    monkeypatch.setenv("GITHUB_APP_ID", "123")
    monkeypatch.setenv("GITHUB_APP_INSTALLATION_ID", "456")

    def fail_if_called(**_kwargs):
        raise AssertionError("generate_installation_token should not be called")

    monkeypatch.setattr("src.auth.generate_installation_token", fail_if_called)

    assert resolve_clone_token() is None


def test_resolve_clone_token_returns_none_when_github_generation_fails(monkeypatch):
    monkeypatch.setenv("GITHUB_APP_ID", "123")
    monkeypatch.setenv("GITHUB_APP_PRIVATE_KEY", "private-key")
    monkeypatch.setenv("GITHUB_APP_INSTALLATION_ID", "456")

    def raise_from_generate(**_kwargs):
        raise RuntimeError("token generation failed")

    monkeypatch.setattr("src.auth.generate_installation_token", raise_from_generate)

    assert resolve_clone_token() is None
