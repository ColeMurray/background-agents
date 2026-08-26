from __future__ import annotations

import asyncio
import os
import re
from dataclasses import dataclass
from enum import StrEnum
from pathlib import Path
from typing import TYPE_CHECKING, Any

from .diff_baseline import resolve_session_diff_baselines
from .process_output import communicate_owned_subprocess, terminate_owned_subprocess
from .runtime_config import BootMode

if TYPE_CHECKING:
    from .repo_config import RepoEntry

GH_WRAPPER_REAL_PATH = "/usr/bin/gh"
GH_WRAPPER_INSTALL_PATH = Path("/usr/local/bin/gh")
GH_WRAPPER_BODY = Path(__file__).with_name("gh-wrapper.sh").read_text()
DEFAULT_GIT_CLONE_TIMEOUT_SECONDS = 300.0
DEFAULT_GIT_FETCH_TIMEOUT_SECONDS = 120.0


class RepositorySyncTimeout(TimeoutError):
    pass


class RepositorySyncStatus(StrEnum):
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    TIMED_OUT = "timed_out"


@dataclass(frozen=True)
class RepositorySyncOutcome:
    repository: RepoEntry
    status: RepositorySyncStatus


@dataclass(frozen=True)
class RepositorySyncResult:
    repositories: tuple[RepoEntry, ...]
    outcomes: tuple[RepositorySyncOutcome, ...]

    @property
    def failures(self) -> tuple[RepoEntry, ...]:
        return tuple(
            outcome.repository
            for outcome in self.outcomes
            if outcome.status is not RepositorySyncStatus.SUCCEEDED
        )

    @property
    def non_timeout_failures(self) -> tuple[RepoEntry, ...]:
        return tuple(
            outcome.repository
            for outcome in self.outcomes
            if outcome.status is RepositorySyncStatus.FAILED
        )

    @property
    def timed_out(self) -> tuple[RepoEntry, ...]:
        return tuple(
            outcome.repository
            for outcome in self.outcomes
            if outcome.status is RepositorySyncStatus.TIMED_OUT
        )


