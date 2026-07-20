"""Stateless Git SSH signer backed by the Open-Inspect control plane."""

from __future__ import annotations

import base64
import binascii
import hashlib
import json
import os
import re
import sys
import tempfile
from pathlib import Path
from typing import TYPE_CHECKING
from urllib.parse import quote

import httpx

if TYPE_CHECKING:
    from collections.abc import Mapping, Sequence

MAX_SIGNING_PAYLOAD_BYTES = 1024 * 1024
MAX_SIGNING_RESPONSE_BYTES = 16 * 1024
SIGNING_REQUEST_TIMEOUT_SECONDS = 30.0
STOCK_SSH_KEYGEN_PATH = "/usr/bin/ssh-keygen"


class GitSignerError(RuntimeError):
    """Bounded signer error that contains no request, response, or credential bytes."""


def run_signer(
    arguments: Sequence[str],
    environment: Mapping[str, str],
    client: httpx.Client,
) -> None:
    key_path, buffer_path = _parse_sign_arguments(arguments)
    signature_path = Path(f"{buffer_path}.sig")
    try:
        signature_path.unlink(missing_ok=True)
    except OSError:
        raise GitSignerError("Unable to prepare commit signature output") from None
    control_plane_url, auth_token, session_id = _resolve_endpoint(environment)
    public_key_blob = _read_public_key_blob(key_path)
    fingerprint = _fingerprint(public_key_blob)
    payload = _read_bounded_file(buffer_path, MAX_SIGNING_PAYLOAD_BYTES, "commit payload")
    if not payload:
        raise GitSignerError("Commit signing payload is empty")

    url = f"{control_plane_url}/sessions/{quote(session_id, safe='')}/commit-signing"
    try:
        with client.stream(
            "POST",
            url,
            headers={
                "Authorization": f"Bearer {auth_token}",
                "Content-Type": "application/octet-stream",
                "X-Open-Inspect-Signing-Fingerprint": fingerprint,
            },
            content=payload,
        ) as response:
            response_bytes = _read_bounded_response(response)
            if response.status_code != 200:
                raise GitSignerError("Control-plane signing request failed")
    except httpx.HTTPError:
        raise GitSignerError("Control-plane signing request failed") from None

    armor = _validate_armor(response_bytes)
    _atomic_write(signature_path, armor)


def _parse_sign_arguments(arguments: Sequence[str]) -> tuple[Path, Path]:
    if list(arguments[:5]) != ["-Y", "sign", "-n", "git", "-f"]:
        raise GitSignerError("Unsupported Git SSH signing invocation")
    if len(arguments) == 8 and arguments[6] == "-U":
        return Path(arguments[5]), Path(arguments[7])
    # Git 2.39 materializes the literal public key but omits the newer -U flag.
    if len(arguments) == 7:
        return Path(arguments[5]), Path(arguments[6])
    raise GitSignerError("Unsupported Git SSH signing invocation")


def _resolve_endpoint(environment: Mapping[str, str]) -> tuple[str, str, str]:
    control_plane_url = environment.get("CONTROL_PLANE_URL", "").strip().rstrip("/")
    auth_token = environment.get("SANDBOX_AUTH_TOKEN", "").strip()
    raw_session_config = environment.get("SESSION_CONFIG", "")
    try:
        session_config = json.loads(raw_session_config)
        session_id = session_config.get("sessionId") or session_config.get("session_id") or ""
    except (json.JSONDecodeError, AttributeError):
        raise GitSignerError("Commit signing session configuration is unavailable") from None
    if not (control_plane_url and auth_token and isinstance(session_id, str) and session_id):
        raise GitSignerError("Commit signing session configuration is unavailable")
    return control_plane_url, auth_token, session_id


def _read_public_key_blob(path: Path) -> bytes:
    raw_key = _read_bounded_file(path, 16 * 1024, "public key")
    try:
        key_text = raw_key.decode("ascii").strip()
    except UnicodeDecodeError:
        raise GitSignerError("Invalid Git signing public key") from None
    parts = key_text.split()
    if len(parts) < 2 or parts[0] != "ssh-ed25519":
        raise GitSignerError("Invalid Git signing public key")
    try:
        public_key_blob = base64.b64decode(parts[1], validate=True)
    except (binascii.Error, ValueError):
        raise GitSignerError("Invalid Git signing public key") from None
    if not public_key_blob:
        raise GitSignerError("Invalid Git signing public key")
    return public_key_blob


def _fingerprint(public_key_blob: bytes) -> str:
    digest = base64.b64encode(hashlib.sha256(public_key_blob).digest()).decode("ascii")
    return f"SHA256:{digest.rstrip('=')}"


def _read_bounded_file(path: Path, limit: int, description: str) -> bytes:
    try:
        with path.open("rb") as source:
            content = source.read(limit + 1)
    except OSError:
        raise GitSignerError(f"Unable to read {description}") from None
    if len(content) > limit:
        raise GitSignerError(f"{description.capitalize()} is too large")
    return content


def _read_bounded_response(response: httpx.Response) -> bytes:
    chunks: list[bytes] = []
    total_bytes = 0
    for chunk in response.iter_bytes():
        total_bytes += len(chunk)
        if total_bytes > MAX_SIGNING_RESPONSE_BYTES:
            raise GitSignerError("Control-plane signing response is too large")
        chunks.append(chunk)
    return b"".join(chunks)


def _validate_armor(response_bytes: bytes) -> bytes:
    try:
        armor = response_bytes.decode("ascii")
    except UnicodeDecodeError:
        raise GitSignerError("Invalid commit signing response") from None
    match = re.fullmatch(
        r"-----BEGIN SSH SIGNATURE-----\n"
        r"(?P<body>(?:[A-Za-z0-9+/]+={0,2}\n)+)"
        r"-----END SSH SIGNATURE-----\n",
        armor,
    )
    if not match:
        raise GitSignerError("Invalid commit signing response")
    try:
        decoded = base64.b64decode(match.group("body").replace("\n", ""), validate=True)
    except (binascii.Error, ValueError):
        raise GitSignerError("Invalid commit signing response") from None
    if not decoded.startswith(b"SSHSIG"):
        raise GitSignerError("Invalid commit signing response")
    return response_bytes


def _atomic_write(path: Path, content: bytes) -> None:
    temporary_path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="wb",
            dir=path.parent,
            prefix=f".{path.name}.",
            delete=False,
        ) as temporary_file:
            temporary_path = Path(temporary_file.name)
            temporary_file.write(content)
            temporary_file.flush()
            os.fsync(temporary_file.fileno())
        temporary_path.replace(path)
    except OSError:
        raise GitSignerError("Unable to write commit signature") from None
    finally:
        if temporary_path is not None:
            temporary_path.unlink(missing_ok=True)


def main() -> None:
    arguments = sys.argv[1:]
    if list(arguments[:2]) != ["-Y", "sign"]:
        os.execv(STOCK_SSH_KEYGEN_PATH, [STOCK_SSH_KEYGEN_PATH, *arguments])

    try:
        with httpx.Client(timeout=SIGNING_REQUEST_TIMEOUT_SECONDS) as client:
            run_signer(arguments, os.environ, client)
    except GitSignerError as error:
        sys.stderr.write(f"oi-git-sign: {error}\n")
        raise SystemExit(1) from None


if __name__ == "__main__":
    main()
