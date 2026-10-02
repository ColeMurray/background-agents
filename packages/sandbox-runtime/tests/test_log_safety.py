"""Redaction and bounds on diagnostic copies, not agent event payloads."""

import json

import pytest

from sandbox_runtime.log_safety import (
    MAX_LOG_TEXT_CHARS,
    REDACTED,
    TRUNCATED,
    register_log_secret,
    sanitize_log_value,
    unregister_log_secret,
)


def test_nested_credentials_are_redacted_without_mutating_input():
    original = {
        "args": {"headers": {"Authorization": "opaque", "X-Api-Key": "unknown"}},
        "nested": [{"password": "unknown-password", "access_token": "unknown-token"}],
        "tokens": {"input": 12, "output": 7},
    }
    safe = sanitize_log_value(original)
    assert safe["args"]["headers"] == {"Authorization": REDACTED, "X-Api-Key": REDACTED}
    assert safe["nested"] == [{"password": REDACTED, "access_token": REDACTED}]
    assert safe["tokens"] == original["tokens"]
    assert original["args"]["headers"]["Authorization"] == "opaque"


def test_known_environment_and_in_memory_credentials_are_redacted(monkeypatch):
    monkeypatch.setenv("SANDBOX_AUTH_TOKEN", "runtime-secret-value")
    register_log_secret("brokered-opaque-value")
    result = sanitize_log_value("runtime-secret-value brokered-opaque-value")
    assert result == f"{REDACTED} {REDACTED}"


def test_registered_credentials_are_released_after_last_owner():
    value = "unique-brokered-lifetime-value"
    register_log_secret(value)
    register_log_secret(value)
    unregister_log_secret(value)
    assert sanitize_log_value(value) == REDACTED
    unregister_log_secret(value)
    assert sanitize_log_value(value) == value


def test_redacts_before_truncating_and_handles_multiline_unicode(monkeypatch):
    secret = "boundary-secret-long"
    monkeypatch.setenv("CUSTOM_SECRET", secret)
    monkeypatch.setenv("PRIVATE_KEY", "line-one-credential\nline-two-credential")
    source = "x" * (MAX_LOG_TEXT_CHARS - 4) + secret + "\n😀 line-two-credential"
    result = sanitize_log_value(source)
    assert "boun" not in result
    assert result.endswith(TRUNCATED)
    assert len(result) <= MAX_LOG_TEXT_CHARS
    assert sanitize_log_value("😀\nline-one-credential") == f"😀\n{REDACTED}"


def test_earlier_redaction_cannot_pull_a_later_partial_secret_into_preview():
    first, second = "A" * 100, "B" * 100
    register_log_secret(first)
    register_log_secret(second)
    try:
        result = sanitize_log_value(first + "x" * 2000 + second)
        assert "A" not in result
        assert "B" not in result
        assert result.startswith(REDACTED)
        assert result.endswith(TRUNCATED)
        assert len(result) <= MAX_LOG_TEXT_CHARS
        # Also complete a match that begins before, but ends beyond, the cutoff.
        crossing = sanitize_log_value(first + "x" * 1940 + second)
        assert "A" not in crossing and "B" not in crossing
        assert crossing.endswith(REDACTED)
    finally:
        unregister_log_secret(first)
        unregister_log_secret(second)


@pytest.mark.parametrize(
    "key", ["api_key", "access_token", "Authorization", "password", "X-Api-Key", "auth"]
)
def test_quoted_json_credential_fields_in_string_output_are_redacted(key):
    output = json.dumps({"nested": {key: 'opaque "quoted" credential'}, "note": "keep-me"})
    result = sanitize_log_value(output)
    assert "opaque" not in result and "credential" not in result
    assert REDACTED in result
    assert "keep-me" in result


def test_incomplete_quoted_json_value_is_redacted_to_preview_end():
    output = '{"api_key":"' + "opaque-value " * MAX_LOG_TEXT_CHARS
    result = sanitize_log_value(output)
    assert "opaque-value" not in result
    assert REDACTED in result
    assert result.endswith(TRUNCATED)


def test_quoted_credential_cut_off_mid_escape_is_redacted_to_preview_end():
    prefix = '{"api_key":"'
    source = prefix + "opaque-value " + "x" * (MAX_LOG_TEXT_CHARS - len(prefix) - 14) + "\\escaped"
    assert source[MAX_LOG_TEXT_CHARS - 1] == "\\"
    result = sanitize_log_value(source)
    assert "opaque-value" not in result
    assert "x" not in result
    assert REDACTED in result
    assert result.endswith(TRUNCATED)


def test_nested_credential_object_in_string_output_is_conservatively_redacted():
    result = sanitize_log_value('{"auth": {"custom": "opaque-object-value"}, "note": "later"}')
    assert "opaque-object-value" not in result
    assert REDACTED in result


def test_recognizable_free_text_credentials_are_redacted():
    text = (
        "Bearer totally-opaque https://user:pass@example.test/x "
        "ANTHROPIC_API_KEY='another-value' ghp_aToken123 "
        "-----BEGIN PRIVATE KEY-----\nopaque\n-----END PRIVATE KEY-----"
    )
    safe = sanitize_log_value(text)
    for secret in ("totally-opaque", "user:pass", "another-value", "ghp_aToken123", "opaque\n"):
        assert secret not in safe
    assert "example.test/x" in safe


def test_incomplete_or_long_pem_key_is_redacted_through_preview_end():
    key = "-----BEGIN RSA PRIVATE KEY-----\n" + "unknown-key-material" * 500
    safe = sanitize_log_value(key)
    assert "unknown-key-material" not in safe
    assert safe.startswith(REDACTED)
    assert safe.endswith(TRUNCATED)


def test_cyclic_and_wide_payloads_are_bounded():
    cyclic = {"self": None}
    cyclic["self"] = cyclic
    assert TRUNCATED in json.dumps(sanitize_log_value(cyclic))
    wide = {f"field-{index}": ["😀" * 10_000] * 100 for index in range(100)}
    serialized = json.dumps(sanitize_log_value(wide))
    assert TRUNCATED in serialized
    # json.dumps escapes non-ASCII; the total budget still bounds the record.
    assert len(serialized) < 110_000


def test_unknown_objects_do_not_call_repr_or_str():
    class SecretObject:
        def __str__(self):
            raise AssertionError("must not stringify arbitrary objects")

        def __repr__(self):
            raise AssertionError("must not repr arbitrary objects")

    assert sanitize_log_value(SecretObject()) == "<SecretObject>"


def test_nonfinite_floats_become_strict_json_safe_markers():
    safe = sanitize_log_value([float("nan"), float("inf"), -float("inf"), 1.5])
    assert safe == ["<non-finite float>"] * 3 + [1.5]
    assert json.loads(json.dumps(safe, allow_nan=False)) == safe
