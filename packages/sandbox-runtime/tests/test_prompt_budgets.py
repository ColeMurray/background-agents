"""Resolution of the per-prompt time budgets from the sandbox environment."""

from unittest.mock import MagicMock

from sandbox_runtime.constants import (
    DEFAULT_SANDBOX_TIMEOUT_SECONDS,
    MAX_SNAPSHOT_RESERVE_SECONDS,
    SANDBOX_TIMEOUT_ENV_VAR,
    SNAPSHOT_RESERVE_FRACTION,
)
from sandbox_runtime.prompt_budgets import (
    SSE_INACTIVITY_TIMEOUT,
    SSE_INACTIVITY_TIMEOUT_ENV_VAR,
    SSE_INACTIVITY_TIMEOUT_MAX,
    SSE_INACTIVITY_TIMEOUT_MIN,
    resolve_prompt_limits,
)


def _invalid_details(log: MagicMock) -> list[str]:
    return [
        call.kwargs["detail"]
        for call in log.warn.call_args_list
        if call.args == ("bridge.timeout_invalid",)
    ]


class TestInactivityTimeout:
    def test_unset_uses_the_default(self, monkeypatch):
        monkeypatch.delenv(SSE_INACTIVITY_TIMEOUT_ENV_VAR, raising=False)

        limits = resolve_prompt_limits(MagicMock())

        assert limits.inactivity_timeout_seconds == SSE_INACTIVITY_TIMEOUT

    def test_a_value_in_range_is_taken_as_given(self, monkeypatch):
        monkeypatch.setenv(SSE_INACTIVITY_TIMEOUT_ENV_VAR, "120")

        limits = resolve_prompt_limits(MagicMock())

        assert limits.inactivity_timeout_seconds == 120.0

    def test_a_value_outside_the_range_is_clamped(self, monkeypatch):
        monkeypatch.setenv(SSE_INACTIVITY_TIMEOUT_ENV_VAR, "1")
        assert resolve_prompt_limits(MagicMock()).inactivity_timeout_seconds == (
            SSE_INACTIVITY_TIMEOUT_MIN
        )

        monkeypatch.setenv(SSE_INACTIVITY_TIMEOUT_ENV_VAR, "999999")
        assert resolve_prompt_limits(MagicMock()).inactivity_timeout_seconds == (
            SSE_INACTIVITY_TIMEOUT_MAX
        )

    def test_unparseable_text_falls_back_to_the_default(self, monkeypatch):
        monkeypatch.setenv(SSE_INACTIVITY_TIMEOUT_ENV_VAR, "soon")
        log = MagicMock()

        limits = resolve_prompt_limits(log)

        assert limits.inactivity_timeout_seconds == SSE_INACTIVITY_TIMEOUT
        assert _invalid_details(log) == ["invalid value 'soon', using default"]

    def test_a_not_a_number_value_falls_back_to_the_default(self, monkeypatch):
        """``float("nan")`` parses, and every clamp comparison against it is false."""
        monkeypatch.setenv(SSE_INACTIVITY_TIMEOUT_ENV_VAR, "nan")
        log = MagicMock()

        limits = resolve_prompt_limits(log)

        assert limits.inactivity_timeout_seconds == SSE_INACTIVITY_TIMEOUT
        assert _invalid_details(log) == ["invalid value 'nan', using default"]

    def test_an_infinite_value_falls_back_to_the_default(self, monkeypatch):
        monkeypatch.setenv(SSE_INACTIVITY_TIMEOUT_ENV_VAR, "inf")
        log = MagicMock()

        limits = resolve_prompt_limits(log)

        assert limits.inactivity_timeout_seconds == SSE_INACTIVITY_TIMEOUT
        assert _invalid_details(log) == ["invalid value 'inf', using default"]


class TestSandboxBudget:
    def test_the_snapshot_reserve_comes_off_the_sandbox_lifetime(self, monkeypatch):
        monkeypatch.delenv(SANDBOX_TIMEOUT_ENV_VAR, raising=False)

        limits = resolve_prompt_limits(MagicMock())

        reserve = min(
            MAX_SNAPSHOT_RESERVE_SECONDS,
            DEFAULT_SANDBOX_TIMEOUT_SECONDS * SNAPSHOT_RESERVE_FRACTION,
        )
        assert limits.prompt_cleanup_timeout_seconds == reserve
        assert limits.prompt_max_duration_seconds == DEFAULT_SANDBOX_TIMEOUT_SECONDS - reserve

    def test_a_non_finite_sandbox_lifetime_falls_back_to_the_default(self, monkeypatch):
        monkeypatch.setenv(SANDBOX_TIMEOUT_ENV_VAR, "nan")
        log = MagicMock()

        limits = resolve_prompt_limits(log)

        reserve = min(
            MAX_SNAPSHOT_RESERVE_SECONDS,
            DEFAULT_SANDBOX_TIMEOUT_SECONDS * SNAPSHOT_RESERVE_FRACTION,
        )
        assert limits.prompt_max_duration_seconds == DEFAULT_SANDBOX_TIMEOUT_SECONDS - reserve
        assert _invalid_details(log) == ["invalid value 'nan', using default"]
