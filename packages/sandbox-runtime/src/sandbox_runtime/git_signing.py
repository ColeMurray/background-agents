"""Purpose-specific commit-signing broker client and Git runtime configuration."""

import asyncio
import contextlib
import re
from pathlib import Path
from typing import Annotated, Literal
from urllib.parse import quote

import httpx
from pydantic import BaseModel, ConfigDict, Field, TypeAdapter, ValidationError, field_validator

from .constants import REPO_MANIFEST_FILE_PATH
from .repo_config import RepoConfigError, read_repo_manifest
from .types import GitUser

DEFAULT_GIT_SIGNER_PATH = Path("/usr/local/bin/oi-git-sign")
GIT_CONFIG_TIMEOUT_SECONDS = 10.0
SIGNING_CONFIG_FETCH_TIMEOUT_SECONDS = 30.0
SIGNING_CONFIG_KEYS = (
    "author.name",
    "author.email",
    "committer.name",
    "committer.email",
    "gpg.format",
    "gpg.ssh.program",
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
    committerName: str = Field(min_length=1, max_length=256)
    committerEmail: str = Field(min_length=3, max_length=320)
    publicKey: str = Field(min_length=1)

    @classmethod
    def _non_blank(cls, value: str, field_name: str) -> str:
        if not value.strip():
            raise ValueError(f"{field_name} must not be blank")
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
        signer_path: str | Path = DEFAULT_GIT_SIGNER_PATH,
    ) -> None:
        self.control_plane_url = control_plane_url.rstrip("/")
        self.session_id = session_id
        self.auth_token = auth_token
        self.repo_manifest_path = Path(repo_manifest_path)
        self.signer_path = Path(signer_path)
        self._installed_signing_revision: tuple[str, ...] | None = None
        self._installed_repository_paths: tuple[Path, ...] = ()

    async def initialize(self, author: GitUser | None) -> None:
        self._installed_signing_revision = None
        self._installed_repository_paths = ()
        await self.refresh(author)

    async def refresh(self, author: GitUser | None) -> None:
        configuration = await self._fetch_configuration()
        await self._apply_configuration(configuration, author)

    async def _fetch_configuration(self) -> CommitSigningConfiguration:
        url = f"{self.control_plane_url}/sessions/{quote(self.session_id, safe='')}/commit-signing"
        try:
            async with httpx.AsyncClient(timeout=SIGNING_CONFIG_FETCH_TIMEOUT_SECONDS) as client:
                response = await client.get(
                    url,
                    headers={"Authorization": f"Bearer {self.auth_token}"},
                )
                response.raise_for_status()
                payload = response.json()
        except (httpx.HTTPError, ValueError):
            raise GitSigningError("Commit signing configuration unavailable") from None

        return parse_commit_signing_configuration(payload)

    async def apply_configuration(self, configuration: object, author: GitUser | None) -> None:
        """Validate and apply a configuration without fetching it."""
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
        repository_paths = tuple(repository.path for repository in repositories)
        signing_revision = self._signing_revision(configuration)
        signing_state_changed = (
            signing_revision != self._installed_signing_revision
            or repository_paths != self._installed_repository_paths
        )

        if isinstance(configuration, DisabledCommitSigningConfiguration):
            effective_author = author or UNSIGNED_GIT_USER
            if signing_state_changed:
                for repository in repositories:
                    await self._remove_signing_git_config(repository.path)
            for repository in repositories:
                await self._set_git_config(repository.path, "user.name", effective_author.name)
                await self._set_git_config(repository.path, "user.email", effective_author.email)
            self._record_installed_state(signing_revision, repository_paths)
            return

        effective_author = author or GitUser(
            name=configuration.committerName,
            email=configuration.committerEmail,
        )
        signing_values = (
            ("committer.name", configuration.committerName),
            ("committer.email", configuration.committerEmail),
            ("gpg.format", "ssh"),
            ("gpg.ssh.program", str(self.signer_path)),
            ("user.signingkey", f"key::{configuration.publicKey}"),
            ("commit.gpgsign", "true"),
        )
        author_values = (
            ("author.name", effective_author.name),
            ("author.email", effective_author.email),
            ("user.name", effective_author.name),
            ("user.email", effective_author.email),
        )
        for repository in repositories:
            if signing_state_changed:
                for key, value in signing_values:
                    await self._set_git_config(repository.path, key, value)
            for key, value in author_values:
                await self._set_git_config(repository.path, key, value)
        self._record_installed_state(signing_revision, repository_paths)

    @staticmethod
    def _signing_revision(configuration: CommitSigningConfiguration) -> tuple[str, ...]:
        if isinstance(configuration, DisabledCommitSigningConfiguration):
            return ("disabled",)
        return (
            "enabled",
            configuration.committerName,
            configuration.committerEmail,
            configuration.publicKey,
        )

    def _record_installed_state(
        self,
        signing_revision: tuple[str, ...],
        repository_paths: tuple[Path, ...],
    ) -> None:
        self._installed_signing_revision = signing_revision
        self._installed_repository_paths = repository_paths

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
