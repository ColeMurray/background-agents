"""Local Git push execution, independent of control-plane transport."""

import asyncio
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any, NoReturn

from .log_config import StructuredLogger
from .process_output import communicate_owned_subprocess
from .repo_config import find_repo_entry, load_repo_manifest

GIT_PUSH_TIMEOUT_SECONDS = 300.0
GIT_PUSH_TERMINATE_GRACE_SECONDS = 5.0


@dataclass(frozen=True)
class PushRequest:
    """Validated provider-generated push spec, or correlation data for a rejection."""

    branch_name: str
    repo_owner: str
    repo_name: str
    refspec: str
    push_url: str
    redacted_push_url: str
    force: bool

    @classmethod
    def from_push_spec(cls, push_spec: object) -> "PushRequest":
        spec = push_spec if isinstance(push_spec, dict) else {}

        def field(key: str) -> str:
            value = spec.get(key)
            return value.strip() if isinstance(value, str) else ""

        force = spec.get("force")
        request = cls(
            branch_name=field("targetBranch"),
            repo_owner=field("repoOwner"),
            repo_name=field("repoName"),
            refspec=field("refspec"),
            push_url=field("remoteUrl"),
            redacted_push_url=field("redactedRemoteUrl"),
            force=force if isinstance(force, bool) else False,
        )
        error = None
        if not isinstance(push_spec, dict):
            error = "missing push specification"
        elif ("repoOwner" in spec or "repoName" in spec) and not request.has_repo_identity:
            error = "pushSpec must carry both repoOwner and repoName"
        elif not request.branch_name:
            error = "missing target branch"
        elif (
            not request.refspec
            or not request.push_url
            or not request.redacted_push_url
            or not isinstance(force, bool)
        ):
            error = "invalid push specification"
        if error:
            raise PushRejected(f"Push failed - {error}", request)
        return request

    @property
    def has_repo_identity(self) -> bool:
        return bool(self.repo_owner and self.repo_name)

    @property
    def repo_full_name(self) -> str:
        return f"{self.repo_owner}/{self.repo_name}"

    def repo_fields(self) -> dict[str, Any]:
        """Include partial identity too, so rejected requests retain their metadata."""
        fields: dict[str, Any] = {}
        if self.repo_owner:
            fields["repoOwner"] = self.repo_owner
        if self.repo_name:
            fields["repoName"] = self.repo_name
        return fields


@dataclass(frozen=True)
class PushResult:
    request: PushRequest
    error: str | None = None


class PushRejected(Exception):
    """A user-facing rejection with optional parsed correlation metadata."""

    def __init__(self, message: str, request: PushRequest | None = None):
        super().__init__(message)
        self.request = request


class PushOperation:
    def __init__(self, *, repo_path: Path, manifest_path: Path, logger: StructuredLogger):
        self.repo_path = repo_path
        self.manifest_path = manifest_path
        self.log = logger

    async def execute(self, push_spec: object) -> PushResult:
        try:
            request = PushRequest.from_push_spec(push_spec)
        except PushRejected as rejection:
            assert rejection.request is not None
            self.log.warn("git.push_error", reason="invalid_push_spec")
            return PushResult(rejection.request, str(rejection))
        self.log.info(
            "git.push_start",
            branch_name=request.branch_name,
            repo_owner=request.repo_owner,
            repo_name=request.repo_name,
            mode="push_spec",
        )
        try:
            repo_dir = self._resolve_push_checkout(request)
            await self._run_git_push(request, repo_dir)
        except PushRejected as rejection:
            return PushResult(request, str(rejection))
        except Exception as e:
            self.log.error("git.push_error", exc=e, branch_name=request.branch_name)
            return PushResult(request, str(e) or "Push failed - unknown error")

        self.log.info(
            "git.push_complete",
            branch_name=request.branch_name,
            repo_owner=request.repo_owner,
            repo_name=request.repo_name,
        )
        return PushResult(request)

    def _reject_push(self, *, reason: str, message: str, **log_fields: Any) -> NoReturn:
        self.log.warn("git.push_error", reason=reason, **log_fields)
        raise PushRejected(message)

    def _resolve_push_checkout(self, request: PushRequest) -> Path:
        if request.has_repo_identity:
            return self._member_checkout(request)
        return self._sole_workspace_checkout()

    def _member_checkout(self, request: PushRequest) -> Path:
        # Only canonical manifest paths select checkouts, never spec-supplied paths.
        member = find_repo_entry(
            load_repo_manifest(self.manifest_path),
            request.repo_owner,
            request.repo_name,
        )
        if member is None:
            self._reject_push(
                reason="repo_not_session_member",
                message=f"Repository {request.repo_full_name} is not part of this session",
                repo_owner=request.repo_owner,
                repo_name=request.repo_name,
            )
        if not (member.path / ".git").exists():
            self._reject_push(
                reason="repo_not_in_workspace",
                message=f"Repository {request.repo_full_name} not found in workspace",
                repo_owner=request.repo_owner,
                repo_name=request.repo_name,
            )
        return member.path

    def _sole_workspace_checkout(self) -> Path:
        """Legacy identity-free fallback, sorted for deterministic selection."""
        repo_dirs = sorted(self.repo_path.glob("*/.git"))
        if not repo_dirs:
            self._reject_push(reason="no_repo_configured", message="No repository found")
        return repo_dirs[0].parent

    async def _run_git_push(self, request: PushRequest, repo_dir: Path) -> None:
        self.log.info(
            "git.push_command",
            branch_name=request.branch_name,
            refspec=request.refspec,
            force=request.force,
            remote_url=request.redacted_push_url,
        )
        process = await asyncio.create_subprocess_exec(
            "git",
            "push",
            *(["-f"] if request.force else []),
            "--",
            request.push_url,
            request.refspec,
            cwd=repo_dir,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            start_new_session=True,
        )
        try:
            _stdout, stderr = await asyncio.wait_for(
                communicate_owned_subprocess(
                    process, terminate_grace_seconds=GIT_PUSH_TERMINATE_GRACE_SECONDS
                ),
                timeout=GIT_PUSH_TIMEOUT_SECONDS,
            )
        except TimeoutError:
            self.log.warn(
                "git.push_timeout",
                branch_name=request.branch_name,
                timeout_ms=int(GIT_PUSH_TIMEOUT_SECONDS * 1000),
            )
            raise PushRejected(
                f"Push failed - git push timed out after {int(GIT_PUSH_TIMEOUT_SECONDS)}s"
            ) from None

        if process.returncode != 0:
            stderr_text = stderr.decode("utf-8", errors="replace").strip() if stderr else ""
            redacted_stderr_text = self._redact_git_stderr(
                stderr_text, request.push_url, request.redacted_push_url
            )
            self.log.warn(
                "git.push_failed", branch_name=request.branch_name, stderr=redacted_stderr_text
            )
            raise PushRejected(
                f"Push failed: {redacted_stderr_text}"
                if redacted_stderr_text
                else "Push failed - unknown error"
            )

    @staticmethod
    def _redact_git_stderr(stderr_text: str, push_url: str, redacted_push_url: str) -> str:
        """Redact credential-bearing URLs from git stderr."""
        redacted_stderr = stderr_text
        if push_url and redacted_push_url:
            redacted_stderr = redacted_stderr.replace(push_url, redacted_push_url)
        return re.sub(r"(https?://)([^/\s@]+)@", r"\1***@", redacted_stderr)
