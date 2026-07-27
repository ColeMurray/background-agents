"""Golden-vector and behavior tests for the sig1 service credential.

The fixture at packages/shared/test-fixtures/service-auth-vectors.json is the
cross-language contract with packages/shared/src/service-auth.ts — both suites
must assert byte-identical canonical strings and signatures.
"""

import base64
import json
from pathlib import Path
from urllib.parse import urlsplit

import pytest

from sandbox_runtime.auth.service_auth import (
    ACTOR_HEADER,
    SERVICE_HEADER,
    SERVICE_SIGNATURE_HEADER,
    _canonical_pathname,
    _sign_canonical_request,
    build_canonical_request_string,
    build_service_auth_headers,
    canonicalize_query,
    sha256_hex,
    verify_service_signature,
)

FIXTURE_PATH = (
    Path(__file__).resolve().parents[2] / "shared" / "test-fixtures" / "service-auth-vectors.json"
)
_FIXTURE = json.loads(FIXTURE_PATH.read_text())
VECTORS = _FIXTURE["vectors"]
MALFORMED_HEADERS = _FIXTURE["malformedHeaders"]


def _vector_body(vector: dict) -> bytes | str:
    if "bodyBase64" in vector:
        return base64.b64decode(vector["bodyBase64"])
    return vector.get("body", "")


@pytest.mark.parametrize("vector", VECTORS, ids=[v["name"] for v in VECTORS])
def test_golden_vector_canonical_string_and_signature(vector):
    url = vector["url"]
    expected = vector["expected"]

    assert _canonical_pathname(url) == expected["pathname"]
    assert canonicalize_query(urlsplit(url).query) == expected["canonicalQuery"]

    body_hash = sha256_hex(_vector_body(vector))
    assert body_hash == expected["bodySha256Hex"]

    canonical = build_canonical_request_string(
        service=vector["service"],
        timestamp_ms=vector["timestampMs"],
        nonce=vector["nonce"],
        method=vector["method"],
        pathname=expected["pathname"],
        canonical_query=expected["canonicalQuery"],
        body_sha256_hex=body_hash,
        actor=vector.get("actor", ""),
    )
    assert canonical == expected["canonicalString"]

    signature = _sign_canonical_request(
        service=vector["service"],
        secret=vector["secret"],
        timestamp_ms=vector["timestampMs"],
        nonce=vector["nonce"],
        method=vector["method"],
        url=url,
        body_sha256_hex=body_hash,
        actor=vector.get("actor", ""),
    )
    assert signature == expected["signatureHex"]


@pytest.mark.parametrize("vector", VECTORS, ids=[v["name"] for v in VECTORS])
def test_golden_vector_verifies_inside_window(vector, monkeypatch):
    monkeypatch.setattr(
        "sandbox_runtime.auth.service_auth.time.time", lambda: vector["timestampMs"] / 1000
    )
    result = verify_service_signature(
        signature_header=vector["expected"]["signatureHeader"],
        service=vector["service"],
        secret=vector["secret"],
        method=vector["method"],
        url=vector["url"],
        body_sha256_hex=vector["expected"]["bodySha256Hex"],
        actor=vector.get("actor", ""),
    )
    assert result.ok, result.reason
    assert result.timestamp_ms == vector["timestampMs"]
    assert result.nonce == vector["nonce"]


def test_build_headers_round_trip():
    headers = build_service_auth_headers(
        service="modal",
        secret="test-secret",
        method="POST",
        url="https://cp.example.com/internal/image-builds/b1/callback?x=2&a=1",
        body=b'{"status":"succeeded"}',
        trace_id="trace-1",
    )
    assert headers[SERVICE_HEADER] == "modal"
    assert headers["x-trace-id"] == "trace-1"
    assert ACTOR_HEADER not in headers

    result = verify_service_signature(
        signature_header=headers[SERVICE_SIGNATURE_HEADER],
        service="modal",
        secret="test-secret",
        method="POST",
        url="https://cp.example.com/internal/image-builds/b1/callback?x=2&a=1",
        body_sha256_hex=sha256_hex(b'{"status":"succeeded"}'),
        actor="",
    )
    assert result.ok


def test_build_headers_includes_actor_in_signature():
    url = "https://cp.example.com/sessions"
    headers = build_service_auth_headers(
        service="slack-bot",
        secret="test-secret",
        method="POST",
        url=url,
        body='{"prompt":"hi"}',
        actor="slack:U1",
    )
    assert headers[ACTOR_HEADER] == "slack:U1"

    tampered = verify_service_signature(
        signature_header=headers[SERVICE_SIGNATURE_HEADER],
        service="slack-bot",
        secret="test-secret",
        method="POST",
        url=url,
        body_sha256_hex=sha256_hex('{"prompt":"hi"}'),
        actor="slack:UEVIL",
    )
    assert not tampered.ok
    assert tampered.reason == "mismatch"


@pytest.mark.parametrize(
    "case", MALFORMED_HEADERS, ids=[case["name"] for case in MALFORMED_HEADERS]
)
def test_verify_rejects_malformed_headers_from_fixture(case):
    result = verify_service_signature(
        signature_header=case["signatureHeader"],
        service="web",
        secret="s",
        method="GET",
        url="https://cp.example.com/",
        body_sha256_hex=sha256_hex(b""),
        actor="",
    )
    assert not result.ok
    assert result.reason == case["reason"], case["name"]


def test_signer_refuses_unvetted_paths():
    for url in [
        "https://cp.example.com/a\\b",
        "https://cp.example.com/a|b",
        "https://cp.example.com/a/../b",
        "https://cp.example.com/a/./b",
        "https://cp.example.com/a b",
    ]:
        with pytest.raises(ValueError):
            build_service_auth_headers(service="web", secret="s", method="GET", url=url)


def test_verify_rejects_expired_timestamp(monkeypatch):
    headers = build_service_auth_headers(
        service="web",
        secret="s",
        method="GET",
        url="https://cp.example.com/sessions",
    )
    import time as time_module

    future_now = time_module.time() + 6 * 60
    monkeypatch.setattr("sandbox_runtime.auth.service_auth.time.time", lambda: future_now)
    result = verify_service_signature(
        signature_header=headers[SERVICE_SIGNATURE_HEADER],
        service="web",
        secret="s",
        method="GET",
        url="https://cp.example.com/sessions",
        body_sha256_hex=sha256_hex(b""),
        actor="",
    )
    assert not result.ok
    assert result.reason == "expired"


def test_verify_rejects_tampered_components():
    url = "https://cp.example.com/sessions?a=1"
    headers = build_service_auth_headers(
        service="web", secret="s", method="POST", url=url, body='{"x":1}'
    )
    good = {
        "signature_header": headers[SERVICE_SIGNATURE_HEADER],
        "service": "web",
        "secret": "s",
        "method": "POST",
        "url": url,
        "body_sha256_hex": sha256_hex('{"x":1}'),
        "actor": "",
    }
    assert verify_service_signature(**good).ok

    for overrides in [
        {"secret": "wrong"},
        {"service": "modal"},
        {"method": "GET"},
        {"url": "https://cp.example.com/sessions?a=2"},
        {"body_sha256_hex": sha256_hex('{"x":2}')},
        {"actor": "slack:U1"},
    ]:
        result = verify_service_signature(**{**good, **overrides})
        assert not result.ok, overrides
        assert result.reason == "mismatch", overrides
