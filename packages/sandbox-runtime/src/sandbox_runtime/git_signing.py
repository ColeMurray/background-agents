"""Purpose-specific commit-signing broker client and Git runtime configuration."""

import asyncio
import contextlib
import os
import re
import tempfile
from pathlib import Path
from typing import Annotated, Any, Literal
from urllib.parse import quote

import httpx
from pydantic import BaseModel, ConfigDict, Field, TypeAdapter, ValidationError, field_validator

from .constants import REPO_MANIFEST_FILE_PATH
from .repo_config import RepoConfigError, read_repo_manifest
from .types import GitUser

DEFAULT_SIGNING_KEY_PATH = Path("/run/oi/commit-signing/id_ed25519")
GIT_CONFIG_TIMEOUT_SECONDS = 10.0
SIGNING_CONFIG_KEYS = (
    "author.name",
    "author.email",
    "committer.name",
    "committer.email",
    "gpg.format",
    "user.signingkey",
    "commit.gpgsign",
)
UNSIGNED_GIT_USER = GitUser(name="OpenInspect", email="open-inspect@noreply.github.com")


class GitSigningError(RuntimeError):
    """Bounded runtime error that never includes secret configuration values."""


class DisabledCommitSigningConfiguration(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    enabled: Literal[False]


class EnabledCommitSigningConfiguration(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    enabled: Literal[True]
    keyFormat: Literal["ssh-ed25519"]
    githubLogin: str = Field(min_length=1, max_length=39)
    committerName: str = Field(min_length=1, max_length=256)
    committerEmail: str = Field(min_length=3, max_length=320)
    publicKey: str = Field(min_length=1)
    fingerprint: str = Field(min_length=1)
    privateKey: str = Field(min_length=1, max_length=16_384)

    @classmethod
    def _non_blank(cls, value: str, field_name: str) -> str:
        if not value.strip():
            raise ValueError(f"{field_name} must not be blank")
        return value

    @field_validator("githubLogin")
    @classmethod
    def validate_github_login(cls, value: str) -> str:
        if not re.fullmatch(r"[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?", value):
            raise ValueError("invalid GitHub login")
        if "--" in value:
            raise ValueError("invalid GitHub login")
        return value

    @field_validator("committerName")
    @classmethod
    def validate_committer_name(cls, value: str) -> str:
        return cls._non_blank(value, "committerName")

    @field_validator("committerEmail")
    @classmethod
    def validate_committer_email(cls, value: str) -> str:
        if not re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", value):
            raise ValueError("invalid committer email")
        return value

    @field_validator("publicKey")
    @classmethod
    def validate_public_key(cls, value: str) -> str:
        if not re.fullmatch(r"ssh-ed25519 [A-Za-z0-9+/]+={0,2}", value):
            raise ValueError("invalid Ed25519 public key")
        return value

    @field_validator("fingerprint")
    @classmethod
    def validate_fingerprint(cls, value: str) -> str:
        if not re.fullmatch(r"SHA256:[A-Za-z0-9+/]+", value):
            raise ValueError("invalid SHA256 fingerprint")
        return value

    @field_validator("privateKey")
    @classmethod
    def validate_private_key(cls, value: str) -> str:
        normalized = value.replace("\r\n", "\n").strip()
        if not (
            normalized.startswith("-----BEGIN OPENSSH PRIVATE KEY-----\n")
            and normalized.endswith("\n-----END OPENSSH PRIVATE KEY-----")
        ):
            raise ValueError("invalid OpenSSH private key")
        return value


CommitSigningConfiguration = Annotated[
    DisabledCommitSigningConfiguration | EnabledCommitSigningConfiguration,
    Field(discriminator="enabled"),
]
CONFIGURATION_ADAPTER: TypeAdapter[CommitSigningConfiguration] = TypeAdapter(
    CommitSigningConfiguration
)


def parse_commit_signing_configuration(payload: object) -> CommitSigningConfiguration:
    try:
        return CONFIGURATION_ADAPTER.validate_python(payload)
    except ValidationError:
        raise GitSigningError("Invalid commit signing configuration") from None


class GitSigningRuntime:
    def __init__(
        self,
        *,
        control_plane_url: str,
        session_id: str,
        auth_token: str,
        repo_manifest_path: str | Path = REPO_MANIFEST_FILE_PATH,
        key_path: str | Path = DEFAULT_SIGNING_KEY_PATH,
        log: Any | None = None,
    ) -> None:
        self.control_plane_url = control_plane_url.rstrip("/")
        self.session_id = session_id
        self.auth_token = auth_token
        self.repo_manifest_path = Path(repo_manifest_path)
        self.key_path = Path(key_path)
        self.log = log

    async def initialize(self, author: GitUser | None) -> None:
        self.cleanup_before_boot()
        await self.refresh(author)

    async def refresh(self, author: GitUser | None) -> None:
        configuration = await self._fetch_configuration()
        await self._apply_configuration(configuration, author)

    async def _fetch_configuration(self) -> CommitSigningConfiguration:
        url = f"{self.control_plane_url}/sessions/{quote(self.session_id, safe='')}/commit-signing"
        try:
            async with httpx.AsyncClient(timeout=30.0) as client:
                response = await client.get(
                    url,
                    headers={"Authorization": f"Bearer {self.auth_token}"},
                )
                response.raise_for_status()
                payload = response.json()
        except (httpx.HTTPError, ValueError):
            self._log_fetch(outcome="error")
            raise GitSigningError("Commit signing configuration unavailable") from None

        try:
            configuration = parse_commit_signing_configuration(payload)
        except GitSigningError:
            self._log_fetch(outcome="error")
            raise
        self._log_fetch(outcome="success")
        return configuration

    async def apply_configuration(self, configuration: object, author: GitUser | None) -> None:
        """Validate an external configuration before applying it.

        Production broker responses are validated in ``_fetch_configuration``. This
        boundary remains public for provider qualification without an HTTP broker.
        """
        await self._apply_configuration(parse_commit_signing_configuration(configuration), author)

    async def _apply_configuration(
        self,
        configuration: CommitSigningConfiguration,
        author: GitUser | None,
    ) -> None:
        try:
            repositories = read_repo_manifest(self.repo_manifest_path)
        except RepoConfigError:
            raise GitSigningError("Invalid repository manifest") from None
        if isinstance(configuration, DisabledCommitSigningConfiguration):
            effective_author = author or UNSIGNED_GIT_USER
            self._remove_key_file()
            for repository in repositories:
                await self._remove_signing_git_config(repository.path)
                await self._set_git_config(repository.path, "user.name", effective_author.name)
                await self._set_git_config(repository.path, "user.email", effective_author.email)
            self._log_applied(enabled=False, mode="unsigned")
            return

        effective_author = author or GitUser(
            name=configuration.committerName,
            email=configuration.committerEmail,
        )
        self._write_private_key(configuration.privateKey)
        values = (
            ("author.name", effective_author.name),
            ("author.email", effective_author.email),
            ("committer.name", configuration.committerName),
            ("committer.email", configuration.committerEmail),
            ("user.name", effective_author.name),
            ("user.email", effective_author.email),
            ("gpg.format", "ssh"),
            ("user.signingkey", str(self.key_path)),
            ("commit.gpgsign", "true"),
        )
        for repository in repositories:
            for key, value in values:
                await self._set_git_config(repository.path, key, value)
        self._log_applied(
            enabled=True,
            mode="attributed-user" if author is not None else "agent-only",
            fingerprint=configuration.fingerprint,
        )

    def _remove_key_file(self) -> None:
        with contextlib.suppress(FileNotFoundError):
            self.key_path.unlink()

    def _write_private_key(self, private_key: str) -> None:
        self.key_path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.key_path.parent.chmod(0o700)
        temporary_path: Path | None = None
        try:
            with tempfile.NamedTemporaryFile(
                mode="w",
                encoding="utf-8",
                dir=self.key_path.parent,
                prefix=".commit-signing-",
                delete=False,
            ) as temporary_file:
                temporary_path = Path(temporary_file.name)
                temporary_path.chmod(0o600)
                temporary_file.write(private_key)
                if not private_key.endswith("\n"):
                    temporary_file.write("\n")
                temporary_file.flush()
                os.fsync(temporary_file.fileno())
            temporary_path.replace(self.key_path)
            self.key_path.chmod(0o600)
        except OSError:
            raise GitSigningError("Unable to install commit signing key") from None
        finally:
            if temporary_path is not None:
                with contextlib.suppress(FileNotFoundError):
                    temporary_path.unlink()

    async def _remove_signing_git_config(self, repository: Path) -> None:
        for key in SIGNING_CONFIG_KEYS:
            await self._run_git_config(repository, "--unset-all", key, allow_missing=True)

    async def _set_git_config(self, repository: Path, key: str, value: str) -> None:
        await self._run_git_config(repository, key, value)

    async def _run_git_config(
        self,
        repository: Path,
        *args: str,
        allow_missing: bool = False,
    ) -> None:
        if not (repository / ".git").exists():
            raise GitSigningError("Session repository is unavailable for Git configuration")

        command = ["git", "config", "--local", *args]
        process = await asyncio.create_subprocess_exec(
            *command,
            cwd=repository,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.PIPE,
        )
        try:
            _stdout, _stderr = await asyncio.wait_for(
                process.communicate(), timeout=GIT_CONFIG_TIMEOUT_SECONDS
            )
        except TimeoutError:
            process.kill()
            with contextlib.suppress(ProcessLookupError):
                await process.wait()
            raise GitSigningError("Git signing configuration timed out") from None

        if process.returncode == 0 or (allow_missing and process.returncode in {1, 5}):
            return
        raise GitSigningError("Git signing configuration failed")

    def cleanup_before_boot(self) -> None:
        """Remove known snapshot-restored key material before any broker fetch."""
        self._remove_key_file()
        with contextlib.suppress(OSError):
            self.key_path.parent.chmod(0o700)

    def _log_applied(self, *, enabled: bool, mode: str, fingerprint: str | None = None) -> None:
        if self.log is None:
            return
        self.log.info(
            "git.signing_apply",
            enabled=enabled,
            mode=mode,
            **({"fingerprint": fingerprint} if fingerprint else {}),
        )

    def _log_fetch(self, *, outcome: str) -> None:
        if self.log is not None:
            self.log.info("git.signing_fetch", outcome=outcome)
