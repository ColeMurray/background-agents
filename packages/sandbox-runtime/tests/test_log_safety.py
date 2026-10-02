"""Redaction and bounds on diagnostic copies, not agent event payloads."""

import json

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