class RepositorySynchronizer:
    CLONE_DEPTH_COMMITS = 100

    def __init__(
        self,
        vcs_host: str,
        log: Any,
        *,
        clone_timeout_seconds: float = DEFAULT_GIT_CLONE_TIMEOUT_SECONDS,
        fetch_timeout_seconds: float = DEFAULT_GIT_FETCH_TIMEOUT_SECONDS,
    ) -> None:
        self.vcs_host = vcs_host
        self.log = log
        self.clone_timeout_seconds = clone_timeout_seconds
        self.fetch_timeout_seconds = fetch_timeout_seconds

    def _build_repo_url(self, repo: RepoEntry) -> str:
        return f"https://{self.vcs_host}/{repo.owner}/{repo.name}.git"

    def _redact_git_stderr(self, stderr: bytes) -> str:
        return re.sub(r"(https?://)([^/\s@]+)@", r"\1***@", stderr.decode(errors="replace"))

    async def _terminate_owned_subprocess(self, process: asyncio.subprocess.Process) -> None:
        await terminate_owned_subprocess(process, kill_process_group=os.killpg)

    async def _communicate_owned_subprocess(
        self, process: asyncio.subprocess.Process
    ) -> tuple[bytes, bytes]:
        return await communicate_owned_subprocess(process, kill_process_group=os.killpg)

    async def _clone_repo(self, repo: RepoEntry) -> bool:
        self.log.info("git.clone_start", repo_owner=repo.owner, repo_name=repo.name)
        try:
            result = await asyncio.create_subprocess_exec(
                "git",
                "clone",
                "--depth",
                str(self.CLONE_DEPTH_COMMITS),
                "--branch",
                repo.branch,
                self._build_repo_url(repo),
                str(repo.path),
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                start_new_session=True,
            )
            _stdout, stderr = await asyncio.wait_for(
                self._communicate_owned_subprocess(result),
                timeout=self.clone_timeout_seconds,
            )
        except TimeoutError as error:
            self.log.error(
                "git.clone_timeout",
                repo_owner=repo.owner,
                repo_name=repo.name,
                timeout_seconds=self.clone_timeout_seconds,
            )
            raise RepositorySyncTimeout from error
        except Exception as error:
            self.log.error("git.clone_error", exc=error, repo_owner=repo.owner, repo_name=repo.name)
            return False
        if result.returncode != 0:
            self.log.error(
                "git.clone_error",
                repo_owner=repo.owner,
                repo_name=repo.name,
                stderr=self._redact_git_stderr(stderr),
                exit_code=result.returncode,
            )
            return False
        self.log.info("git.clone_complete", repo_path=str(repo.path))
        return True

    async def ensure_credentials_configured(self) -> None:
        shim_path = Path("/usr/local/bin/oi-git-credentials")
        shim_body = (
            '#!/bin/sh\nexec python3 -m sandbox_runtime.credentials.git_credential_helper "$@"\n'
        )
        shim_available = False
        try:
            if shim_path.exists() and shim_path.read_text() == shim_body:
                shim_available = True
            else:
                shim_path.write_text(shim_body)
                shim_path.chmod(0o755)
                shim_available = True
        except OSError as error:
            self.log.warn("credential_helper.shim_write_failed", error=str(error))
        configs = [("credential.useHttpPath", "true")]
        if shim_available:
            configs.insert(0, ("credential.helper", str(shim_path)))
        for key, value in configs:
            process = await asyncio.create_subprocess_exec(
                "git",
                "config",
                "--global",
                "--replace-all",
                key,
                value,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                start_new_session=True,
            )
            _stdout, stderr = await self._communicate_owned_subprocess(process)
            if process.returncode != 0:
                self.log.warn(
                    "credential_helper.config_failed",
                    config_key=key,
                    exit_code=process.returncode,
                    stderr=stderr.decode(errors="replace"),
                )
        self._install_gh_wrapper()

    def _install_gh_wrapper(self) -> None:
        real_path = Path(GH_WRAPPER_REAL_PATH)
        if not os.access(real_path, os.X_OK):
            return
        try:
            if (
                GH_WRAPPER_INSTALL_PATH.exists()
                and GH_WRAPPER_INSTALL_PATH.read_text() == GH_WRAPPER_BODY
                and os.access(GH_WRAPPER_INSTALL_PATH, os.X_OK)
            ):
                return
            GH_WRAPPER_INSTALL_PATH.write_text(GH_WRAPPER_BODY)
            GH_WRAPPER_INSTALL_PATH.chmod(0o755)
        except OSError as error:
            raise RuntimeError(
                f"Cannot install authenticated gh wrapper at {GH_WRAPPER_INSTALL_PATH}: {error}"
            ) from error

    async def _ensure_plain_origin(self, repo: RepoEntry) -> bool:
        process = await asyncio.create_subprocess_exec(
            "git",
            "remote",
            "set-url",
            "origin",
            self._build_repo_url(repo),
            cwd=repo.path,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            start_new_session=True,
        )
        _stdout, stderr = await self._communicate_owned_subprocess(process)
        if process.returncode != 0:
            self.log.error(
                "git.set_url_failed",
                exit_code=process.returncode,
                stderr=self._redact_git_stderr(stderr),
            )
            return False
        return True

    async def _fetch_branch(self, repo: RepoEntry, branch: str) -> bool:
        process = await asyncio.create_subprocess_exec(
            "git",
            "fetch",
            "origin",
            f"{branch}:refs/remotes/origin/{branch}",
            cwd=repo.path,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            start_new_session=True,
        )
        try:
            _stdout, stderr = await asyncio.wait_for(
                self._communicate_owned_subprocess(process),
                timeout=self.fetch_timeout_seconds,
            )
        except TimeoutError as error:
            self.log.error(
                "git.fetch_timeout",
                repo_owner=repo.owner,
                repo_name=repo.name,
                timeout_seconds=self.fetch_timeout_seconds,
            )
            raise RepositorySyncTimeout from error
        if process.returncode != 0:
            self.log.error(
                "git.fetch_error",
                stderr=self._redact_git_stderr(stderr),
                exit_code=process.returncode,
            )
            return False
        return True

    async def _checkout_branch(self, repo: RepoEntry, branch: str) -> bool:
        process = await asyncio.create_subprocess_exec(
            "git",
            "checkout",
            "-B",
            branch,
            f"origin/{branch}",
            cwd=repo.path,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            start_new_session=True,
        )
        _stdout, stderr = await self._communicate_owned_subprocess(process)
        if process.returncode != 0:
            self.log.warn(
                "git.checkout_error",
                stderr=self._redact_git_stderr(stderr),
                exit_code=process.returncode,
                target_branch=branch,
            )
            return False
        return True

    async def _update_existing_repo(self, repo: RepoEntry, boot_mode: BootMode) -> bool:
        if not repo.path.exists():
            self.log.info(
                "git.update_skip",
                reason="no_repo_path",
                repo_owner=repo.owner,
                repo_name=repo.name,
            )
            return False
        preserve_checkout = boot_mode is BootMode.SNAPSHOT_RESTORE
        try:
            if not await self._ensure_plain_origin(repo):
                return False
            if not await self._fetch_branch(repo, repo.branch):
                return False
            if preserve_checkout:
                return True
            return await self._checkout_branch(repo, repo.branch)
        except RepositorySyncTimeout:
            raise
        except Exception as error:
            if preserve_checkout:
                self.log.warn(
                    "git.restore_refresh_error",
                    exc=error,
                    repo_owner=repo.owner,
                    repo_name=repo.name,
                )
                return False
            self.log.error(
                "git.update_error", exc=error, repo_owner=repo.owner, repo_name=repo.name
            )
            return False

    async def _get_head_sha(self, repo: RepoEntry) -> str:
        if not repo.path.exists():
            return ""
        try:
            process = await asyncio.create_subprocess_exec(
                "git",
                "rev-parse",
                "HEAD",
                cwd=repo.path,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                start_new_session=True,
            )
            stdout, _ = await self._communicate_owned_subprocess(process)
            if process.returncode == 0:
                return stdout.decode().strip()
        except Exception as error:
            self.log.warn("git.rev_parse_error", error=str(error))
        return ""

    async def _sync_repo(self, repo: RepoEntry, boot_mode: BootMode) -> bool:
        self.log.debug(
            "git.sync_start",
            repo_owner=repo.owner,
            repo_name=repo.name,
            repo_path=str(repo.path),
        )
        if not repo.path.exists() and not await self._clone_repo(repo):
            return False
        return await self._update_existing_repo(repo, boot_mode)

    async def _sync_repo_status(self, repo: RepoEntry, boot_mode: BootMode) -> RepositorySyncStatus:
        try:
            succeeded = await self._sync_repo(repo, boot_mode)
        except RepositorySyncTimeout:
            return RepositorySyncStatus.TIMED_OUT
        return RepositorySyncStatus.SUCCEEDED if succeeded else RepositorySyncStatus.FAILED

    async def sync(
        self, repositories: list[RepoEntry], boot_mode: BootMode
    ) -> RepositorySyncResult:
        if not repositories:
            self.log.info("git.skip_clone", reason="no_repo_configured")
            return RepositorySyncResult((), ())
        statuses = await asyncio.gather(
            *(self._sync_repo_status(repo, boot_mode) for repo in repositories)
        )
        outcomes = tuple(
            RepositorySyncOutcome(repo, status)
            for repo, status in zip(repositories, statuses, strict=True)
        )
        resolved = await resolve_session_diff_baselines(
            repositories,
            discover_missing=boot_mode is not BootMode.SNAPSHOT_RESTORE,
            get_head_sha=self._get_head_sha,
        )
        return RepositorySyncResult(tuple(resolved), outcomes)
