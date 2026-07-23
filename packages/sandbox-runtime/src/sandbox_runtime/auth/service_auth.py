"""Per-service request authentication (the ``sig1`` signature format).

Python mirror of ``packages/shared/src/service-auth.ts``. The canonical
request string layout is a cross-language contract pinned by the golden
vectors in ``packages/shared/test-fixtures/service-auth-vectors.json``; any
change to the layout or the canonicalization rules requires a new format tag
(``sig2``), not an edit here.

Internals use seconds per repo convention; the wire string carries epoch
milliseconds to match the TypeScript side.
"""

import hashlib
import hmac
import re
import secrets
import time
from typing import Literal, NamedTuple
from urllib.parse import parse_qsl, quote, urlsplit

from .internal import TOKEN_VALIDITY_SECONDS

SERVICE_HEADER = "X-OpenInspect-Service"
SERVICE_SIGNATURE_HEADER = "X-OpenInspect-Service-Signature"
ACTOR_HEADER = "X-OpenInspect-Actor"
SIG1_PREFIX = "sig1"

# Characters encodeURIComponent leaves unescaped, beyond Python quote()'s
# always-safe alphanumerics and "_.-~".
_ENCODE_URI_COMPONENT_SAFE = "!'()*"

# WHATWG URL parsers (the TypeScript signer and the Workers runtime) keep
# these path characters literal while percent-encoding non-ASCII bytes.
_PATH_SAFE = "/:@!$&'()*+,;=-._~%[]"

# Path characters (and dot segments) where quote() and WHATWG serialization
# are known to diverge (e.g. "\\" becomes "/" in WHATWG special URLs). The
# signer refuses them loudly instead of producing a signature the TypeScript
# verifier can never match.
_PATH_UNVETTED_CHARS = set('\\|^`<>"{} ')

_HEX_NONCE_MAX_LEN = 64

# Strict ASCII decimal, mirrored by service-auth.ts. str.isdigit()'s wider
# grammar (non-ASCII Unicode digits) must not classify differently across
# languages.
_TIMESTAMP_PATTERN = re.compile(r"[0-9]{1,16}")

ServiceSignatureFailure = Literal["format", "expired", "mismatch"]


class ServiceSignatureResult(NamedTuple):
    """Outcome of ``verify_service_signature``.

    On success, carries the parsed wire components so callers never re-split
    the header (this module is the sole owner of the sig1 grammar).
    """

    ok: bool
    reason: ServiceSignatureFailure | None
    timestamp_ms: int | None = None
    nonce: str | None = None


def sha256_hex(data: bytes | str) -> str:
    """SHA-256 of the raw request body as lowercase hex ("" for no body)."""
    raw = data.encode("utf-8") if isinstance(data, str) else data
    return hashlib.sha256(raw).hexdigest()


def canonicalize_query(query: str) -> str:
    """Canonical form of a URL query string.

    Decoded ``key=value`` entries sorted bytewise (UTF-8) by ``key\\0value``,
    re-encoded with encodeURIComponent semantics, joined with ``&``.
    """
    entries = parse_qsl(query.lstrip("?"), keep_blank_values=True)
    entries.sort(key=lambda kv: f"{kv[0]}\0{kv[1]}".encode())
    return "&".join(
        f"{quote(key, safe=_ENCODE_URI_COMPONENT_SAFE)}"
        f"={quote(value, safe=_ENCODE_URI_COMPONENT_SAFE)}"
        for key, value in entries
    )


def _canonical_pathname(url: str) -> str:
    """The URL path as a WHATWG parser would serialize it.

    Already-encoded paths pass through unchanged (``%`` is safe); raw
    non-ASCII input is percent-encoded to match ``new URL(url).pathname``.
    """
    return quote(urlsplit(url).path, safe=_PATH_SAFE)


def _validate_signable_path(url: str) -> None:
    """Refuse to sign paths whose WHATWG serialization we do not mirror.

    ``_canonical_pathname`` approximates WHATWG for the vetted character set;
    outside it (backslash, ``|``, ``^``, dot segments, controls) the two
    serializations diverge and the signature would fail verification as an
    opaque 401 far from the cause. Failing loudly at the signer keeps the
    contract honest without emulating the full WHATWG algorithm.
    """
    path = urlsplit(url).path
    for ch in path:
        if ch in _PATH_UNVETTED_CHARS or ord(ch) < 0x20 or ch == "\x7f":
            raise ValueError(
                f"cannot sign path containing {ch!r}: its WHATWG serialization "
                "is not mirrored here; percent-encode it before signing"
            )
    if any(segment in (".", "..") for segment in path.split("/")):
        raise ValueError(
            "cannot sign path containing dot segments: WHATWG parsers resolve "
            "them; resolve the path before signing"
        )


