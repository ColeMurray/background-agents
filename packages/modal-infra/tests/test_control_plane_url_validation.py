"""Tests for control-plane callback URL admission.

The sandbox API receives callback URLs from the control plane. Host validation is
the guardrail that prevents a compromised or malformed request from sending
sandbox callbacks to an unexpected destination.
"""

import pytest

from src.app import validate_control_plane_url


@pytest.mark.parametrize("url", [None, ""])
def test_control_plane_url_allows_empty_optional_values(monkeypatch, url):
    monkeypatch.delenv("ALLOWED_CONTROL_PLANE_HOSTS", raising=False)

    assert validate_control_plane_url(url) is True


def test_control_plane_url_fails_closed_without_allowed_hosts(monkeypatch):
    monkeypatch.delenv("ALLOWED_CONTROL_PLANE_HOSTS", raising=False)

    assert validate_control_plane_url("https://control-plane.example") is False


@pytest.mark.parametrize(
    "url",
    [
        "https://control-plane.example/api/callback",
        "https://CONTROL-PLANE.EXAMPLE/api/callback",
        "https://localhost:8787/api/callback",
    ],
)
def test_control_plane_url_allows_configured_hosts(monkeypatch, url):
    monkeypatch.setenv(
        "ALLOWED_CONTROL_PLANE_HOSTS",
        " control-plane.example , LOCALHOST:8787 ",
    )

    assert validate_control_plane_url(url) is True


@pytest.mark.parametrize(
    "url",
    [
        "https://evil-control-plane.example/api/callback",
        "https://control-plane.example.evil.test/api/callback",
        "https://control-plane.example:443/api/callback",
        "https://control-plane.example@evil.test/api/callback",
        "not-a-url",
    ],
)
def test_control_plane_url_rejects_unconfigured_or_lookalike_hosts(monkeypatch, url):
    monkeypatch.setenv("ALLOWED_CONTROL_PLANE_HOSTS", "control-plane.example")

    assert validate_control_plane_url(url) is False
