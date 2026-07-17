"""Qualify Git SSH commit signing in the Modal sandbox base image.

Run from ``packages/modal-infra`` with:

    uv run modal run scripts/qualify_commit_signing.py

The script creates only temporary in-container repositories and key material. It is not imported by
``deploy.py`` and does not add a production Modal function.
"""

from __future__ import annotations

import asyncio
import importlib.util
import json
import os
import re
import subprocess
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import TYPE_CHECKING, Any, cast

import modal

if TYPE_CHECKING:
    from collections.abc import Mapping


def _load_base_image() -> modal.Image:
    if not modal.is_local():
        return modal.Image.debian_slim()

    module_path = Path(__file__).resolve().parents[1] / "src" / "images" / "base.py"
    spec = importlib.util.spec_from_file_location("commit_signing_qualification_base", module_path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Unable to load sandbox base image from {module_path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return cast("modal.Image", module.base_image)


app = modal.App("open-inspect-commit-signing-qualification")
base_image = _load_base_image()

MINIMUM_GIT_VERSION = (2, 34, 0)
QUALIFICATION_TIMEOUT_SECONDS = 900


def _run(
    *args: str,
    cwd: Path | None = None,
    env: Mapping[str, str] | None = None,
) -> str:
    result = subprocess.run(
        args,
        cwd=cwd,
        env=env,
        check=False,
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        detail = result.stderr.strip() or result.stdout.strip() or "no command output"
        raise RuntimeError(f"Qualification command failed ({args[0]}): {detail}")
    return result.stdout.strip() or result.stderr.strip()


def _git_version() -> tuple[int, int, int]:
    output = _run("git", "--version")
    match = re.fullmatch(r"git version (\d+)\.(\d+)\.(\d+)(?:\..*)?", output)
    if not match:
        raise RuntimeError(f"Unable to parse Git version: {output}")
    return tuple(int(part) for part in match.groups())  # type: ignore[return-value]


def _write(path: Path, content: str) -> None:
    path.write_text(content, encoding="utf-8")


def _verify(
    repo: Path,
    commit: str,
    allowed_signers: Path,
    env: Mapping[str, str],
) -> None:
    _run(
        "git",
        "-c",
        f"gpg.ssh.allowedSignersFile={allowed_signers}",
        "verify-commit",
        commit,
        cwd=repo,
        env=env,
    )


def _assert_identity(repo: Path, commit: str) -> None:
    identity = _run("git", "show", "-s", "--format=%an|%ae|%cn|%ce", commit, cwd=repo)
    expected = "Alice Example|12345+alice@users.noreply.github.com|Open-Inspect|signing@example.com"
    if identity != expected:
        raise RuntimeError(f"Unexpected author/committer identity: {identity}")


@app.function(  # type: ignore[untyped-decorator]
    image=base_image,
    timeout=QUALIFICATION_TIMEOUT_SECONDS,
)
def qualify_commit_signing() -> dict[str, Any]:
    from sandbox_runtime.git_signing import GitSigningRuntime
    from sandbox_runtime.repo_config import RepoEntry, dump_repo_manifest
    from sandbox_runtime.types import GitUser

    git_version = _git_version()
    if git_version < MINIMUM_GIT_VERSION:
        raise RuntimeError(f"Git {git_version} is older than {MINIMUM_GIT_VERSION}")

    ssh_version = _run("ssh", "-V")
    with tempfile.TemporaryDirectory(prefix="oi-signing-qualification-") as temporary_directory:
        root = Path(temporary_directory)
        runtime_directory = root / "runtime"
        runtime_directory.mkdir(mode=0o700)
        private_key = runtime_directory / "commit-signing-key"
        _run(
            "ssh-keygen",
            "-q",
            "-t",
            "ed25519",
            "-N",
            "",
            "-C",
            "signing@example.com",
            "-f",
            str(private_key),
        )
        private_key.chmod(0o600)
        if private_key.stat().st_mode & 0o777 != 0o600:
            raise RuntimeError("Signing key does not have mode 0600")

        public_key_with_comment = Path(f"{private_key}.pub").read_text(encoding="utf-8").strip()
        public_key = " ".join(public_key_with_comment.split()[:2])
        fingerprint = _run(
            "ssh-keygen",
            "-lf",
            str(Path(f"{private_key}.pub")),
            "-E",
            "sha256",
        ).split()[1]
        allowed_signers = runtime_directory / "allowed_signers"
        _write(allowed_signers, f"signing@example.com {public_key}\n")

        sign_requests: list[bytes] = []

        class SigningHandler(BaseHTTPRequestHandler):
            def do_POST(self) -> None:
                if (
                    self.path != "/sessions/qualification/commit-signing"
                    or self.headers.get("Authorization") != "Bearer qualification-token"
                    or self.headers.get("X-Open-Inspect-Signing-Fingerprint") != fingerprint
                ):
                    self.send_error(401)
                    return
                content_length = int(self.headers.get("Content-Length", "0"))
                payload = self.rfile.read(content_length)
                sign_requests.append(payload)
                payload_path = runtime_directory / f"payload-{len(sign_requests)}"
                payload_path.write_bytes(payload)
                _run(
                    "ssh-keygen",
                    "-Y",
                    "sign",
                    "-n",
                    "git",
                    "-f",
                    str(private_key),
                    str(payload_path),
                )
                armor = Path(f"{payload_path}.sig").read_bytes()
                self.send_response(200)
                self.send_header("Content-Type", "text/plain; charset=utf-8")
                self.send_header("Content-Length", str(len(armor)))
                self.end_headers()
                self.wfile.write(armor)

            def log_message(self, _format: str, *_args: object) -> None:
                return

        signer_path = Path("/usr/local/bin/oi-git-sign")
        if not signer_path.is_file() or not os.access(signer_path, os.X_OK):
            raise RuntimeError(f"Stateless signer wrapper is unavailable: {signer_path}")
        server = ThreadingHTTPServer(("127.0.0.1", 0), SigningHandler)
        server_thread = threading.Thread(target=server.serve_forever, daemon=True)
        server_thread.start()
        signing_environment = {
            **os.environ,
            "CONTROL_PLANE_URL": f"http://127.0.0.1:{server.server_port}",
            "SANDBOX_AUTH_TOKEN": "qualification-token",
            "SESSION_CONFIG": json.dumps({"sessionId": "qualification"}),
        }

        try:
            repo = root / "repository"
            repo.mkdir()
            _run("git", "init", "-b", "main", cwd=repo)
            manifest = root / "repo-manifest.json"
            _write(
                manifest,
                dump_repo_manifest(
                    [
                        RepoEntry(
                            owner="open-inspect",
                            name="qualification",
                            branch="main",
                            path=repo,
                        )
                    ]
                ),
            )
            runtime = GitSigningRuntime(
                control_plane_url=signing_environment["CONTROL_PLANE_URL"],
                session_id="qualification",
                auth_token="qualification-token",
                repo_manifest_path=manifest,
                signer_path=signer_path,
            )
            asyncio.run(
                runtime.apply_configuration(
                    {
                        "enabled": True,
                        "committerName": "Open-Inspect",
                        "committerEmail": "signing@example.com",
                        "publicKey": public_key,
                        "fingerprint": fingerprint,
                    },
                    GitUser(
                        name="Alice Example",
                        email="12345+alice@users.noreply.github.com",
                    ),
                )
            )

            _write(repo / "normal.txt", "normal\n")
            _run("git", "add", "normal.txt", cwd=repo, env=signing_environment)
            _run("git", "commit", "-m", "normal", cwd=repo, env=signing_environment)
            commits = {"normal": _run("git", "rev-parse", "HEAD", cwd=repo)}

            _write(repo / "normal.txt", "amended\n")
            _run("git", "add", "normal.txt", cwd=repo, env=signing_environment)
            _run(
                "git",
                "commit",
                "--amend",
                "--no-edit",
                cwd=repo,
                env=signing_environment,
            )
            commits["amend"] = _run("git", "rev-parse", "HEAD", cwd=repo)

            for commit in commits.values():
                _verify(repo, commit, allowed_signers, signing_environment)
                _assert_identity(repo, commit)

            if len(sign_requests) != len(commits):
                raise RuntimeError("Unexpected remote signer request count")
            result = {
                "git_version": ".".join(str(part) for part in git_version),
                "ssh_version": ssh_version,
                "runtime_user": _run("id", "-un"),
                "signer_path": str(signer_path),
                "sign_requests": len(sign_requests),
                "operations": sorted(commits),
            }
        finally:
            server.shutdown()
            server.server_close()
            server_thread.join()

        return result


@app.local_entrypoint()  # type: ignore[untyped-decorator]
def main() -> None:
    print(json.dumps(qualify_commit_signing.remote(), indent=2, sort_keys=True))
