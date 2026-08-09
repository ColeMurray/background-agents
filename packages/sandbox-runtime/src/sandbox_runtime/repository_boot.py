from __future__ import annotations

import asyncio
import contextlib
import json
import os
import re
import signal
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .constants import (
    BOOT_WARNINGS_FILE_PATH,
    EXPECTED_TUNNEL_PORTS_ENV_VAR,
    REPO_MANIFEST_FILE_PATH,
    TUNNEL_ENV_FILE_PATH,
    TUNNEL_ENV_SANDBOX_ID_KEY,
)
from .diff_baseline import resolve_session_diff_baselines
from .repo_config import RepoConfigError, RepoEntry, dump_repo_manifest, parse_repositories
from .runtime_config import BootMode, RuntimeConfig

GH_WRAPPER_REAL_PATH = "/usr/bin/gh"
GH_WRAPPER_INSTALL_PATH = Path("/usr/local/bin/gh")
GH_WRAPPER_BODY = Path(__file__).with_name("gh-wrapper.sh").read_text()


@dataclass(frozen=True)
class BootstrapResult:
    git_sync_success: bool
    repository_shas: list[dict[str, str]]
    setup_success: bool | None
    start_success: bool | None
    repositories: tuple[RepoEntry, ...]
    workdir: Path


