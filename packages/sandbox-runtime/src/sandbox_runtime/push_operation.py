"""Local Git push execution, independent of control-plane transport."""

import asyncio
import contextlib
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any, NoReturn

from .log_config import StructuredLogger
from .repo_config import find_repo_entry, load_repo_manifest

GIT_PUSH_TIMEOUT_SECONDS = 300.0
GIT_PUSH_TERMINATE_GRACE_SECONDS = 5.0


@dataclass(frozen=True)
class PushRequest:
    """Provider-generated push spec with absent fields normalized to empty values."""

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
            return str(spec.get(key, "")).strip()

        return cls(
            branch_name=field("targetBranch"),
            repo_owner=field("repoOwner"),
            repo_name=field("repoName"),
            refspec=field("refspec"),
            push_url=field("remoteUrl"),
            redacted_push_url=field("redactedRemoteUrl"),
            force=bool(spec.get("force", False)),
        )

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
    """A user-facing rejection, already logged at the raise site."""


class PushOperation:
    def __init__(self, *, repo_path: Path, manifest_path: Path, logger: StructuredLogger):
        self.repo_path = repo_path
        self.manifest_path = manifest_path
        self.log = logger

    async def execute(self, push_spec: object) -> PushResult:
        request = PushRequest.from_push_spec(push_spec)
        self.log.info(
            "git.push_start",
            branch_name=request.branch_name,
            repo_owner=request.repo_owner,
            repo_name=request.repo_name,
            mode="push_spec",
        )
        try:
            self._validate_push_request(request, spec_present=isinstance(push_spec, dict))
            repo_dir = self._resolve_push_checkout(request)
            await self._run_git_push(request, repo_dir)
        except PushRejected as rejection:
            return PushResult(request, str(rejection))
        except Exception as e:
            self.log.error("git.push_error", exc=e, branch_name=request.branch_name)
            return PushResult(request, str(e))

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

    def _validate_push_request(self, request: PushRequest, *, spec_present: bool) -> None:
        if not spec_present:
            self._reject_push(
                reason="missing_push_spec",
                message="Push failed - missing push specification",
            )
        if bool(request.repo_owner) != bool(request.repo_name):
            self._reject_push(
                reason="partial_repo_identity",
                message="Push failed - pushSpec must carry both repoOwner and repoName",
                repo_owner=request.repo_owner,
                repo_name=request.repo_name,
            )
        if not request.branch_name:
            self._reject_push(
                reason="missing_target_branch",
                message="Push failed - missing target branch",
            )
        if not request.refspec or not request.push_url:
            self._reject_push(
                reason="invalid_push_spec",
                message="Push failed - invalid push specification",
            )

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
            request.push_url,
            request.refspec,
            *(["-f"] if request.force else []),
            cwd=repo_dir,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        try:
            _stdout, stderr = await asyncio.wait_for(
                process.communicate(), timeout=GIT_PUSH_TIMEOUT_SECONDS
            )
        except TimeoutError:
            self.log.warn(
                "git.push_timeout",
                branch_name=request.branch_name,
                timeout_ms=int(GIT_PUSH_TIMEOUT_SECONDS * 1000),
            )
            await self._terminate_push_process(process, request.branch_name)
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

    async def _terminate_push_process(
        self, process: asyncio.subprocess.Process, branch_name: str
    ) -> None:
        with contextlib.suppress(ProcessLookupError):
            process.terminate()
        try:
            await asyncio.wait_for(process.wait(), timeout=GIT_PUSH_TERMINATE_GRACE_SECONDS)
        except TimeoutError:
            self.log.warn(
                "git.push_kill",
                branch_name=branch_name,
                timeout_ms=int(GIT_PUSH_TERMINATE_GRACE_SECONDS * 1000),
            )
            with contextlib.suppress(ProcessLookupError):
                process.kill()
            await process.wait()

    @staticmethod
    def _redact_git_stderr(stderr_text: str, push_url: str, redacted_push_url: str) -> str:
        """Redact credential-bearing URLs from git stderr."""
        redacted_stderr = stderr_text
        if push_url and redacted_push_url:
            redacted_stderr = redacted_stderr.replace(push_url, redacted_push_url)
        return re.sub(r"(https?://)([^/\s@]+)@", r"\1***@", redacted_stderr)
