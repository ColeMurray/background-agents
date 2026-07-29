"""Regenerate the sig1 golden-vector fixture.

The fixture at ``packages/shared/test-fixtures/service-auth-vectors.json`` is
the cross-language contract between ``service_auth.py`` (which generates it,
via this script) and ``service-auth.ts`` (which asserts it byte-for-byte).
Run from ``packages/sandbox-runtime``:

    PYTHONPATH=src python tests/generate_service_auth_vectors.py

The script is deterministic: same inputs, same fixture. Add new vectors or
malformed-header cases to the input lists below and rerun.
"""

from __future__ import annotations

import base64
import json
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

from sandbox_runtime.auth.service_auth import (
    SIG1_PREFIX,
    _canonical_pathname,
    _sign_canonical_request,
    build_canonical_request_string,
    canonicalize_query,
    sha256_hex,
)

FIXTURE_PATH = (
    Path(__file__).resolve().parents[2] / "shared" / "test-fixtures" / "service-auth-vectors.json"
)

DESCRIPTION = (
    "Golden vectors for the sig1 service-auth canonical string and signature. "
    "Cross-language contract between packages/shared/src/service-auth.ts and "
    "packages/sandbox-runtime/src/sandbox_runtime/auth/service_auth.py. "
    "Changing canonicalization requires a sig2, not an edit to these vectors. "
    "Regenerate with packages/sandbox-runtime/tests/generate_service_auth_vectors.py."
)

# (name, service, secret, timestamp_ms, nonce, method, url, body, body_base64, actor)
VECTOR_INPUTS: list[dict[str, Any]] = [
    {
        "name": "web GET, no query, no body, no actor",
        "service": "web",
        "secret": "web-secret-0001",
        "timestampMs": 1753142400000,
        "nonce": "0123456789abcdef",
        "method": "GET",
        "url": "https://control-plane.example.com/sessions",
    },
    {
        "name": "slack-bot POST, JSON body, slack actor",
        "service": "slack-bot",
        "secret": "slack-secret-0002",
        "timestampMs": 1753142400001,
        "nonce": "00ff00ff00ff00ff",
        "method": "POST",
        "url": "https://control-plane.example.com/sessions",
        "body": '{"prompt":"fix the bug","repoOwner":"acme","repoName":"app"}',
        "actor": "slack:U0123456",
    },
    {
        "name": "github-bot POST, JSON body, github actor",
        "service": "github-bot",
        "secret": "github-secret-0003",
        "timestampMs": 1753142400002,
        "nonce": "aaaaaaaaaaaaaaaa",
        "method": "POST",
        "url": "https://control-plane.example.com/sessions/sess-1/prompt",
        "body": '{"prompt":"review this PR"}',
        "actor": "github:583231",
    },
    {
        "name": "linear-bot PUT with query params",
        "service": "linear-bot",
        "secret": "linear-secret-0004",
        "timestampMs": 1753142400003,
        "nonce": "1234abcd5678ef90",
        "method": "PUT",
        "url": "https://control-plane.example.com/integration-config?workspace=w1&team=t2",
        "body": '{"enabled":true}',
        "actor": "linear:usr_42",
    },
    {
        "name": "modal POST, JSON body, no actor",
        "service": "modal",
        "secret": "modal-secret-0005",
        "timestampMs": 1753142400004,
        "nonce": "deadbeefdeadbeef",
        "method": "POST",
        "url": "https://control-plane.example.com/internal/image-builds/build-9/callback",
        "body": '{"status":"succeeded","imageTag":"repo:abc123"}',
    },
    {
        "name": "query order canonicalizes (b before a on the wire)",
        "service": "web",
        "secret": "web-secret-0001",
        "timestampMs": 1753142400005,
        "nonce": "0000000000000001",
        "method": "GET",
        "url": "https://control-plane.example.com/sessions?limit=10&createdBy=user-1&cursor=abc",
    },
    {
        "name": "query order canonicalizes (same params, reordered)",
        "service": "web",
        "secret": "web-secret-0001",
        "timestampMs": 1753142400005,
        "nonce": "0000000000000001",
        "method": "GET",
        "url": "https://control-plane.example.com/sessions?cursor=abc&createdBy=user-1&limit=10",
    },
    {
        "name": "duplicate keys sort by value; encoded space and plus",
        "service": "web",
        "secret": "web-secret-0001",
        "timestampMs": 1753142400006,
        "nonce": "0000000000000002",
        "method": "GET",
        "url": "https://control-plane.example.com/search?tag=zeta&tag=alpha&q=hello%20world&note=a+b",
    },
    {
        "name": "empty-string value and bare key",
        "service": "web",
        "secret": "web-secret-0001",
        "timestampMs": 1753142400007,
        "nonce": "0000000000000003",
        "method": "GET",
        "url": "https://control-plane.example.com/sessions?empty=&bare",
    },
    {
        "name": "binary body",
        "service": "modal",
        "secret": "modal-secret-0005",
        "timestampMs": 1753142400008,
        "nonce": "0000000000000004",
        "method": "POST",
        "url": "https://control-plane.example.com/internal/blob",
        "bodyBase64": "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh///gBiaW5hcnk=",
    },
    {
        "name": "unicode path (raw) percent-encodes identically",
        "service": "web",
        "secret": "web-secret-0001",
        "timestampMs": 1753142400009,
        "nonce": "0000000000000005",
        "method": "GET",
        "url": "https://control-plane.example.com/repos/ünïcode/sessions",
    },
    {
        "name": "unicode path (pre-encoded) passes through",
        "service": "web",
        "secret": "web-secret-0001",
        "timestampMs": 1753142400009,
        "nonce": "0000000000000005",
        "method": "GET",
        "url": "https://control-plane.example.com/repos/%C3%BCn%C3%AFcode/sessions",
    },
    {
        "name": "lowercase method normalizes to uppercase",
        "service": "slack-bot",
        "secret": "slack-secret-0002",
        "timestampMs": 1753142400010,
        "nonce": "0000000000000006",
        "method": "post",
        "url": "https://control-plane.example.com/sessions/sess-2/prompt",
        "body": '{"prompt":"hi"}',
        "actor": "slack:U0999999",
    },
    {
        "name": "unicode query values sort bytewise",
        "service": "web",
        "secret": "web-secret-0001",
        "timestampMs": 1753142400011,
        "nonce": "0000000000000007",
        "method": "GET",
        "url": "https://control-plane.example.com/sessions?name=%C3%A9clair&name=zebra&x=%E2%9C%93",
    },
]

