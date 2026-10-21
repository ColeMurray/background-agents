"""Bounded one-shot delivery of the execution bridge credential."""

from __future__ import annotations

from typing import BinaryIO

MAX_EXECUTION_AUTH_TOKEN_BYTES = 4096


def read_execution_auth_token(stream: BinaryIO) -> str:
    """Read one newline-terminated token from an inherited root-only descriptor."""
    value = stream.readline(MAX_EXECUTION_AUTH_TOKEN_BYTES + 2)
    if len(value) > MAX_EXECUTION_AUTH_TOKEN_BYTES + 1 or (
        len(value) == MAX_EXECUTION_AUTH_TOKEN_BYTES + 1 and not value.endswith(b"\n")
    ):
        raise ValueError("Execution auth token is too large")
    if not value.endswith(b"\n"):
        raise ValueError("Execution auth token must end with a newline")
    token = value[:-1].decode("utf-8")
    if not token or "\x00" in token or "\r" in token:
        raise ValueError("Execution auth token is invalid")
    return token