def build_canonical_request_string(
    *,
    service: str,
    timestamp_ms: int,
    nonce: str,
    method: str,
    pathname: str,
    canonical_query: str,
    body_sha256_hex: str,
    actor: str,
) -> str:
    """The exact byte layout signed by ``sig1`` (actor is "" when absent)."""
    return (
        f"{SIG1_PREFIX}\n{service}\n{timestamp_ms}\n{nonce}\n"
        f"{method.upper()}\n{pathname}\n{canonical_query}\n"
        f"{body_sha256_hex}\n{actor}"
    )


def _sign_canonical_request(
    *,
    service: str,
    secret: str,
    timestamp_ms: int,
    nonce: str,
    method: str,
    url: str,
    body_sha256_hex: str,
    actor: str,
) -> str:
    canonical = build_canonical_request_string(
        service=service,
        timestamp_ms=timestamp_ms,
        nonce=nonce,
        method=method,
        pathname=_canonical_pathname(url),
        canonical_query=canonicalize_query(urlsplit(url).query),
        body_sha256_hex=body_sha256_hex,
        actor=actor,
    )
    return hmac.new(
        secret.encode("utf-8"),
        canonical.encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()


def build_service_auth_headers(
    *,
    service: str,
    secret: str,
    method: str,
    url: str,
    body: bytes | str | None = None,
    actor: str | None = None,
    trace_id: str | None = None,
) -> dict[str, str]:
    """Build the sig1 request headers for an outbound service call.

    Callers add their own ``Content-Type``/``Accept`` headers and must send
    exactly the body bytes that were signed.
    """
    _validate_signable_path(url)
    timestamp_ms = int(time.time() * 1000)
    nonce = secrets.token_hex(8)
    actor_value = actor or ""
    body_sha256_hex = sha256_hex(body if body is not None else b"")
    signature = _sign_canonical_request(
        service=service,
        secret=secret,
        timestamp_ms=timestamp_ms,
        nonce=nonce,
        method=method,
        url=url,
        body_sha256_hex=body_sha256_hex,
        actor=actor_value,
    )

    headers = {
        SERVICE_HEADER: service,
        SERVICE_SIGNATURE_HEADER: f"{SIG1_PREFIX}.{timestamp_ms}.{nonce}.{signature}",
    }
    if actor_value:
        headers[ACTOR_HEADER] = actor_value
    if trace_id:
        headers["x-trace-id"] = trace_id
    return headers


def _is_lower_hex(value: str, *, max_len: int) -> bool:
    return 0 < len(value) <= max_len and all(c in "0123456789abcdef" for c in value)


def verify_service_signature(
    *,
    signature_header: str,
    service: str,
    secret: str,
    method: str,
    url: str,
    body_sha256_hex: str,
    actor: str,
) -> ServiceSignatureResult:
    """Verify a sig1 signature header against the named service's secret."""
    parts = signature_header.split(".")
    if len(parts) != 4 or parts[0] != SIG1_PREFIX:
        return ServiceSignatureResult(ok=False, reason="format")
    _, timestamp_part, nonce, signature = parts
    if not _TIMESTAMP_PATTERN.fullmatch(timestamp_part):
        return ServiceSignatureResult(ok=False, reason="format")
    timestamp_ms = int(timestamp_part)
    if timestamp_ms <= 0:
        return ServiceSignatureResult(ok=False, reason="format")
    if not _is_lower_hex(nonce, max_len=_HEX_NONCE_MAX_LEN):
        return ServiceSignatureResult(ok=False, reason="format")
    if len(signature) != 64 or not _is_lower_hex(signature, max_len=64):
        return ServiceSignatureResult(ok=False, reason="format")
    if abs(time.time() - timestamp_ms / 1000) > TOKEN_VALIDITY_SECONDS:
        return ServiceSignatureResult(ok=False, reason="expired")
    expected = _sign_canonical_request(
        service=service,
        secret=secret,
        timestamp_ms=timestamp_ms,
        nonce=nonce,
        method=method,
        url=url,
        body_sha256_hex=body_sha256_hex,
        actor=actor,
    )
    if not hmac.compare_digest(signature, expected):
        return ServiceSignatureResult(ok=False, reason="mismatch")
    return ServiceSignatureResult(ok=True, reason=None, timestamp_ms=timestamp_ms, nonce=nonce)
