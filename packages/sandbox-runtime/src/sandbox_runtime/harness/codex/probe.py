"""Credential-free installed-image handshake and containment probe."""

from __future__ import annotations

import asyncio
import os
import sys
import tempfile
from pathlib import Path

from .client import CodexClient
from .env import CODEX_BINARY, clean_codex_env, launch_arguments


class ProbeClient(CodexClient):
    # This isolated, credential-free probe has no prompts or secret environment.
    # Preserve bounded diagnostics only here, never in the session transport.
    diagnostics = b""

    async def _drain_stderr(self) -> None:
        assert self._process is not None and self._process.stderr is not None
        while chunk := await self._process.stderr.read(8192):
            self.diagnostics = (self.diagnostics + chunk)[-16384:]


async def probe() -> None:
    with tempfile.TemporaryDirectory(prefix="oi-codex-smoke-") as directory:
        state = Path(directory)
        client = ProbeClient(
            command=(
                sys.executable,
                str(Path(__file__).with_name("process.py")),
                CODEX_BINARY,
                *launch_arguments(state),
                "app-server",
                "--listen",
                "stdio://",
            ),
            cwd=state,
            env=clean_codex_env({"PATH": os.environ["PATH"], "HOME": directory}, state),
            containment_owner=True,
        )
        try:
            await client.open()
            await client.request(
                "initialize",
                {"clientInfo": {"name": "oi_image_probe", "version": "1"}},
                timeout_seconds=10,
            )
            await client.notify("initialized", {})
        finally:
            if not await client.close(timeout_seconds=5):
                raise RuntimeError(
                    "Codex image probe did not confirm process containment: "
                    f"owner_exit={client._process.returncode if client._process else None}; "
                    f"{client.diagnostics.decode(errors='replace')}"
                )
        assert not (state / "auth.json").exists()


if __name__ == "__main__":
    asyncio.run(probe())
