#!/usr/bin/env python3
"""
Sandbox entrypoint - manages OpenCode server and bridge lifecycle.

Runs as PID 1 inside the sandbox. Responsibilities:
1. Perform git sync with latest code
2. Run repo hooks (setup/start) based on boot mode
3. Start OpenCode server
4. Start bridge process for control plane communication
5. Monitor processes and restart on crash with exponential backoff
6. Handle graceful shutdown on SIGTERM/SIGINT
"""

import asyncio
import json
import os
import re
import shutil
import signal
import time
from collections.abc import AsyncIterator
from pathlib import Path

import httpx

from .constants import (
    BOOT_WARNINGS_FILE_PATH,
    CODE_SERVER_PORT,
    CODE_SERVER_PORT_ENV_VAR,
    EXPECTED_TUNNEL_PORTS_ENV_VAR,
    REPO_MANIFEST_FILE_PATH,
    TTYD_PORT,
    TTYD_PROXY_PORT,
    TTYD_PROXY_PORT_ENV_VAR,
    TUNNEL_ENV_FILE_PATH,
    TUNNEL_ENV_SANDBOX_ID_KEY,
)
from .diff_baseline import resolve_session_diff_baselines
from .log_config import configure_logging, get_logger
from .repo_config import RepoConfigError, RepoEntry, dump_repo_manifest, parse_repositories
from .repo_image_callback import RepoImageBuildCallback

configure_logging()

BIN_INSTALL_DIR_ENV_VAR = "OPENINSPECT_BIN_INSTALL_DIR"

# asyncio.StreamReader raises (rather than returns) once a single line exceeds
# its buffer, which defaults to 64 KiB. Child-process log lines — JSON events
# carrying command output or diffs — can legitimately run larger, so the log
# forwarders read with this more generous per-line limit before a line has to
# be truncated.
_LOG_FORWARD_STREAM_LIMIT_BYTES = 1024 * 1024

# Substituted for a single log line too large to forward intact, so the gap is
# visible instead of silently dropped.
_TRUNCATED_LINE_NOTICE = "[log line too large to forward; truncated]"


def _port_from_env(env_var: str, default: int) -> int:
    """Read an integer port from the environment, falling back to ``default``."""
    raw = os.environ.get(env_var)
    if raw is None:
        return default
    try:
        port = int(raw)
    except ValueError:
        return default
    return port if 1 <= port <= 65535 else default


AGENT_TOOLS_GATED_ON_ENV: dict[str, str] = {
    "slack-notify.js": "AGENT_SLACK_NOTIFY_ENABLED",
}

AGENT_TOOLS_REQUIRING_REPOSITORY: set[str] = set()

# Wrapper installed at /usr/local/bin/gh (ahead of the real /usr/bin/gh in
# PATH). The git credential helper can't authenticate the GitHub CLI — gh
# reads GH_TOKEN/GITHUB_TOKEN from the environment, not git's protocol. This
# thin delegator asks the credential helper's `gh-token` action whether a
# fresh token is needed (the precedence logic lives there, in Python). If it
# prints one we export it as GH_TOKEN; otherwise gh runs with its own env.
GH_WRAPPER_REAL_PATH = "/usr/bin/gh"
GH_WRAPPER_BODY = (
    "#!/bin/sh\n"
    f'REAL_GH="{GH_WRAPPER_REAL_PATH}"\n'
    # stderr is left attached so the helper's diagnostic surfaces when a
    # refresh fails — otherwise the user just sees an opaque gh 401.
    "token=$(python3 -m sandbox_runtime.credentials.git_credential_helper gh-token || true)\n"
    'if [ -n "$token" ]; then\n'
    # export (not `env GH_TOKEN=… exec`) so the token never lands in argv.
    '  export GH_TOKEN="$token"\n'
    "fi\n"
    'exec "$REAL_GH" "$@"\n'
)


