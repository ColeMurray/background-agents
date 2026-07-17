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
import re
import subprocess
import tempfile
from pathlib import Path
from typing import Any, cast

import modal


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


def _run(*args: str, cwd: Path | None = None) -> str:
    result = subprocess.run(
        args,
        cwd=cwd,
        check=True,
        capture_output=True,
        text=True,
    )
    return result.stdout.strip() or result.stderr.strip()


def _git_version() -> tuple[int, int, int]:
    output = _run("git", "--version")
    match = re.fullmatch(r"git version (\d+)\.(\d+)\.(\d+)(?:\..*)?", output)
    if not match:
        raise RuntimeError(f"Unable to parse Git version: {output}")
    return tuple(int(part) for part in match.groups())  # type: ignore[return-value]


def _write(path: Path, content: str) -> None:
    path.write_text(content, encoding="utf-8")


def _commit(repo: Path, message: str, filename: str) -> str:
    _write(repo / filename, f"{message}\n")
    _run("git", "add", filename, cwd=repo)
    _run("git", "commit", "-m", message, cwd=repo)
    return _run("git", "rev-parse", "HEAD", cwd=repo)


def _verify(repo: Path, commit: str, allowed_signers: Path) -> None:
    _run(
        "git",
        "-c",
        f"gpg.ssh.allowedSignersFile={allowed_signers}",
        "verify-commit",
        commit,
        cwd=repo,
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
        private_key_text = private_key.read_text(encoding="utf-8")
        allowed_signers = runtime_directory / "allowed_signers"
        _write(allowed_signers, f"signing@example.com {public_key}\n")

        repo = root / "repository"
        repo.mkdir()
        _run("git", "init", "-b", "main", cwd=repo)
        manifest = root / "repo-manifest.json"
        _write(
            manifest,
            dump_repo_manifest(
                [RepoEntry(owner="open-inspect", name="qualification", branch="main", path=repo)]
            ),
        )
        runtime = GitSigningRuntime(
            control_plane_url="https://unused.example.com",
            session_id="qualification",
            auth_token="unused",
            repo_manifest_path=manifest,
            key_path=private_key,
        )
        asyncio.run(
            runtime.apply_configuration(
                {
                    "enabled": True,
                    "keyFormat": "ssh-ed25519",
                    "githubLogin": "open-inspect-signing",
                    "committerName": "Open-Inspect",
                    "committerEmail": "signing@example.com",
                    "publicKey": public_key,
                    "fingerprint": "SHA256:qualification",
                    "privateKey": private_key_text,
                },
                GitUser(
                    name="Alice Example",
                    email="12345+alice@users.noreply.github.com",
                ),
            )
        )

        commits: dict[str, str] = {}
        commits["normal"] = _commit(repo, "normal", "normal.txt")

        _write(repo / "normal.txt", "amended\n")
        _run("git", "add", "normal.txt", cwd=repo)
        _run("git", "commit", "--amend", "--no-edit", cwd=repo)
        commits["amend"] = _run("git", "rev-parse", "HEAD", cwd=repo)

        _run("git", "switch", "-c", "feature", cwd=repo)
        commits["feature"] = _commit(repo, "feature", "feature.txt")
        _run("git", "switch", "main", cwd=repo)
        _commit(repo, "main update", "main.txt")
        _run("git", "merge", "--no-ff", "feature", "-m", "merge feature", cwd=repo)
        commits["merge"] = _run("git", "rev-parse", "HEAD", cwd=repo)

        _run("git", "switch", "-c", "cherry-source", cwd=repo)
        cherry_source = _commit(repo, "cherry source", "cherry.txt")
        _run("git", "switch", "main", cwd=repo)
        _run("git", "cherry-pick", cherry_source, cwd=repo)
        commits["cherry_pick"] = _run("git", "rev-parse", "HEAD", cwd=repo)

        _run("git", "switch", "-c", "rebase-source", cwd=repo)
        _commit(repo, "rebase source", "rebase.txt")
        _run("git", "switch", "main", cwd=repo)
        _commit(repo, "rebase base", "base.txt")
        _run("git", "switch", "rebase-source", cwd=repo)
        _run("git", "rebase", "main", cwd=repo)
        commits["rebase"] = _run("git", "rev-parse", "HEAD", cwd=repo)

        for commit in commits.values():
            _verify(repo, commit, allowed_signers)
            _assert_identity(repo, commit)

        return {
            "git_version": ".".join(str(part) for part in git_version),
            "ssh_version": ssh_version,
            "runtime_user": _run("id", "-un"),
            "private_path_mode": oct(private_key.stat().st_mode & 0o777),
            "operations": sorted(commits),
        }


@app.local_entrypoint()  # type: ignore[untyped-decorator]
def main() -> None:
    print(json.dumps(qualify_commit_signing.remote(), indent=2, sort_keys=True))