class RepositoryBootstrapper:
    SETUP_SCRIPT_PATH = ".openinspect/setup.sh"
    START_SCRIPT_PATH = ".openinspect/start.sh"
    DEFAULT_SETUP_TIMEOUT_SECONDS = 300
    DEFAULT_START_TIMEOUT_SECONDS = 120
    DEFAULT_TUNNEL_WAIT_TIMEOUT_SECONDS = 30
    TUNNEL_WAIT_POLL_INTERVAL_SECONDS = 0.2
    CLONE_DEPTH_COMMITS = 100

    def __init__(self, config: RuntimeConfig, shutdown_event: asyncio.Event, log: Any) -> None:
        self.config = config
        self.shutdown_event = shutdown_event
        self.log = log
        self.sandbox_id = config.sandbox_id
        self.repo_owner = config.repo_owner
        self.repo_name = config.repo_name
        self.vcs_host = config.vcs_host
        self.session_config = config.session_config
        self.has_repository = config.has_repository
        self.workspace_path = config.workspace_path
        self.repo_path = config.repo_path
        self.repo_config_error: str | None = None
        self.repositories = self._parse_repositories()
        self.is_multi_repo = len(self.repositories) > 1
        self.boot_mode = BootMode.FRESH.value
        self.git_sync_complete = asyncio.Event()

    @property
    def base_branch(self) -> str:
        return self.config.base_branch

    def _parse_repositories(self) -> list[RepoEntry]:
        """Build the ordered repository list, deferring config errors to run().

        A RepoConfigError (unsafe or duplicate names — the checkout path
        would escape /workspace or collide) cannot be reported from
        __init__, so it is stashed and run() raises it through the normal
        fatal-error path.
        """
        self.repo_config_error = None
        try:
            return parse_repositories(
                self.session_config,
                workspace_path=self.workspace_path,
                scalar_owner=self.repo_owner,
                scalar_name=self.repo_name,
                scalar_branch=self.base_branch,
            )
        except RepoConfigError as e:
            self.repo_config_error = str(e)
            return []

    def _build_repo_url(self, repo: RepoEntry) -> str:
        """Build the plain HTTPS URL for a repository.

        Authentication is supplied per-request by the system git credential
        helper, so the remote URL itself never carries a secret.
        """
        return f"https://{self.vcs_host}/{repo.owner}/{repo.name}.git"

    def _redact_git_stderr(self, stderr_text: str) -> str:
        """Redact credential-bearing URLs from git stderr.

        The credential helper means our own remotes are token-free, but git
        may surface upstream URLs (e.g. from submodules or HTTP redirects)
        that still embed credentials.
        """
        return re.sub(r"(https?://)([^/\s@]+)@", r"\1***@", stderr_text)

    async def _terminate_owned_subprocess(self, process: asyncio.subprocess.Process) -> None:
        """Kill a child process group and wait until the owned process exits."""
        if process.returncode is None:
            process_id = getattr(process, "pid", None)
            if isinstance(process_id, int):
                with contextlib.suppress(ProcessLookupError):
                    os.killpg(process_id, signal.SIGKILL)
            else:
                process.kill()
        await asyncio.shield(process.wait())

    async def _communicate_owned_subprocess(
        self, process: asyncio.subprocess.Process
    ) -> tuple[bytes, bytes]:
        """Collect output while guaranteeing teardown when the caller is cancelled."""
        try:
            stdout, stderr = await process.communicate()
            return stdout or b"", stderr or b""
        except asyncio.CancelledError:
            await self._terminate_owned_subprocess(process)
            raise

    async def _clone_repo(self, repo: RepoEntry) -> bool:
        """Shallow-clone a repository.

        The remote URL is unauthenticated — the system-wide git credential
        helper supplies short-lived credentials per request.
        """
        self.log.info(
            "git.clone_start",
            repo_owner=repo.owner,
            repo_name=repo.name,
        )

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
            _stdout, stderr = await self._communicate_owned_subprocess(result)
        except Exception as e:
            # Keep sync_repositories' partial-failure contract: an OSError
            # here must surface as a failed member, not abort the gather.
            self.log.error("git.clone_error", exc=e, repo_owner=repo.owner, repo_name=repo.name)
            return False

        if result.returncode != 0:
            self.log.error(
                "git.clone_error",
                repo_owner=repo.owner,
                repo_name=repo.name,
                stderr=self._redact_git_stderr(stderr.decode()),
                exit_code=result.returncode,
            )
            return False

        self.log.info("git.clone_complete", repo_path=str(repo.path))
        return True

    async def _ensure_credential_helper_configured(self) -> None:
        """Make sure git knows about our credential helper, even on old images.

        New base images install the helper system-wide
        (``git config --system credential.helper /usr/local/bin/oi-git-credentials``),
        but a sandbox booting from a snapshot or repo image built *before*
        this migration won't have that config. We re-apply the equivalent at
        the global level on every boot so the flow is robust regardless of
        image age.

        Writing the shim itself is also idempotent: each boot ensures the
        script is present at ``/usr/local/bin/oi-git-credentials`` and
        executable, so old images that lack it get patched in place.

        Failures here are logged but not fatal — if git already has the
        helper configured (the common case on new images), this is a no-op.
        """
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
        except OSError as e:
            # /usr/local/bin not writable in some sandboxed runs; the system
            # config baked into the image is the primary path anyway.
            self.log.warn("credential_helper.shim_write_failed", error=str(e))

        # credential.useHttpPath makes git include the repo path in helper
        # requests. The helper currently authorizes by host to preserve
        # installation-wide token behavior, but keeping the path available
        # preserves Git LFS behavior and leaves room for provider-specific
        # policy later.
        configs = [("credential.useHttpPath", "true")]
        if shim_available:
            configs.insert(0, ("credential.helper", str(shim_path)))

        for key, value in configs:
            proc = await asyncio.create_subprocess_exec(
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
            _stdout, stderr = await self._communicate_owned_subprocess(proc)
            if proc.returncode != 0:
                self.log.warn(
                    "credential_helper.config_failed",
                    config_key=key,
                    exit_code=proc.returncode,
                    stderr=stderr.decode(errors="replace"),
                )

        self._install_gh_wrapper()

    def _install_gh_wrapper(self) -> None:
        """Install the gh CLI wrapper at /usr/local/bin/gh.

        The canonical wrapper artifact is also baked into non-root provider
        images. Writable legacy images are patched at boot; a non-writable
        legacy image fails clearly rather than running gh unauthenticated.
        """
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
        except OSError as e:
            raise RuntimeError(
                f"Cannot install authenticated gh wrapper at {GH_WRAPPER_INSTALL_PATH}: {e}"
            ) from e

    async def _ensure_plain_origin(self, repo: RepoEntry) -> bool:
        """Rewrite the `origin` remote to a credential-free HTTPS URL.

        Older workspaces/images (from before the credential-helper migration)
        may embed a GitHub App installation token in the `origin` URL. Modal
        snapshot restores receive a fresh fallback token, but long-running
        sandboxes and Daytona persistent resumes can outlive embedded tokens.
        Normalizing `origin` keeps git fetches routed through the helper.

        Returns False on failure — callers must short-circuit, since a
        credentialed URL can produce an opaque 401 from upstream rather than
        routing through the helper.

        Idempotent — safe to call on every boot.
        """
        expected_url = self._build_repo_url(repo)
        proc = await asyncio.create_subprocess_exec(
            "git",
            "remote",
            "set-url",
            "origin",
            expected_url,
            cwd=repo.path,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            start_new_session=True,
        )
        _stdout, stderr = await self._communicate_owned_subprocess(proc)
        if proc.returncode != 0:
            self.log.error(
                "git.set_url_failed",
                exit_code=proc.returncode,
                stderr=self._redact_git_stderr(stderr.decode()),
            )
            return False
        return True

    async def _fetch_branch(self, repo: RepoEntry, branch: str) -> bool:
        """Fetch a branch with an explicit refspec.

        Uses an explicit refspec so that ``refs/remotes/origin/<branch>`` is
        created even in shallow or single-branch clones.
        """
        result = await asyncio.create_subprocess_exec(
            "git",
            "fetch",
            "origin",
            f"{branch}:refs/remotes/origin/{branch}",
            cwd=repo.path,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            start_new_session=True,
        )
        _stdout, stderr = await self._communicate_owned_subprocess(result)
        if result.returncode != 0:
            self.log.error(
                "git.fetch_error",
                stderr=self._redact_git_stderr(stderr.decode()),
                exit_code=result.returncode,
            )
            return False
        return True

    async def _checkout_branch(self, repo: RepoEntry, branch: str) -> bool:
        """Create/reset a local branch to match the remote tip."""
        result = await asyncio.create_subprocess_exec(
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
        _stdout, stderr = await self._communicate_owned_subprocess(result)
        if result.returncode != 0:
            self.log.warn(
                "git.checkout_error",
                stderr=self._redact_git_stderr(stderr.decode()),
                exit_code=result.returncode,
                target_branch=branch,
            )
            return False
        return True

    async def _update_existing_repo(self, repo: RepoEntry) -> bool:
        """Refresh an existing checkout without corrupting restored session state.

        A snapshot contains the session's HEAD, index, and worktree. Fetching
        remote refs is safe there, but checkout/reset is not. Fresh clones and
        explicitly initialized repository images still align to their requested
        branch.
        """
        if not repo.path.exists():
            self.log.info(
                "git.update_skip",
                reason="no_repo_path",
                repo_owner=repo.owner,
                repo_name=repo.name,
            )
            return False

        try:
            preserve_checkout = self.boot_mode == "snapshot_restore"
            if preserve_checkout:
                if not await self._ensure_plain_origin(repo):
                    return False
                return await self._fetch_branch(repo, repo.branch)
            if not await self._ensure_plain_origin(repo):
                return False
            if not await self._fetch_branch(repo, repo.branch):
                return False
            return await self._checkout_branch(repo, repo.branch)
        except Exception as e:
            if preserve_checkout:
                self.log.warn(
                    "git.restore_refresh_error",
                    exc=e,
                    repo_owner=repo.owner,
                    repo_name=repo.name,
                )
                return False
            self.log.error("git.update_error", exc=e, repo_owner=repo.owner, repo_name=repo.name)
            return False

    async def _get_head_sha(self, repo: RepoEntry) -> str:
        """Return the HEAD SHA of a repo, or empty string on failure."""
        if not repo.path.exists():
            return ""
        try:
            result = await asyncio.create_subprocess_exec(
                "git",
                "rev-parse",
                "HEAD",
                cwd=repo.path,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                start_new_session=True,
            )
            stdout, _ = await self._communicate_owned_subprocess(result)
            if result.returncode == 0:
                return stdout.decode().strip()
        except Exception as e:
            self.log.warn("git.rev_parse_error", error=str(e))
        return ""

    async def _sync_repo(self, repo: RepoEntry) -> bool:
        """Sync one repository: update in place when present, clone when missing.

        A fresh boot clones and aligns the requested branch. Snapshot restore
        refreshes refs without switching or resetting the restored checkout.
        """
        self.log.debug(
            "git.sync_start",
            repo_owner=repo.owner,
            repo_name=repo.name,
            repo_path=str(repo.path),
        )
        if not repo.path.exists():
            if not await self._clone_repo(repo):
                return False
        return await self._update_existing_repo(repo)

    async def sync_repositories(self) -> list[RepoEntry]:
        """Sync all repositories concurrently; returns the members that failed."""
        if not self.repositories:
            self.log.info("git.skip_clone", reason="no_repo_configured")
            return []

        results = await asyncio.gather(*(self._sync_repo(repo) for repo in self.repositories))
        return [repo for repo, ok in zip(self.repositories, results, strict=True) if not ok]

    def _record_boot_warning(
        self, *, scope: str, message: str, repo: RepoEntry | None = None
    ) -> None:
        """Queue a `warning` sandbox event for the bridge to forward on connect.

        The supervisor has no control-plane event channel of its own (only the
        fatal-error endpoint), and every boot warning happens before the
        bridge exists — so warnings are appended to a file the bridge drains
        after its WebSocket handshake.
        """
        entry: dict[str, str] = {"scope": scope, "message": message}
        if repo is not None:
            entry["repoOwner"] = repo.owner
            entry["repoName"] = repo.name
        # `message` is a reserved LogRecord field — don't pass it as a log kwarg.
        self.log.warn(
            "supervisor.boot_warning",
            scope=scope,
            warning_message=message,
            repo_owner=repo.owner if repo is not None else None,
            repo_name=repo.name if repo is not None else None,
        )
        try:
            with open(BOOT_WARNINGS_FILE_PATH, "a") as f:
                f.write(json.dumps(entry) + "\n")
        except Exception as e:
            self.log.warn("supervisor.boot_warning_write_failed", exc=e)

    def record_boot_warning(
        self, *, scope: str, message: str, repo: RepoEntry | None = None
    ) -> None:
        self._record_boot_warning(scope=scope, message=message, repo=repo)

    def _opencode_workdir(self) -> Path:
        """Root directory for OpenCode and code-server.

        Single-repo sessions keep today's behavior (the repo itself when
        cloned); multi-repo and repo-less sessions root at /workspace.
        """
        if (
            len(self.repositories) == 1
            and self.repo_path.exists()
            and (self.repo_path / ".git").exists()
        ):
            return self.repo_path
        return self.workspace_path

    def _write_repo_manifest(self) -> None:
        """Write the machine-readable repository manifest.

        The bridge (push targeting) and the JS create-pull-request tool
        resolve checkout paths through this file instead of re-deriving the
        /workspace layout. Written before any child process starts and
        rewritten on every boot so a snapshot never carries a stale member set.
        """
        try:
            Path(REPO_MANIFEST_FILE_PATH).write_text(dump_repo_manifest(self.repositories))
        except Exception as e:
            self.log.warn("supervisor.repo_manifest_write_failed", exc=e)

    def _write_workspace_manifest(self) -> None:
        """Write the generated /workspace/AGENTS.md for multi-repo sessions.

        Regenerated on every boot (restores included) so it always reflects
        the session's member set; single-repo sessions are untouched.
        """
        if not self.is_multi_repo:
            return

        primary = self.repositories[0]
        lines = [
            "<!-- Generated by Open-Inspect on every boot. Do not edit. -->",
            "",
            "# Workspace",
            "",
            "This session spans multiple repositories, checked out side by side:",
            "",
            "| Path | Repository | Base branch |",
            "| --- | --- | --- |",
        ]
        for repo in self.repositories:
            lines.append(f"| `./{repo.name}/` | {repo.owner}/{repo.name} | `{repo.branch}` |")
        lines.append("")

        working_branch = str(self.session_config.get("working_branch_name") or "").strip()
        if working_branch:
            lines.append(f"All work happens on the branch `{working_branch}` in every repository.")
            lines.append("")

        member_docs = [repo for repo in self.repositories if (repo.path / "AGENTS.md").exists()]
        if member_docs:
            lines.append(
                "Repository-specific instructions are NOT loaded automatically. "
                "Read them before working in a repository:"
            )
            lines.append("")
            lines.extend(f"- `./{repo.name}/AGENTS.md`" for repo in member_docs)
            lines.append("")

        lines.append(
            "To open a pull request, call the `create-pull-request` tool once per repository "
            f'with changes, passing its `repo` argument (e.g. `repo: "{primary.owner}/{primary.name}"`).'
        )
        lines.append("")

        try:
            (self.workspace_path / "AGENTS.md").write_text("\n".join(lines))
            self.log.info("workspace.manifest_written", repo_count=len(self.repositories))
        except Exception as e:
            self.log.warn("workspace.manifest_write_failed", exc=e)

    def _hook_env(self) -> dict[str, str]:
        """Build environment for startup hooks."""
        env = os.environ.copy()
        env["OPENINSPECT_BOOT_MODE"] = self.boot_mode
        return env

    async def _run_hook(
        self,
        *,
        repo: RepoEntry,
        hook_name: str,
        relative_script_path: str,
        timeout_env_var: str,
        default_timeout_seconds: int,
    ) -> bool:
        """
        Run one repository's hook script if present.

        Returns:
            True if script succeeded or was not present, False on failure/timeout.
        """
        script_path = repo.path / relative_script_path
        start_time = time.time()

        if not script_path.exists():
            self.log.debug(
                f"{hook_name}.skip",
                reason="no_script",
                path=str(script_path),
                boot_mode=self.boot_mode,
            )
            return True

        try:
            timeout_seconds = int(os.environ.get(timeout_env_var, str(default_timeout_seconds)))
        except ValueError:
            timeout_seconds = default_timeout_seconds

        self.log.info(
            f"{hook_name}.start",
            script=str(script_path),
            repo_owner=repo.owner,
            repo_name=repo.name,
            timeout_seconds=timeout_seconds,
            boot_mode=self.boot_mode,
        )

        try:
            process = await asyncio.create_subprocess_exec(
                "bash",
                str(script_path),
                cwd=repo.path,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.STDOUT,
                env=self._hook_env(),
                start_new_session=True,
            )

            try:
                stdout, _ = await asyncio.wait_for(
                    self._communicate_owned_subprocess(process),
                    timeout=timeout_seconds,
                )
            except TimeoutError:
                if process.returncode is None:
                    await self._terminate_owned_subprocess(process)
                stdout = await process.stdout.read() if process.stdout else b""
                output_tail = "\n".join(stdout.decode(errors="replace").splitlines()[-50:])
                duration_ms = int((time.time() - start_time) * 1000)
                timeout_fields: dict[str, object] = {
                    "timeout_seconds": timeout_seconds,
                    "script": str(script_path),
                    "duration_ms": duration_ms,
                    "boot_mode": self.boot_mode,
                }
                if self.boot_mode != "build":
                    timeout_fields["output_tail"] = output_tail
                self.log.error(f"{hook_name}.timeout", **timeout_fields)
                return False

            output_tail = "\n".join(
                (stdout.decode(errors="replace") if stdout else "").splitlines()[-50:]
            )
            duration_ms = int((time.time() - start_time) * 1000)

            if process.returncode == 0:
                # Avoid logging hook stdout at info level to reduce secret exposure risk.
                self.log.info(
                    f"{hook_name}.complete",
                    exit_code=0,
                    script=str(script_path),
                    duration_ms=duration_ms,
                    boot_mode=self.boot_mode,
                )
                return True

            failure_fields: dict[str, object] = {
                "exit_code": process.returncode,
                "script": str(script_path),
                "duration_ms": duration_ms,
                "boot_mode": self.boot_mode,
            }
            if self.boot_mode != "build":
                failure_fields["output_tail"] = output_tail
            self.log.error(f"{hook_name}.failed", **failure_fields)
            return False

        except Exception as e:
            duration_ms = int((time.time() - start_time) * 1000)
            self.log.error(
                f"{hook_name}.error",
                exc=e,
                script=str(script_path),
                duration_ms=duration_ms,
                boot_mode=self.boot_mode,
            )
            return False

    async def run_setup_script(self, repo: RepoEntry) -> bool:
        """
        Run one repository's .openinspect/setup.sh if it exists.

        Fatality is the caller's (run()) decision: build boots fail on any
        member, fresh boots warn and continue.

        Returns:
            True if script succeeded or was not present, False on failure/timeout.
        """
        return await self._run_hook(
            repo=repo,
            hook_name="setup",
            relative_script_path=self.SETUP_SCRIPT_PATH,
            timeout_env_var="SETUP_TIMEOUT_SECONDS",
            default_timeout_seconds=self.DEFAULT_SETUP_TIMEOUT_SECONDS,
        )

    async def run_start_script(self, repo: RepoEntry) -> bool:
        """
        Run one repository's .openinspect/start.sh if it exists.

        Fatality is the caller's (run()) decision: the primary stays fatal,
        secondaries warn and continue.

        Returns:
            True if script succeeded or was not present, False on failure/timeout.
        """
        return await self._run_hook(
            repo=repo,
            hook_name="start",
            relative_script_path=self.START_SCRIPT_PATH,
            timeout_env_var="START_TIMEOUT_SECONDS",
            default_timeout_seconds=self.DEFAULT_START_TIMEOUT_SECONDS,
        )

    def _expected_tunnel_ports(self) -> list[int]:
        """Parse EXPECTED_TUNNEL_PORTS env var into a list of port ints."""
        raw = os.environ.get(EXPECTED_TUNNEL_PORTS_ENV_VAR, "")
        if not raw:
            return []
        ports: list[int] = []
        for piece in raw.split(","):
            piece = piece.strip()
            if not piece:
                continue
            try:
                ports.append(int(piece))
            except ValueError:
                self.log.warn("tunnel.expected_ports_parse_failed", value=piece, raw=raw)
        return ports

    def _clear_stale_tunnel_env_file(self) -> None:
        """Remove a tunnel env file left behind by a previous sandbox.

        Presence alone doesn't mean stale: the manager's write only needs the
        container agent, so it can land before this entrypoint runs. A file
        tagged with our own SANDBOX_ID is that fresh write and must survive;
        anything else (snapshot/image leftover with dead URLs, or untagged) is
        cleared so `_wait_for_tunnel_env_file` blocks until fresh URLs arrive.
        """
        path = Path(TUNNEL_ENV_FILE_PATH)
        # exists() follows symlinks, so a dangling symlink reads as absent —
        # but it must still be cleared or it can break the manager's write.
        if not path.exists() and not path.is_symlink():
            return
        if self.sandbox_id and self.sandbox_id != "unknown":
            try:
                own_marker = f"{TUNNEL_ENV_SANDBOX_ID_KEY}={self.sandbox_id}"
                if own_marker in path.read_text().splitlines():
                    self.log.info("tunnel.fresh_file_kept", path=str(path))
                    return
            except Exception as e:
                self.log.warn("tunnel.stale_check_read_failed", path=str(path), exc=e)
        try:
            path.unlink(missing_ok=True)
            self.log.info("tunnel.stale_file_cleared", path=str(path))
        except Exception as e:
            self.log.warn("tunnel.stale_file_clear_failed", path=str(path), exc=e)

    async def _wait_for_tunnel_env_file(self, expected_ports: list[int]) -> bool:
        """Block until TUNNEL_ENV_FILE_PATH contains entries for all expected ports.

        On timeout, log and return False so start.sh proceeds with degraded data
        rather than hanging on a Modal-side outage.
        """
        if not expected_ports:
            return True

        timeout_seconds_raw = os.environ.get("TUNNEL_WAIT_TIMEOUT_SECONDS")
        try:
            timeout_seconds = (
                float(timeout_seconds_raw)
                if timeout_seconds_raw
                else self.DEFAULT_TUNNEL_WAIT_TIMEOUT_SECONDS
            )
        except ValueError:
            timeout_seconds = self.DEFAULT_TUNNEL_WAIT_TIMEOUT_SECONDS

        path = Path(TUNNEL_ENV_FILE_PATH)
        expected_prefixes = [f"TUNNEL_{p}=" for p in expected_ports]
        start_time = time.time()
        deadline = start_time + timeout_seconds

        while time.time() < deadline:
            if path.exists():
                try:
                    lines = path.read_text().splitlines()
                    if all(any(ln.startswith(pfx) for ln in lines) for pfx in expected_prefixes):
                        self.log.info(
                            "tunnel.env_file_ready",
                            path=str(path),
                            ports=expected_ports,
                            wait_ms=int((time.time() - start_time) * 1000),
                        )
                        return True
                except Exception as e:
                    self.log.warn("tunnel.env_file_read_failed", path=str(path), exc=e)
            await asyncio.sleep(self.TUNNEL_WAIT_POLL_INTERVAL_SECONDS)

        self.log.warn(
            "tunnel.env_file_wait_timeout",
            path=str(path),
            ports=expected_ports,
            timeout_seconds=timeout_seconds,
        )
        return False

    async def _run_repository_boot(self, expected_tunnel_ports: list[int]) -> BootstrapResult:
        """Synchronize repositories and run the hooks for the current boot mode."""
        if self.repo_config_error:
            raise RuntimeError(f"invalid repository config: {self.repo_config_error}")

        self._write_repo_manifest()

        if self.repositories:
            await self._ensure_credential_helper_configured()

        failed_repos = await self.sync_repositories()
        git_sync_success = not failed_repos
        if failed_repos:
            if self.boot_mode in ("fresh", "build"):
                failed_names = ", ".join(f"{repo.owner}/{repo.name}" for repo in failed_repos)
                raise RuntimeError(f"git sync failed for {failed_names}")
            for repo in failed_repos:
                self._record_boot_warning(
                    scope="sync",
                    repo=repo,
                    message=(
                        f"Could not update {repo.owner}/{repo.name} from origin; "
                        "the checkout may be stale."
                    ),
                )
        self.repositories = await resolve_session_diff_baselines(
            self.repositories,
            discover_missing=self.boot_mode != "snapshot_restore",
            get_head_sha=self._get_head_sha,
        )
        self._write_repo_manifest()

        head_sha = ""
        repository_shas: list[dict[str, str]] = []
        if self.boot_mode == "build" and git_sync_success and self.repositories:
            repository_shas = [
                {
                    "repoOwner": repo.owner,
                    "repoName": repo.name,
                    "baseSha": repo.base_sha or "",
                }
                for repo in self.repositories
            ]
            head_sha = repository_shas[0]["baseSha"]
            if head_sha:
                self.log.info(
                    "git.sync_complete",
                    head_sha=head_sha,
                    repository_shas=repository_shas,
                )
        self.git_sync_complete.set()

        setup_success: bool | None = None
        if self.repositories and self.boot_mode in ("fresh", "build"):
            setup_success = True
            for repo in self.repositories:
                if await self.run_setup_script(repo):
                    continue
                setup_success = False
                if self.boot_mode == "build":
                    raise RuntimeError(
                        f"setup hook failed for {repo.owner}/{repo.name} in build mode"
                    )
                self._record_boot_warning(
                    scope="setup",
                    repo=repo,
                    message=(
                        f"setup.sh failed for {repo.owner}/{repo.name}; "
                        "the session continues without it."
                    ),
                )

        start_success: bool | None = None
        if self.repositories and self.boot_mode != "build":
            await self._wait_for_tunnel_env_file(expected_tunnel_ports)
            start_success = True
            for index, repo in enumerate(self.repositories):
                if await self.run_start_script(repo):
                    continue
                start_success = False
                if index == 0:
                    raise RuntimeError(f"start hook failed for {repo.owner}/{repo.name}")
                self._record_boot_warning(
                    scope="start",
                    repo=repo,
                    message=(
                        f"start.sh failed for {repo.owner}/{repo.name}; "
                        "the session continues without it."
                    ),
                )

        self._write_workspace_manifest()
        return BootstrapResult(
            git_sync_success=git_sync_success,
            repository_shas=repository_shas,
            setup_success=setup_success,
            start_success=start_success,
            repositories=tuple(self.repositories),
            workdir=self._opencode_workdir(),
        )

    def expected_tunnel_ports(self) -> list[int]:
        return self._expected_tunnel_ports()

    def clear_stale_tunnel_env_file(self) -> None:
        self._clear_stale_tunnel_env_file()

    async def bootstrap(
        self, boot_mode: BootMode, expected_tunnel_ports: list[int]
    ) -> BootstrapResult:
        self.boot_mode = boot_mode.value
        return await self._run_repository_boot(expected_tunnel_ports)