class SandboxSupervisor:
    """
    Supervisor process for sandbox lifecycle management.

    Manages:
    - Git synchronization with base branch
    - OpenCode server process
    - Bridge process for control plane communication
    - Process monitoring with crash recovery
    """

    # Configuration
    OPENCODE_PORT = 4096
    HEALTH_CHECK_TIMEOUT = 30.0
    MAX_RESTARTS = 5
    BACKOFF_BASE = 2.0
    BACKOFF_MAX = 60.0
    SETUP_SCRIPT_PATH = ".openinspect/setup.sh"
    START_SCRIPT_PATH = ".openinspect/start.sh"
    DEFAULT_SETUP_TIMEOUT_SECONDS = 300
    DEFAULT_START_TIMEOUT_SECONDS = 120
    DEFAULT_TUNNEL_WAIT_TIMEOUT_SECONDS = 30
    TUNNEL_WAIT_POLL_INTERVAL_SECONDS = 0.2
    CLONE_DEPTH_COMMITS = 100
    SIDECAR_TIMEOUT_SECONDS = 5
    MCP_PACKAGE_INSTALL_TIMEOUT_SECONDS = 180

    def __init__(self):
        self.opencode_process: asyncio.subprocess.Process | None = None
        self.bridge_process: asyncio.subprocess.Process | None = None
        self.code_server_process: asyncio.subprocess.Process | None = None
        self.ttyd_process: asyncio.subprocess.Process | None = None
        self.ttyd_proxy_process: asyncio.subprocess.Process | None = None
        self.shutdown_event = asyncio.Event()
        self.git_sync_complete = asyncio.Event()
        self.opencode_ready = asyncio.Event()
        self.boot_mode = "unknown"

        # Configuration from environment (set by Modal/SandboxManager)
        self.sandbox_id = os.environ.get("SANDBOX_ID", "unknown")
        self.control_plane_url = os.environ.get("CONTROL_PLANE_URL", "")
        self.sandbox_token = os.environ.get("SANDBOX_AUTH_TOKEN", "")
        self.repo_owner = os.environ.get("REPO_OWNER", "")
        self.repo_name = os.environ.get("REPO_NAME", "")
        self.vcs_host = os.environ.get("VCS_HOST", "github.com")
        # Note: VCS credentials are no longer captured at sandbox start. Git
        # operations authenticate per-call via the system-wide credential
        # helper (`/usr/local/bin/oi-git-credentials`), which fetches fresh
        # tokens from the control plane.

        # Parse session config if provided
        session_config_json = os.environ.get("SESSION_CONFIG", "{}")
        self.session_config = json.loads(session_config_json)
        self.has_repository = bool(self.repo_owner) and bool(self.repo_name)

        # Paths
        self.workspace_path = Path("/workspace")
        self.repo_path = (
            self.workspace_path / self.repo_name if self.has_repository else self.workspace_path
        )
        self.session_id_file = Path("/tmp/opencode-session-id")

        # Ordered repository list. SESSION_CONFIG.repositories is the source
        # of truth; absent, a one-entry list is synthesized from the scalar
        # env so every downstream path iterates the same shape. repo_path
        # stays the primary's path (repositories[0] mirrors REPO_OWNER/NAME).
        self.repo_config_error: str | None = None
        self.repositories = self._parse_repositories()
        self.is_multi_repo = len(self.repositories) > 1

        # Logger
        session_id = self.session_config.get("session_id", "")
        self.log = get_logger(
            "supervisor",
            service="sandbox",
            sandbox_id=self.sandbox_id,
            session_id=session_id,
        )

    @property
    def base_branch(self) -> str:
        """The branch to clone/fetch — defaults to 'main'."""
        return self.session_config.get("branch") or "main"

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

    # ------------------------------------------------------------------
    # Git primitives
    # ------------------------------------------------------------------

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
            )
            _stdout, stderr = await result.communicate()
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
            )
            _stdout, stderr = await proc.communicate()
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

        See ``GH_WRAPPER_BODY`` for the wrapper's behaviour. Installed at boot
        (rather than baked into the image) so it also patches snapshots and
        repo images built before this migration.
        """
        wrapper_path = Path("/usr/local/bin/gh")
        try:
            # Only install if the real gh exists and we're not about to shadow
            # ourselves (defensive against a previous wrapper at /usr/bin/gh).
            if Path(GH_WRAPPER_REAL_PATH).exists() and (
                not wrapper_path.exists() or wrapper_path.read_text() != GH_WRAPPER_BODY
            ):
                wrapper_path.write_text(GH_WRAPPER_BODY)
                wrapper_path.chmod(0o755)
        except OSError as e:
            self.log.debug("gh_wrapper.install_failed", error=str(e))

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
        )
        _stdout, stderr = await proc.communicate()
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
        )
        _stdout, stderr = await result.communicate()
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
        )
        _stdout, stderr = await result.communicate()
        if result.returncode != 0:
            self.log.warn(
                "git.checkout_error",
                stderr=self._redact_git_stderr(stderr.decode()),
                exit_code=result.returncode,
                target_branch=branch,
            )
            return False
        return True

    # ------------------------------------------------------------------
    # Git sync methods (compose the primitives above)
    # ------------------------------------------------------------------

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
            )
            stdout, _ = await result.communicate()
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

    # ------------------------------------------------------------------
    # Multi-repo workspace assembly
    # ------------------------------------------------------------------

    def _record_boot_warning(
        self, *, scope: str, message: str, repo: RepoEntry | None = None
    ) -> None:
        """Queue a `warning` sandbox event for the bridge to forward on connect.

        The supervisor has no control-plane event channel of its own (only the
        fatal-error endpoint), and every boot warning happens before the
        bridge exists — so warnings are appended to a file the bridge drains
        after its WebSocket handshake.
        """
        entry: dict = {"scope": scope, "message": message}
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

    def _assemble_workspace_opencode(self) -> None:
        """Merge member repos' .opencode/ into the workspace root (multi-repo only).

        OpenCode discovers config relative to its cwd — /workspace for
        multi-repo sessions — so per-repo custom tools/skills/commands would
        never load. Files are copied in position order, last write wins with a
        warning naming both members; the system tools installed afterwards
        still override on filename collision (same as single-repo today).
        """
        if not self.is_multi_repo:
            return

        dest_root = self.workspace_path / ".opencode"
        # The merged tree is generated state: rebuild it from scratch so
        # entries removed from a member (or a removed member) don't survive
        # snapshot/repo-image boots. System tools and staged deps are
        # re-installed after assembly on every boot. node_modules is spared:
        # assembly never writes into it (member node_modules are skipped), so
        # it's purely image-managed — deleting it would force
        # _stage_opencode_deps to re-copy the whole module tree on every
        # snapshot restore instead of taking its skip-if-present fast path.
        if dest_root.is_dir():
            for child in dest_root.iterdir():
                if child.name == "node_modules":
                    continue
                if child.is_dir() and not child.is_symlink():
                    shutil.rmtree(child, ignore_errors=True)
                else:
                    child.unlink(missing_ok=True)
        provenance: dict[str, RepoEntry] = {}
        for repo in self.repositories:
            src_root = repo.path / ".opencode"
            if not src_root.is_dir():
                continue
            for src in sorted(src_root.rglob("*")):
                if not src.is_file():
                    continue
                rel = src.relative_to(src_root)
                if any(part in ("node_modules", "__pycache__") for part in rel.parts):
                    continue
                prior = provenance.get(str(rel))
                if prior is not None:
                    self._record_boot_warning(
                        scope="assembly",
                        repo=repo,
                        message=(
                            f".opencode/{rel} from {prior.owner}/{prior.name} is overridden "
                            f"by {repo.owner}/{repo.name} (later repositories win)"
                        ),
                    )
                dest = dest_root / rel
                dest.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(src, dest)
                provenance[str(rel)] = repo

        if provenance:
            self.log.info(
                "opencode.workspace_assembled",
                file_count=len(provenance),
                repo_count=len(self.repositories),
            )

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

    def _install_tools(self, workdir: Path) -> None:
        """Copy custom tools into the .opencode/tool directory for OpenCode to discover."""
        opencode_dir = workdir / ".opencode"
        tool_dest = opencode_dir / "tool"

        # Legacy tool (inspect-plugin.js → create-pull-request.js)
        legacy_tool = Path("/app/sandbox_runtime/plugins/inspect-plugin.js")
        # New tools directory
        tools_dir = Path("/app/sandbox_runtime/tools")

        has_tools = legacy_tool.exists() or tools_dir.exists()
        if not has_tools:
            return

        tool_dest.mkdir(parents=True, exist_ok=True)

        if legacy_tool.exists() and self.has_repository:
            shutil.copy(legacy_tool, tool_dest / "create-pull-request.js")

        # Copy all .js files from tools/ — these must export tool() for OpenCode.
        # Tools listed in AGENT_TOOLS_GATED_ON_ENV are skipped unless their gate
        # env var is "true".
        if tools_dir.exists():
            for tool_file in tools_dir.iterdir():
                if not (tool_file.is_file() and tool_file.suffix == ".js"):
                    continue
                gate_env = AGENT_TOOLS_GATED_ON_ENV.get(tool_file.name)
                if gate_env and os.environ.get(gate_env, "").lower() != "true":
                    continue
                if tool_file.name in AGENT_TOOLS_REQUIRING_REPOSITORY and not self.has_repository:
                    continue
                shutil.copy(tool_file, tool_dest / tool_file.name)

        # Copy pre-built deps (package.json, package-lock.json, node_modules) from the image
        # staging directory so OpenCode's Npm.install() finds the tree in sync and skips the
        # arborist reify() that would otherwise block the first request.
        staged_at = time.monotonic()
        self._stage_opencode_deps(Path("/app/opencode-deps"), opencode_dir)
        self.log.info(
            "opencode.repo_deps_staged",
            dir=str(opencode_dir),
            duration_ms=round((time.monotonic() - staged_at) * 1000),
        )

    @staticmethod
    def _stage_opencode_deps(deps_cache: Path, dest_dir: Path) -> None:
        """Copy the pre-staged OpenCode plugin deps into dest_dir.

        Copies package.json, package-lock.json and node_modules from the image staging
        directory (base.py's /app/opencode-deps) into dest_dir, per file and only when the
        destination is absent. This gives OpenCode a lockfile that matches node_modules so
        Npm.install() finds @opencode-ai/plugin in sync and skips the arborist reify() that
        would otherwise block the first request.
        """
        for name in ("package.json", "package-lock.json"):
            src = deps_cache / name
            dest = dest_dir / name
            if src.exists() and not dest.exists():
                shutil.copy2(src, dest)
        cached_modules = deps_cache / "node_modules"
        local_modules = dest_dir / "node_modules"
        if cached_modules.is_dir() and not local_modules.exists():
            shutil.copytree(cached_modules, local_modules, symlinks=True)

    @staticmethod
    def _resolve_opencode_global_config_dir() -> Path:
        """Resolve OpenCode's global config directory the way OpenCode does.

        OpenCode (via xdg-basedir) uses OPENCODE_CONFIG_DIR when set, otherwise
        $XDG_CONFIG_HOME/opencode, otherwise ~/.config/opencode.
        """
        override = os.environ.get("OPENCODE_CONFIG_DIR")
        if override:
            return Path(override)
        xdg = os.environ.get("XDG_CONFIG_HOME")
        base = Path(xdg) if xdg else Path.home() / ".config"
        return base / "opencode"

    def _seed_global_opencode_deps(self) -> None:
        """Fallback seed of OpenCode's global config dir with the staged plugin tree.

        OpenCode bootstraps every directory in its config search path and forks
        ``npm install @opencode-ai/plugin`` for each. The global config dir is created empty and
        is never seeded by _install_tools (which only covers the repo's .opencode/), so with a
        plugin configured the first POST /session would block on an arborist reify() of it.

        The image bakes this tree into the global dir at build time (base.py), so this is
        normally a no-op (we skip when node_modules already exists); it stays as a fallback for
        environments where the baked dir is absent (e.g. a different HOME).
        """
        deps_cache = Path("/app/opencode-deps")
        if not deps_cache.is_dir():
            return
        config_dir = self._resolve_opencode_global_config_dir()
        # Only seed a pristine dir — never mix our modules into a user's manifest. The image
        # bakes this tree in (base.py), so node_modules is normally already present and we skip.
        nm_exists = (config_dir / "node_modules").exists()
        if nm_exists or (config_dir / "package.json").exists():
            self.log.info(
                "opencode.global_deps_skip",
                config_dir=str(config_dir),
                reason="already_present" if nm_exists else "foreign_manifest",
            )
            return
        seeded_at = time.monotonic()
        config_dir.mkdir(parents=True, exist_ok=True)
        self._stage_opencode_deps(deps_cache, config_dir)
        self.log.info(
            "opencode.global_deps_seeded",
            config_dir=str(config_dir),
            duration_ms=round((time.monotonic() - seeded_at) * 1000),
        )

    def _prepare_opencode_filesystem(self, workdir: Path) -> None:
        """Stage OpenCode's filesystem assets (tools, deps, skills, bin) before launch.

        The global seed is best-effort (degrades to a slower reify); the rest fail fast.
        """
        self._assemble_workspace_opencode()
        self._install_tools(workdir)
        try:
            self._seed_global_opencode_deps()
        except Exception as e:
            self.log.warn("opencode.global_deps_seed_failed", exc=e)
        self._install_skills(workdir)
        self._install_bin_scripts()

    def _install_bin_scripts(self) -> None:
        """Install standalone CLI scripts into the sandbox bin directory.

        Scripts in bin/ are standalone CLIs (not OpenCode tool plugins) and must
        NOT be placed in .opencode/tool/ — OpenCode would import() them during
        tool discovery, executing module-level code with the parent process argv.
        """
        bin_dir = Path("/app/sandbox_runtime/bin")
        if not bin_dir.is_dir():
            return

        for script in bin_dir.iterdir():
            if script.is_file() and script.suffix == ".js":
                install_dir = Path(os.environ.get(BIN_INSTALL_DIR_ENV_VAR, "/usr/local/bin"))
                install_dir.mkdir(parents=True, exist_ok=True)
                dest = install_dir / script.stem
                shutil.copy(script, dest)
                dest.chmod(0o755)
                self.log.info("bin.installed", script=script.stem)

    def _install_skills(self, workdir: Path) -> None:
        """Copy bundled Skills into the .opencode/skills directory."""
        skills_dir = Path("/app/sandbox_runtime/skills")
        if not skills_dir.is_dir():
            return

        skills_dest = workdir / ".opencode" / "skills"
        installed_any = False

        for skill_dir in skills_dir.iterdir():
            skill_file = skill_dir / "SKILL.md"
            if not skill_dir.is_dir() or not skill_file.exists():
                continue

            dest_dir = skills_dest / skill_dir.name
            # Preserve symlinks rather than dereferencing paths outside the bundled skill.
            shutil.copytree(
                skill_dir,
                dest_dir,
                dirs_exist_ok=True,
                ignore=shutil.ignore_patterns("__pycache__", "*.pyc", ".DS_Store"),
                symlinks=True,
            )
            installed_any = True

        if installed_any:
            self.log.info("opencode.skills_installed", skills_path=str(skills_dest))

    def _setup_openai_oauth(self) -> None:
        """Write OpenCode auth.json for ChatGPT OAuth if refresh token is configured."""
        refresh_token = os.environ.get("OPENAI_OAUTH_REFRESH_TOKEN")
        if not refresh_token:
            return

        try:
            auth_dir = Path.home() / ".local" / "share" / "opencode"
            auth_dir.mkdir(parents=True, exist_ok=True)

            openai_entry = {
                "type": "oauth",
                "refresh": "managed-by-control-plane",
                "access": "",
                "expires": 0,
            }

            account_id = os.environ.get("OPENAI_OAUTH_ACCOUNT_ID")
            if account_id:
                openai_entry["accountId"] = account_id

            auth_file = auth_dir / "auth.json"
            tmp_file = auth_dir / ".auth.json.tmp"

            # Write to a temp file created with 0o600 from the start, then
            # atomically rename so the target is never world-readable.
            fd = os.open(str(tmp_file), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            try:
                os.write(fd, json.dumps({"openai": openai_entry}).encode())
            finally:
                os.close(fd)
            tmp_file.replace(auth_file)

            self.log.info("openai_oauth.setup")
        except Exception as e:
            self.log.warn("openai_oauth.setup_error", exc=e)

    async def start_code_server(self) -> None:
        """Start code-server for browser-based VS Code editing."""
        password = os.environ.get("CODE_SERVER_PASSWORD")
        if not password:
            self.log.info("code_server.skip", reason="no_password")
            return

        workdir = self._opencode_workdir()

        code_server_port = _port_from_env(CODE_SERVER_PORT_ENV_VAR, CODE_SERVER_PORT)
        self.code_server_process = await asyncio.create_subprocess_exec(
            "code-server",
            "--bind-addr",
            f"0.0.0.0:{code_server_port}",
            "--auth",
            "password",
            "--disable-telemetry",
            str(workdir),
            cwd=workdir,
            env={**os.environ, "PASSWORD": password},
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
            limit=_LOG_FORWARD_STREAM_LIMIT_BYTES,
        )

        asyncio.create_task(self._forward_code_server_logs())
        self.log.info("code_server.started", port=code_server_port)

    async def _iter_process_lines(
        self, stream: asyncio.StreamReader, *, error_event: str
    ) -> AsyncIterator[str]:
        """Yield decoded stdout lines from a child process, resiliently.

        ``async for line in stream`` reads through ``StreamReader.readline``,
        which raises (rather than returns) once a single line is larger than the
        stream buffer and then ends iteration for good, silently dropping every
        later line; an undecodable byte ends it just as permanently. This keeps
        going instead — an oversized line becomes a truncation notice and bad
        bytes are replaced — so forwarding survives for the life of the process.
        """
        while True:
            try:
                raw = await stream.readline()
            except ValueError:
                # Line exceeded the buffer limit. readline() has already dropped
                # the offending bytes, so flag the gap and keep forwarding.
                yield _TRUNCATED_LINE_NOTICE
                continue
            except Exception as e:
                # An unexpected reader failure (e.g. a closed transport) is
                # terminal for this stream — log once and stop.
                self.log.warn(error_event, exc=e)
                return
            if not raw:
                return  # EOF: the process closed its stdout.
            yield raw.decode("utf-8", errors="replace").rstrip()

    async def _forward_code_server_logs(self) -> None:
        """Forward code-server stdout to supervisor stdout."""
        if not self.code_server_process or not self.code_server_process.stdout:
            return
        async for line in self._iter_process_lines(
            self.code_server_process.stdout,
            error_event="code_server.log_forward_error",
        ):
            self.log.info("code_server.stdout", line=line)

    def _resolve_mcp_servers(self) -> list[dict]:
        """Resolve MCP servers from session config."""
        return self.session_config.get("mcp_servers") or []

    # Validates npm package names before passing to `npm install -g`.
    # Accepts: "package", "@scope/package", "package@1.0.0", "@scope/package@1.0.0"
    # Rejects anything with shell metacharacters or path traversal sequences.
    # NOTE: if a legitimate package is rejected, widen this regex rather than
    # removing the check — the package name comes from user-supplied config.
    _NPM_PKG_RE = re.compile(r"^(@[\w.-]+/)?[\w][\w.-]*(@[\w.-]+)?$")

    async def _install_mcp_packages(self, servers: list[dict]) -> None:
        """Pre-install npm packages for local MCP servers that use npx."""
        packages: list[str] = []
        for server in servers:
            if server.get("type") == "remote":
                continue
            cmd = server.get("command", [])
            if not cmd:
                continue
            parts = [c for c in cmd if isinstance(c, str)]
            if not parts or parts[0] != "npx":
                continue
            # Extract package name: prefer -p/--package flag, else first non-flag arg
            pkg: str | None = None
            for i, part in enumerate(parts):
                if part in ("-p", "--package") and i + 1 < len(parts):
                    pkg = parts[i + 1]
                    break
            if pkg is None:
                non_flags = [p for p in parts[1:] if not p.startswith("-")]
                pkg = non_flags[0] if non_flags else None

            if pkg:
                if self._NPM_PKG_RE.match(pkg):
                    packages.append(pkg)
                else:
                    self.log.warn(
                        "mcp.invalid_package_name",
                        package=pkg,
                        note="package skipped — npx will attempt download at runtime",
                    )

        packages = list(dict.fromkeys(packages))  # deduplicate, preserve order
        if not packages:
            return

        self.log.info("mcp.install_packages", packages=packages)
        try:
            proc = await asyncio.create_subprocess_exec(
                "npm",
                "install",
                "-g",
                *packages,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            _stdout, stderr = await asyncio.wait_for(
                proc.communicate(), timeout=self.MCP_PACKAGE_INSTALL_TIMEOUT_SECONDS
            )
            if proc.returncode == 0:
                self.log.info("mcp.packages_installed", packages=packages)
            else:
                self.log.warn(
                    "mcp.packages_install_failed",
                    packages=packages,
                    stderr=(stderr or b"").decode()[:500],
                )
        except TimeoutError:
            self.log.warn(
                "mcp.packages_install_timeout",
                packages=packages,
                timeout_seconds=self.MCP_PACKAGE_INSTALL_TIMEOUT_SECONDS,
            )
            proc.kill()
            await proc.wait()
        except Exception as e:
            self.log.warn("mcp.packages_install_error", packages=packages, exc=str(e))

    def _build_mcp_config(self, servers: list[dict]) -> dict[str, dict]:
        """Convert MCP server list to OpenCode mcp config format."""
        config: dict[str, dict] = {}
        for server in servers:
            name = server.get("name", "")
            if not name:
                continue
            if server.get("type") == "remote":
                entry: dict = {"type": "remote", "url": server.get("url", "")}
                auth_headers = server.get("headers") or server.get("env") or {}
                if auth_headers:
                    entry["headers"] = auth_headers
                config[name] = entry
            else:
                entry = {
                    "type": "local",
                    "command": server.get("command", []),
                }
                if server.get("env"):
                    entry["environment"] = server["env"]
                config[name] = entry
        return config

    async def start_ttyd(self) -> None:
        """Start ttyd web terminal if TERMINAL_ENABLED is set."""
        if not os.environ.get("TERMINAL_ENABLED"):
            self.log.info("ttyd.skip", reason="TERMINAL_ENABLED not set")
            return

        workdir = (
            str(self.repo_path)
            if self.repo_path and (self.repo_path / ".git").exists()
            else "/workspace"
        )

        cmd = [
            "ttyd",
            "--port",
            str(TTYD_PORT),  # localhost-only internal port; fixed (never exposed)
            "--interface",
            "127.0.0.1",  # localhost only — proxy is the only external gateway
            "--writable",
            "bash",
        ]

        self.log.info("ttyd.starting", port=TTYD_PORT, workdir=workdir)

        self.ttyd_process = await asyncio.create_subprocess_exec(
            *cmd,
            cwd=workdir,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
            env=os.environ.copy(),
            limit=_LOG_FORWARD_STREAM_LIMIT_BYTES,
        )

        asyncio.create_task(self._forward_ttyd_logs())
        self.log.info("ttyd.started", pid=self.ttyd_process.pid)

    async def start_ttyd_proxy(self) -> None:
        """Start the JWT-authenticated reverse proxy in front of ttyd."""
        if not os.environ.get("TERMINAL_ENABLED"):
            return

        cmd = ["bun", "run", "/app/sandbox_runtime/ttyd_proxy/server.ts"]

        self.log.info(
            "ttyd_proxy.starting",
            port=_port_from_env(TTYD_PROXY_PORT_ENV_VAR, TTYD_PROXY_PORT),
        )

        self.ttyd_proxy_process = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
            env=os.environ.copy(),
            limit=_LOG_FORWARD_STREAM_LIMIT_BYTES,
        )

        asyncio.create_task(self._forward_ttyd_proxy_logs())
        self.log.info("ttyd_proxy.started", pid=self.ttyd_proxy_process.pid)

    async def _forward_ttyd_logs(self) -> None:
        """Forward ttyd stdout to supervisor stdout."""
        if not self.ttyd_process or not self.ttyd_process.stdout:
            return
        async for line in self._iter_process_lines(
            self.ttyd_process.stdout,
            error_event="ttyd.log_forward_error",
        ):
            self.log.info("ttyd.stdout", line=line)

    async def _forward_ttyd_proxy_logs(self) -> None:
        """Forward ttyd proxy stdout to supervisor stdout."""
        if not self.ttyd_proxy_process or not self.ttyd_proxy_process.stdout:
            return
        async for line in self._iter_process_lines(
            self.ttyd_proxy_process.stdout,
            error_event="ttyd_proxy.log_forward_error",
        ):
            self.log.info("ttyd_proxy.stdout", line=line)

    async def _wait_for_port(self, port: int, timeout_seconds: float | None = None) -> bool:
        timeout_seconds = timeout_seconds or self.SIDECAR_TIMEOUT_SECONDS
        """Wait for a service to start listening on a port. Returns True if ready."""
        loop = asyncio.get_running_loop()
        deadline = loop.time() + timeout_seconds
        while loop.time() < deadline:
            try:
                _, writer = await asyncio.open_connection("127.0.0.1", port)
                writer.close()
                await writer.wait_closed()
                return True
            except (ConnectionRefusedError, OSError):
                await asyncio.sleep(0.1)
        self.log.warn("port_readiness.timeout", port=port, timeout=timeout_seconds)
        return False

    async def start_opencode(self) -> None:
        """Start OpenCode server with configuration."""
        self._setup_openai_oauth()
        self.log.info("opencode.start")

        # Build OpenCode config from session settings
        provider = self.session_config.get("provider", "anthropic")
        model = self.session_config.get("model", "claude-sonnet-4-6")
        opencode_config: dict = {
            "model": f"{provider}/{model}",
            "permission": {"*": {"*": "allow"}},
        }

        # Inject MCP servers
        mcp_servers = self._resolve_mcp_servers()
        if mcp_servers:
            await self._install_mcp_packages(mcp_servers)
            mcp_config = self._build_mcp_config(mcp_servers)
            if mcp_config:
                opencode_config["mcp"] = mcp_config
                self.log.info("mcp.configured", count=len(mcp_config))

        # Working directory: the repo for single-repo sessions, /workspace
        # for multi-repo (every member visible) and repo-less sessions.
        workdir = self._opencode_workdir()

        self._prepare_opencode_filesystem(workdir)

        # Deploy codex auth proxy plugin if OpenAI OAuth is configured
        opencode_dir = workdir / ".opencode"
        plugin_source = Path("/app/sandbox_runtime/plugins/codex-auth-plugin.js")
        if plugin_source.exists() and os.environ.get("OPENAI_OAUTH_REFRESH_TOKEN"):
            plugin_dir = opencode_dir / "plugins"
            plugin_dir.mkdir(parents=True, exist_ok=True)
            shutil.copy(plugin_source, plugin_dir / "codex-auth-plugin.js")
            self.log.info("openai_oauth.plugin_deployed")

        env = {
            **os.environ,
            "OPENCODE_CONFIG_CONTENT": json.dumps(opencode_config),
            # Disable OpenCode's question tool in headless mode. The tool blocks
            # on a Promise waiting for user input via the HTTP API, but the bridge
            # has no channel to relay questions to the web client and back. Without
            # this, the session hangs until the SSE inactivity timeout (120s).
            # See: https://github.com/anomalyco/opencode/blob/19b1222cd/packages/opencode/src/tool/registry.ts#L100
            "OPENCODE_CLIENT": "serve",
        }

        # Start OpenCode server in the repo directory
        self.opencode_process = await asyncio.create_subprocess_exec(
            "opencode",
            "serve",
            "--port",
            str(self.OPENCODE_PORT),
            "--hostname",
            "0.0.0.0",
            "--print-logs",  # Print logs to stdout for debugging
            cwd=workdir,  # Start in repo directory
            env=env,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
            limit=_LOG_FORWARD_STREAM_LIMIT_BYTES,
        )

        # Start log forwarder
        asyncio.create_task(self._forward_opencode_logs())

        # Wait for health check
        await self._wait_for_health()
        self.opencode_ready.set()
        self.log.info("opencode.ready")

    async def _forward_opencode_logs(self) -> None:
        """Forward OpenCode stdout to supervisor stdout."""
        if not self.opencode_process or not self.opencode_process.stdout:
            return
        async for line in self._iter_process_lines(
            self.opencode_process.stdout,
            error_event="opencode.log_forward_error",
        ):
            print(f"[opencode] {line}")

    async def _wait_for_health(self) -> None:
        """Poll health endpoint until server is ready."""
        health_url = f"http://localhost:{self.OPENCODE_PORT}/global/health"
        start_time = time.time()

        async with httpx.AsyncClient() as client:
            while time.time() - start_time < self.HEALTH_CHECK_TIMEOUT:
                if self.shutdown_event.is_set():
                    raise RuntimeError("Shutdown requested during startup")

                try:
                    resp = await client.get(health_url, timeout=2.0)
                    if resp.status_code == 200:
                        return
                except httpx.ConnectError:
                    pass
                except Exception as e:
                    self.log.debug("opencode.health_check_error", exc=e)

                await asyncio.sleep(0.5)

        raise RuntimeError("OpenCode server failed to become healthy")

    async def start_bridge(self) -> None:
        """Start the agent bridge process."""
        self.log.info("bridge.start")

        if not self.control_plane_url:
            self.log.info("bridge.skip", reason="no_control_plane_url")
            return

        # Wait for OpenCode to be ready
        await self.opencode_ready.wait()

        # Get session_id from config (required for WebSocket connection)
        session_id = self.session_config.get("session_id", "")
        if not session_id:
            self.log.info("bridge.skip", reason="no_session_id")
            return

        # Run bridge as a module (works with relative imports)
        self.bridge_process = await asyncio.create_subprocess_exec(
            "python",
            "-m",
            "sandbox_runtime.bridge",
            "--sandbox-id",
            self.sandbox_id,
            "--session-id",
            session_id,
            "--control-plane",
            self.control_plane_url,
            "--token",
            self.sandbox_token,
            "--opencode-port",
            str(self.OPENCODE_PORT),
            env=os.environ,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
            limit=_LOG_FORWARD_STREAM_LIMIT_BYTES,
        )

        # Start log forwarder for bridge
        asyncio.create_task(self._forward_bridge_logs())
        self.log.info("bridge.started")

        # Check if bridge exited immediately during startup
        await asyncio.sleep(0.5)
        if self.bridge_process.returncode is not None:
            exit_code = self.bridge_process.returncode
            # Bridge exited immediately - read any error output
            stdout, _ = await self.bridge_process.communicate()
            if exit_code == 0:
                self.log.warn("bridge.early_exit", exit_code=exit_code)
            else:
                self.log.error(
                    "bridge.startup_crash",
                    exit_code=exit_code,
                    output=stdout.decode() if stdout else "",
                )

    async def _forward_bridge_logs(self) -> None:
        """Forward bridge stdout to supervisor stdout."""
        if not self.bridge_process or not self.bridge_process.stdout:
            return
        # Bridge already prefixes its output with [bridge], so forward verbatim.
        async for line in self._iter_process_lines(
            self.bridge_process.stdout,
            error_event="bridge.log_forward_error",
        ):
            print(line)

    async def monitor_processes(self) -> None:
        """Monitor child processes and restart on crash."""
        restart_count = 0
        bridge_restart_count = 0
        code_server_restart_count = 0
        ttyd_restart_count = 0
        ttyd_proxy_restart_count = 0

        while not self.shutdown_event.is_set():
            # Check OpenCode process
            if self.opencode_process and self.opencode_process.returncode is not None:
                exit_code = self.opencode_process.returncode
                restart_count += 1

                self.log.error(
                    "opencode.crash",
                    exit_code=exit_code,
                    restart_count=restart_count,
                )

                if restart_count > self.MAX_RESTARTS:
                    self.log.error(
                        "opencode.max_restarts",
                        restart_count=restart_count,
                    )
                    await self._report_fatal_error(
                        f"OpenCode crashed {restart_count} times, giving up"
                    )
                    self.shutdown_event.set()
                    break

                # Exponential backoff
                delay = min(self.BACKOFF_BASE**restart_count, self.BACKOFF_MAX)
                self.log.info(
                    "opencode.restart",
                    delay_s=round(delay, 1),
                    restart_count=restart_count,
                )

                await asyncio.sleep(delay)
                self.opencode_ready.clear()
                await self.start_opencode()

            # Check bridge process
            if self.bridge_process and self.bridge_process.returncode is not None:
                exit_code = self.bridge_process.returncode

                if exit_code == 0:
                    # Graceful exit: shutdown command, session terminated, or fatal
                    # connection error. Propagate shutdown rather than restarting.
                    self.log.info(
                        "bridge.graceful_exit",
                        exit_code=exit_code,
                    )
                    self.shutdown_event.set()
                    break
                else:
                    # Crash: restart with backoff and retry limit
                    bridge_restart_count += 1
                    self.log.error(
                        "bridge.crash",
                        exit_code=exit_code,
                        restart_count=bridge_restart_count,
                    )

                    if bridge_restart_count > self.MAX_RESTARTS:
                        self.log.error(
                            "bridge.max_restarts",
                            restart_count=bridge_restart_count,
                        )
                        await self._report_fatal_error(
                            f"Bridge crashed {bridge_restart_count} times, giving up"
                        )
                        self.shutdown_event.set()
                        break

                    delay = min(self.BACKOFF_BASE**bridge_restart_count, self.BACKOFF_MAX)
                    self.log.info(
                        "bridge.restart",
                        delay_s=round(delay, 1),
                        restart_count=bridge_restart_count,
                    )
                    await asyncio.sleep(delay)
                    await self.start_bridge()

            # Check code-server process (non-fatal, best-effort restart)
            if self.code_server_process and self.code_server_process.returncode is not None:
                code_server_restart_count += 1
                self.log.warn(
                    "code_server.crash",
                    exit_code=self.code_server_process.returncode,
                    restart_count=code_server_restart_count,
                )

                if code_server_restart_count <= self.MAX_RESTARTS:
                    delay = min(self.BACKOFF_BASE**code_server_restart_count, self.BACKOFF_MAX)
                    await asyncio.sleep(delay)
                    try:
                        await self.start_code_server()
                    except Exception as e:
                        self.log.warn("code_server.restart_failed", exc=e)
                        self.code_server_process = None
                else:
                    self.log.warn(
                        "code_server.max_restarts", restart_count=code_server_restart_count
                    )
                    self.code_server_process = None

            # Check ttyd process (non-fatal, best-effort restart)
            if self.ttyd_process and self.ttyd_process.returncode is not None:
                ttyd_restart_count += 1
                self.log.warn(
                    "ttyd.crash",
                    exit_code=self.ttyd_process.returncode,
                    restart_count=ttyd_restart_count,
                )

                if ttyd_restart_count <= self.MAX_RESTARTS:
                    delay = min(self.BACKOFF_BASE**ttyd_restart_count, self.BACKOFF_MAX)
                    await asyncio.sleep(delay)
                    try:
                        await self.start_ttyd()
                    except Exception as e:
                        self.log.warn("ttyd.restart_failed", exc=e)
                        self.ttyd_process = None
                else:
                    self.log.warn("ttyd.max_restarts", restart_count=ttyd_restart_count)
                    self.ttyd_process = None

            # Check ttyd proxy process (non-fatal, best-effort restart)
            if self.ttyd_proxy_process and self.ttyd_proxy_process.returncode is not None:
                ttyd_proxy_restart_count += 1
                self.log.warn(
                    "ttyd_proxy.crash",
                    exit_code=self.ttyd_proxy_process.returncode,
                    restart_count=ttyd_proxy_restart_count,
                )

                if ttyd_proxy_restart_count <= self.MAX_RESTARTS:
                    delay = min(self.BACKOFF_BASE**ttyd_proxy_restart_count, self.BACKOFF_MAX)
                    await asyncio.sleep(delay)
                    try:
                        await self.start_ttyd_proxy()
                    except Exception as e:
                        self.log.warn("ttyd_proxy.restart_failed", exc=e)
                        self.ttyd_proxy_process = None
                else:
                    self.log.warn("ttyd_proxy.max_restarts", restart_count=ttyd_proxy_restart_count)
                    self.ttyd_proxy_process = None

            await asyncio.sleep(1.0)

    async def _report_fatal_error(self, message: str) -> None:
        """Report a fatal error to the control plane."""
        self.log.error("supervisor.fatal", error_message=message)

        if not self.control_plane_url:
            return

        try:
            async with httpx.AsyncClient() as client:
                await client.post(
                    f"{self.control_plane_url}/sandbox/{self.sandbox_id}/error",
                    json={"error": message, "fatal": True},
                    headers={"Authorization": f"Bearer {self.sandbox_token}"},
                    timeout=5.0,
                )
        except Exception as e:
            self.log.error("supervisor.report_error_failed", exc=e)

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
            )

            try:
                stdout, _ = await asyncio.wait_for(process.communicate(), timeout=timeout_seconds)
            except TimeoutError:
                process.kill()
                stdout = await process.stdout.read() if process.stdout else b""
                await process.wait()
                output_tail = "\n".join(stdout.decode(errors="replace").splitlines()[-50:])
                duration_ms = int((time.time() - start_time) * 1000)
                self.log.error(
                    f"{hook_name}.timeout",
                    timeout_seconds=timeout_seconds,
                    output_tail=output_tail,
                    script=str(script_path),
                    duration_ms=duration_ms,
                    boot_mode=self.boot_mode,
                )
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

            self.log.error(
                f"{hook_name}.failed",
                exit_code=process.returncode,
                output_tail=output_tail,
                script=str(script_path),
                duration_ms=duration_ms,
                boot_mode=self.boot_mode,
            )
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

    async def run(self) -> None:
        """Main supervisor loop."""
        startup_start = time.time()

        self.log.info(
            "supervisor.start",
            repo_owner=self.repo_owner,
            repo_name=self.repo_name,
        )

        # Detect operating mode
        image_build_mode = os.environ.get("IMAGE_BUILD_MODE") == "true"
        restored_from_snapshot = os.environ.get("RESTORED_FROM_SNAPSHOT") == "true"
        from_repo_image = os.environ.get("FROM_REPO_IMAGE") == "true"

        if image_build_mode:
            self.boot_mode = "build"
        elif restored_from_snapshot:
            self.boot_mode = "snapshot_restore"
        elif from_repo_image:
            self.boot_mode = "repo_image"
        else:
            self.boot_mode = "fresh"

        # Expose boot mode to repo hooks and child processes.
        os.environ["OPENINSPECT_BOOT_MODE"] = self.boot_mode

        if not self.has_repository:
            self.log.info("supervisor.no_repo_configured")
        elif image_build_mode:
            self.log.info("supervisor.image_build_mode")
        elif restored_from_snapshot:
            self.log.info("supervisor.restored_from_snapshot")
        elif from_repo_image:
            repo_image_sha = os.environ.get("REPO_IMAGE_SHA", "unknown")
            self.log.info("supervisor.from_repo_image", build_sha=repo_image_sha)
        repo_image_callback = (
            RepoImageBuildCallback.from_env(self.log) if image_build_mode else None
        )

        # Clear stale tunnel file on every restore: a snapshot taken with
        # tunnels configured retains the previous session's URLs even if this
        # session has no tunnel ports.
        expected_tunnel_ports = self._expected_tunnel_ports()
        if restored_from_snapshot or expected_tunnel_ports:
            self._clear_stale_tunnel_env_file()

        # Boot warnings are per-boot; a snapshot can carry the previous
        # boot's file, so always start clean.
        Path(BOOT_WARNINGS_FILE_PATH).unlink(missing_ok=True)

        # Set up signal handlers
        loop = asyncio.get_event_loop()
        for sig in (signal.SIGTERM, signal.SIGINT):
            loop.add_signal_handler(sig, lambda s=sig: asyncio.create_task(self._handle_signal(s)))

        git_sync_success = False
        head_sha = ""
        repository_shas: list[dict[str, str]] = []
        opencode_ready = False
        try:
            # Refuse to boot on an untrusted repository config — unsafe or
            # duplicate names would let checkout paths escape /workspace or
            # collide. Raised here (not __init__) so the failure reaches the
            # control plane through the normal fatal-error path.
            if self.repo_config_error:
                raise RuntimeError(f"invalid repository config: {self.repo_config_error}")

            self._write_repo_manifest()

            # Phase 0: Make sure the git credential helper is configured
            # before any git operation. New images do this in /etc/gitconfig,
            # but snapshots/repo-images built before this migration won't.
            if self.repositories:
                await self._ensure_credential_helper_configured()

            # Phase 1: Git sync — one per-repo rule for every boot mode
            # (existing checkout → fetch/checkout, missing → clone). Only the
            # failure policy differs: fresh and build boots cannot do useful
            # work without every repository, so any failure is fatal
            # (deliberate change — previously a fresh boot limped on
            # repo-less); image/snapshot boots keep their leniency (a deleted
            # upstream branch must not brick a resume).
            failed_repos = await self.sync_repositories()
            git_sync_success = not failed_repos
            if failed_repos:
                if self.boot_mode in ("fresh", "build"):
                    failed_names = ", ".join(f"{r.owner}/{r.name}" for r in failed_repos)
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
            if image_build_mode and git_sync_success and self.repositories:
                # repository_shas is the cross-language provenance document
                # ([{repoOwner, repoName, baseSha}]): parsed from this event by
                # the Modal build orchestrator, echoed through the
                # build-complete callback, stored in environment_images, and
                # compared against `git ls-remote` by the rebuild cron. The
                # scalar head_sha stays for the single-repo repo-image path.
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
                        "git.sync_complete", head_sha=head_sha, repository_shas=repository_shas
                    )
            self.git_sync_complete.set()

            # Phase 2: Setup hooks, members in position order, only for fresh
            # or build boots (prebuilt/snapshot boots ran them at build time).
            # Build boots fail on the first failing member; fresh boots warn
            # and continue.
            setup_success: bool | None = None
            if self.repositories and self.boot_mode in ("fresh", "build"):
                setup_success = True
                for repo in self.repositories:
                    if await self.run_setup_script(repo):
                        continue
                    setup_success = False
                    if image_build_mode:
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

            # Phase 3: Start hooks for all non-build boots, members in
            # position order. The primary stays fatal (a broken primary dev
            # server is a broken session); secondary failures warn and
            # continue. Wait for tunnel URLs first so dev servers booted by
            # start.sh see fresh data.
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

            # Multi-repo workspaces get a generated manifest at /workspace/
            # AGENTS.md (regenerated every boot; no-op for single-repo).
            self._write_workspace_manifest()

            # Image build mode: signal completion then keep sandbox alive for
            # snapshot_filesystem(). MCP packages are not pre-installed during
            # builds — they are installed at first use via npx at session start.
            if image_build_mode:
                duration_ms = int((time.time() - startup_start) * 1000)
                # runtime_version is reported by the build itself (design
                # §7.3): the baked image's SANDBOX_VERSION is the ground
                # truth, so orchestrators never guess it from their own code.
                runtime_version = os.environ.get("SANDBOX_VERSION", "")
                self.log.info(
                    "image_build.complete",
                    duration_ms=duration_ms,
                    runtime_version=runtime_version,
                )
                if repo_image_callback:
                    reported = await repo_image_callback.report_success(
                        base_sha=head_sha,
                        build_duration_seconds=time.time() - startup_start,
                        repository_shas=repository_shas,
                        runtime_version=runtime_version,
                    )
                    if not reported:
                        raise RuntimeError("repo image build-complete callback failed")
                await self.shutdown_event.wait()
                return

            # Phase 3.5: Start optional sidecars (best-effort, non-fatal)
            for sidecar_name, starter in (
                ("code_server", self.start_code_server),
                ("ttyd", self.start_ttyd),
            ):
                try:
                    await starter()
                except Exception as e:
                    self.log.warn(f"{sidecar_name}.start_failed", exc=e)

            if self.ttyd_process is not None:
                ttyd_ready = await self._wait_for_port(
                    TTYD_PORT,
                    timeout_seconds=self.SIDECAR_TIMEOUT_SECONDS,
                )
                if ttyd_ready:
                    try:
                        await self.start_ttyd_proxy()
                    except Exception as e:
                        self.log.warn("ttyd_proxy.start_failed", exc=e)

            # Phase 4: Start OpenCode server (in repo directory)
            await self.start_opencode()
            opencode_ready = True

            # Phase 5: Start bridge (after OpenCode is ready)
            await self.start_bridge()

            # Emit sandbox.startup wide event
            duration_ms = int((time.time() - startup_start) * 1000)
            self.log.info(
                "sandbox.startup",
                repo_owner=self.repo_owner,
                repo_name=self.repo_name,
                boot_mode=self.boot_mode,
                restored_from_snapshot=restored_from_snapshot,
                from_repo_image=from_repo_image,
                git_sync_success=git_sync_success,
                setup_success=setup_success,
                start_success=start_success,
                opencode_ready=opencode_ready,
                duration_ms=duration_ms,
                outcome="success",
            )

            # Phase 6: Monitor processes
            await self.monitor_processes()

        except Exception as e:
            self.log.error("supervisor.error", exc=e)
            if image_build_mode and repo_image_callback:
                await repo_image_callback.report_failure(str(e))
            await self._report_fatal_error(str(e))

        finally:
            await self.shutdown()

    async def _handle_signal(self, sig: signal.Signals) -> None:
        """Handle shutdown signal."""
        self.log.info("supervisor.signal", signal_name=sig.name)
        self.shutdown_event.set()

    async def shutdown(self) -> None:
        """Graceful shutdown of all processes."""
        self.log.info("supervisor.shutdown_start")

        # Terminate bridge first
        if self.bridge_process and self.bridge_process.returncode is None:
            self.bridge_process.terminate()
            try:
                await asyncio.wait_for(self.bridge_process.wait(), timeout=5.0)
            except TimeoutError:
                self.bridge_process.kill()

        # Terminate code-server
        if self.code_server_process and self.code_server_process.returncode is None:
            self.code_server_process.terminate()
            try:
                await asyncio.wait_for(self.code_server_process.wait(), timeout=5.0)
            except TimeoutError:
                self.code_server_process.kill()

        # Terminate ttyd proxy first (it depends on ttyd)
        if self.ttyd_proxy_process and self.ttyd_proxy_process.returncode is None:
            self.log.info("ttyd_proxy.terminating")
            self.ttyd_proxy_process.terminate()
            try:
                await asyncio.wait_for(
                    self.ttyd_proxy_process.wait(), timeout=self.SIDECAR_TIMEOUT_SECONDS
                )
            except TimeoutError:
                self.ttyd_proxy_process.kill()

        # Terminate ttyd
        if self.ttyd_process and self.ttyd_process.returncode is None:
            self.log.info("ttyd.terminating")
            self.ttyd_process.terminate()
            try:
                await asyncio.wait_for(
                    self.ttyd_process.wait(), timeout=self.SIDECAR_TIMEOUT_SECONDS
                )
            except TimeoutError:
                self.ttyd_process.kill()

        # Terminate OpenCode
        if self.opencode_process and self.opencode_process.returncode is None:
            self.opencode_process.terminate()
            try:
                await asyncio.wait_for(self.opencode_process.wait(), timeout=10.0)
            except TimeoutError:
                self.opencode_process.kill()

        self.log.info("supervisor.shutdown_complete")


async def main():
    """Entry point for the sandbox supervisor."""
    supervisor = SandboxSupervisor()
    await supervisor.run()


if __name__ == "__main__":
    asyncio.run(main())
