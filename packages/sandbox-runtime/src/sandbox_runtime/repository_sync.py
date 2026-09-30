from __future__ import annotations

import asyncio
import os
import re
from contextvars import ContextVar
from dataclasses import dataclass
from enum import StrEnum
from pathlib import Path
from typing import TYPE_CHECKING, Any

from .boot_timing import measure_boot_stage
from .diff_baseline import resolve_session_diff_baselines
from .process_output import communicate_owned_subprocess, terminate_owned_subprocess
from .runtime_config import BootMode

if TYPE_CHECKING:
    from .repo_config import RepoEntry

GH_WRAPPER_REAL_PATH = "/usr/bin/gh"
GH_WRAPPER_INSTALL_PATH = Path("/usr/local/bin/gh")
CREDENTIAL_HELPER_INSTALL_PATH = Path("/usr/local/bin/oi-git-credentials")
GH_WRAPPER_BODY = Path(__file__).with_name("gh-wrapper.sh").read_text()
DEFAULT_GIT_CLONE_TIMEOUT_SECONDS = 300.0
DEFAULT_GIT_FETCH_TIMEOUT_SECONDS = 120.0
DEFAULT_GIT_INSPECTION_TIMEOUT_SECONDS = 10.0
# Exact full-length object names only. Short or prefixed refs are ambiguous and
# must keep flowing through the named-branch clone path.
_GIT_COMMIT_SHA_RE = re.compile(r"^(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$")
_REPOSITORY_INDEX: ContextVar[int | None] = ContextVar("repository_index", default=None)


def _is_pinned_commit(ref: str) -> bool:
    """True when ``ref`` is an exact full-length commit SHA, not a branch."""
    return bool(_GIT_COMMIT_SHA_RE.fullmatch(ref))


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
    before_head_sha: str | None = None
    after_head_sha: str | None = None
    tracked_clean: bool = False

    @property
    def source_unchanged(self) -> bool:
        """Only a verified full object identity can retain prepared setup."""
        return bool(
            self.status is RepositorySyncStatus.SUCCEEDED
            and self.tracked_clean
            and self.before_head_sha
            and self.after_head_sha
            and _is_pinned_commit(self.before_head_sha)
            and self.before_head_sha == self.after_head_sha
        )


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
        pinned_commit = _is_pinned_commit(repo.branch)
        clone_args = [
            "git",
            "clone",
            "--depth",
            str(self.CLONE_DEPTH_COMMITS),
        ]
        if pinned_commit:
            # ``--branch`` rejects a raw commit SHA on a fresh clone. Clone the
            # default tip without checking out; the follow-up update fetches the
            # pinned object into ``origin/<SHA>`` and checks it out.
            clone_args.append("--no-checkout")
        else:
            clone_args.extend(["--branch", repo.branch])
        clone_args.extend([self._build_repo_url(repo), str(repo.path)])
        try:
            result = await asyncio.create_subprocess_exec(
                *clone_args,
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
        shim_path = CREDENTIAL_HELPER_INSTALL_PATH
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
            with measure_boot_stage(
                self.log,
                "git_fetch",
                boot_mode=boot_mode.value,
                repository_index=_REPOSITORY_INDEX.get(),
            ) as stage:
                stage.succeeded = await self._fetch_branch(repo, repo.branch)
            if not stage.succeeded:
                return False
            if preserve_checkout:
                return True
            with measure_boot_stage(
                self.log,
                "git_checkout",
                boot_mode=boot_mode.value,
                repository_index=_REPOSITORY_INDEX.get(),
            ) as stage:
                stage.succeeded = await self._checkout_branch(repo, repo.branch)
            return stage.succeeded
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
            stdout, _ = await asyncio.wait_for(
                self._communicate_owned_subprocess(process),
                timeout=DEFAULT_GIT_INSPECTION_TIMEOUT_SECONDS,
            )
            if process.returncode == 0:
                return stdout.decode().strip()
        except Exception as error:
            self.log.warn("git.rev_parse_error", error=str(error))
        return ""

    async def _tracked_checkout_clean(self, repo: RepoEntry) -> bool:
        """Inspect tracked source only; ignored dependency contents are not verified."""
        if not repo.path.exists():
            return False
        try:
            process = await asyncio.create_subprocess_exec(
                "git",
                "diff-index",
                "--no-ext-diff",
                "--quiet",
                "HEAD",
                "--",
                cwd=repo.path,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                start_new_session=True,
            )
            await asyncio.wait_for(
                self._communicate_owned_subprocess(process),
                timeout=DEFAULT_GIT_INSPECTION_TIMEOUT_SECONDS,
            )
            return process.returncode == 0
        except Exception:
            return False

    async def _sync_repo(self, repo: RepoEntry, boot_mode: BootMode) -> bool:
        self.log.debug(
            "git.sync_start",
            repo_owner=repo.owner,
            repo_name=repo.name,
            repo_path=str(repo.path),
        )
        if not repo.path.exists():
            with measure_boot_stage(
                self.log,
                "git_clone",
                boot_mode=boot_mode.value,
                repository_index=_REPOSITORY_INDEX.get(),
            ) as stage:
                stage.succeeded = await self._clone_repo(repo)
            if not stage.succeeded:
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

        async def sync_member(index: int, repo: RepoEntry) -> RepositorySyncOutcome:
            token = _REPOSITORY_INDEX.set(index)
            try:
                before_sha = after_sha = None
                before_clean = after_clean = False
                if boot_mode is BootMode.REPO_IMAGE:
                    with measure_boot_stage(
                        self.log,
                        "git_verify_before",
                        boot_mode=boot_mode.value,
                        repository_index=index,
                    ) as stage:
                        before_sha = await self._get_head_sha(repo)
                        before_clean = await self._tracked_checkout_clean(repo)
                        stage.succeeded = bool(
                            before_sha and _is_pinned_commit(before_sha) and before_clean
                        )
                status = await self._sync_repo_status(repo, boot_mode)
                if boot_mode is BootMode.REPO_IMAGE:
                    with measure_boot_stage(
                        self.log,
                        "git_verify_after",
                        boot_mode=boot_mode.value,
                        repository_index=index,
                    ) as stage:
                        after_sha = await self._get_head_sha(repo)
                        after_clean = await self._tracked_checkout_clean(repo)
                        stage.succeeded = bool(
                            after_sha and _is_pinned_commit(after_sha) and after_clean
                        )
                return RepositorySyncOutcome(
                    repo,
                    status,
                    before_sha if before_sha and _is_pinned_commit(before_sha) else None,
                    after_sha if after_sha and _is_pinned_commit(after_sha) else None,
                    before_clean and after_clean,
                )
            finally:
                _REPOSITORY_INDEX.reset(token)

        outcomes = tuple(
            await asyncio.gather(
                *(sync_member(index, repo) for index, repo in enumerate(repositories))
            )
        )
        resolved = await resolve_session_diff_baselines(
            repositories,
            discover_missing=boot_mode is not BootMode.SNAPSHOT_RESTORE,
            get_head_sha=self._get_head_sha,
        )
        return RepositorySyncResult(tuple(resolved), outcomes)