# Headers both verifiers must classify as {ok: false, reason: "format"},
# pinning the strict sig1 grammar (ASCII-decimal timestamp, lowercase-hex
# nonce and signature, exactly four parts). All cases are time-independent:
# format is checked before expiry.
_TS = "1753142400000"
_NONCE = "0123456789abcdef"
_SIG = "ab" * 32
MALFORMED_HEADERS: list[dict[str, str]] = [
    {"name": "empty string", "signatureHeader": ""},
    {"name": "prefix only", "signatureHeader": SIG1_PREFIX},
    {"name": "wrong format tag", "signatureHeader": f"sig2.{_TS}.{_NONCE}.{_SIG}"},
    {"name": "three parts", "signatureHeader": f"sig1.{_TS}.{_NONCE}"},
    {"name": "five parts", "signatureHeader": f"sig1.{_TS}.{_NONCE}.{_SIG}.extra"},
    {"name": "exponent timestamp", "signatureHeader": f"sig1.1e3.{_NONCE}.{_SIG}"},
    {"name": "hex timestamp", "signatureHeader": f"sig1.0x10.{_NONCE}.{_SIG}"},
    {"name": "padded timestamp", "signatureHeader": f"sig1. {_TS} .{_NONCE}.{_SIG}"},
    {"name": "non-ASCII digit timestamp", "signatureHeader": f"sig1.١٢٣.{_NONCE}.{_SIG}"},
    {"name": "negative timestamp", "signatureHeader": f"sig1.-1.{_NONCE}.{_SIG}"},
    {"name": "zero timestamp", "signatureHeader": f"sig1.0.{_NONCE}.{_SIG}"},
    {"name": "17-digit timestamp", "signatureHeader": f"sig1.{'9' * 17}.{_NONCE}.{_SIG}"},
    {"name": "uppercase nonce", "signatureHeader": f"sig1.{_TS}.{_NONCE.upper()}.{_SIG}"},
    {"name": "uppercase signature", "signatureHeader": f"sig1.{_TS}.{_NONCE}.{_SIG.upper()}"},
    {"name": "truncated signature", "signatureHeader": f"sig1.{_TS}.{_NONCE}.{_SIG[:32]}"},
]


def _expected(v: dict[str, Any]) -> dict[str, Any]:
    if "bodyBase64" in v:
        body: bytes | str = base64.b64decode(v["bodyBase64"])
    else:
        body = v.get("body", "")
    body_sha = sha256_hex(body)
    pathname = _canonical_pathname(v["url"])
    canonical_query = canonicalize_query(urlsplit(v["url"]).query)
    canonical = build_canonical_request_string(
        service=v["service"],
        timestamp_ms=v["timestampMs"],
        nonce=v["nonce"],
        method=v["method"],
        pathname=pathname,
        canonical_query=canonical_query,
        body_sha256_hex=body_sha,
        actor=v.get("actor", ""),
    )
    signature = _sign_canonical_request(
        service=v["service"],
        secret=v["secret"],
        timestamp_ms=v["timestampMs"],
        nonce=v["nonce"],
        method=v["method"],
        url=v["url"],
        body_sha256_hex=body_sha,
        actor=v.get("actor", ""),
    )
    return {
        "pathname": pathname,
        "canonicalQuery": canonical_query,
        "bodySha256Hex": body_sha,
        "canonicalString": canonical,
        "signatureHex": signature,
        "signatureHeader": f"{SIG1_PREFIX}.{v['timestampMs']}.{v['nonce']}.{signature}",
    }


def main() -> None:
    fixture = {
        "description": DESCRIPTION,
        "vectors": [{**v, "expected": _expected(v)} for v in VECTOR_INPUTS],
        "malformedHeaders": [{**case, "reason": "format"} for case in MALFORMED_HEADERS],
    }
    FIXTURE_PATH.write_text(json.dumps(fixture, indent=2, ensure_ascii=False) + "\n")
    print(f"wrote {len(VECTOR_INPUTS)} vectors, {len(MALFORMED_HEADERS)} malformed headers")
    print(FIXTURE_PATH)


if __name__ == "__main__":
    main()
