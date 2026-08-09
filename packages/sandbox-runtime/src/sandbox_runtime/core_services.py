from __future__ import annotations

import asyncio
import filecmp
import json
import os
import re
import shutil
import time
from pathlib import Path
from typing import TYPE_CHECKING, Any

import httpx

from .constants import (
    BIN_INSTALL_DIR_ENV_VAR,
    DEFAULT_BIN_INSTALL_DIR,
)
from .git_excludes import install_runtime_git_excludes

if TYPE_CHECKING:
    from collections.abc import AsyncIterator, Callable

    from .repo_config import RepoEntry
    from .runtime_config import RuntimeConfig

_LOG_FORWARD_STREAM_LIMIT_BYTES = 1024 * 1024
_TRUNCATED_LINE_NOTICE = "[log line too large to forward; truncated]"
AGENT_TOOLS_GATED_ON_ENV = {"slack-notify.js": "AGENT_SLACK_NOTIFY_ENABLED"}
AGENT_TOOLS_REQUIRING_REPOSITORY: set[str] = set()


class CoreAgentServices:
    OPENCODE_PORT = 4096
    HEALTH_CHECK_TIMEOUT = 30.0
    MCP_PACKAGE_INSTALL_TIMEOUT_SECONDS = 180
    _NPM_PKG_RE = re.compile(r"^(@[\w.-]+/)?[\w][\w.-]*(@[\w.-]+)?$")

    def __init__(
        self,
        config: RuntimeConfig,
        shutdown_event: asyncio.Event,
        log: Any,
        record_boot_warning: Callable[..., None],
    ) -> None:
        self.config = config
        self.shutdown_event = shutdown_event
        self.log = log
        self.record_boot_warning = record_boot_warning
        self.sandbox_id = config.sandbox_id
        self.control_plane_url = config.control_plane_url
        self.sandbox_token = config.sandbox_token
        self.session_config = config.session_config
        self.has_repository = config.has_repository
        self.workspace_path = config.workspace_path
        self.repo_path = config.repo_path
        self.repositories: list[RepoEntry] = []
        self.is_multi_repo = False
        self.workdir = config.workspace_path
        self.opencode_process: asyncio.subprocess.Process | None = None
        self.bridge_process: asyncio.subprocess.Process | None = None

    def configure_workspace(self, repositories: tuple[RepoEntry, ...], workdir: Path) -> None:
        self.repositories = list(repositories)
        self.is_multi_repo = len(repositories) > 1
        self.workdir = workdir

    def _opencode_workdir(self) -> Path:
        return self.workdir

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
                    self.record_boot_warning(
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

    def _install_tools(self, workdir: Path) -> set[str]:
        """Copy custom tools into the .opencode/tool directory for OpenCode to discover."""
        installed: set[str] = set()
        opencode_dir = workdir / ".opencode"
        tool_dest = opencode_dir / "tool"

        # Legacy tool (inspect-plugin.js → create-pull-request.js)
        legacy_tool = Path("/app/sandbox_runtime/plugins/inspect-plugin.js")
        # New tools directory
        tools_dir = Path("/app/sandbox_runtime/tools")

        has_tools = legacy_tool.exists() or tools_dir.exists()
        if not has_tools:
            return installed

        tool_dest.mkdir(parents=True, exist_ok=True)

        if legacy_tool.exists() and self.has_repository:
            shutil.copy(legacy_tool, tool_dest / "create-pull-request.js")
            installed.add(".opencode/tool/create-pull-request.js")

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
                installed.add(f".opencode/tool/{tool_file.name}")

        # Copy pre-built deps (package.json, package-lock.json, node_modules) from the image
        # staging directory so OpenCode's Npm.install() finds the tree in sync and skips the
        # arborist reify() that would otherwise block the first request.
        staged_at = time.monotonic()
        installed.update(
            f".opencode/{path}"
            for path in self._stage_opencode_deps(Path("/app/opencode-deps"), opencode_dir)
        )
        self.log.info(
            "opencode.repo_deps_staged",
            dir=str(opencode_dir),
            duration_ms=round((time.monotonic() - staged_at) * 1000),
        )
        return installed

    @staticmethod
    def _stage_opencode_deps(deps_cache: Path, dest_dir: Path) -> set[str]:
        """Copy the pre-staged OpenCode plugin deps into dest_dir.

        Copies package.json, package-lock.json and node_modules from the image staging
        directory (base.py's /app/opencode-deps) into dest_dir, per file and only when the
        destination is absent. This gives OpenCode a lockfile that matches node_modules so
        Npm.install() finds @opencode-ai/plugin in sync and skips the arborist reify() that
        would otherwise block the first request.
        """
        installed: set[str] = set()
        for name in ("package.json", "package-lock.json"):
            src = deps_cache / name
            dest = dest_dir / name
            if src.exists() and not dest.exists():
                shutil.copy2(src, dest)
                installed.add(name)
            elif src.is_file() and dest.is_file() and filecmp.cmp(src, dest, shallow=False):
                installed.add(name)
        cached_modules = deps_cache / "node_modules"
        local_modules = dest_dir / "node_modules"
        copied_modules = False
        if cached_modules.is_dir() and not local_modules.exists():
            shutil.copytree(cached_modules, local_modules, symlinks=True)
            copied_modules = True
        if copied_modules:
            installed.add("node_modules/")
        return installed

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

    def _prepare_opencode_filesystem(self, workdir: Path) -> set[str]:
        """Stage OpenCode's filesystem assets (tools, deps, skills, bin) before launch.

        The global seed is best-effort (degrades to a slower reify); the rest fail fast.
        """
        installed: set[str] = set()
        self._assemble_workspace_opencode()
        installed.update(self._install_tools(workdir))
        try:
            self._seed_global_opencode_deps()
        except Exception as e:
            self.log.warn("opencode.global_deps_seed_failed", exc=e)
        installed.update(self._install_skills(workdir))
        self._install_bin_scripts()
        return installed

    def _install_bin_scripts(self) -> None:
        """Install standalone CLI scripts into the sandbox bin directory.

        Scripts in bin/ are standalone CLIs (not OpenCode tool plugins) and must
        NOT be placed in .opencode/tool/ — OpenCode would import() them during
        tool discovery, executing module-level code with the parent process argv.
        """
        bin_dir = Path("/app/sandbox_runtime/bin")
        if not bin_dir.is_dir():
            return

        install_dir = Path(os.environ.get(BIN_INSTALL_DIR_ENV_VAR, DEFAULT_BIN_INSTALL_DIR))
        install_dir.mkdir(parents=True, exist_ok=True)
        for script in bin_dir.iterdir():
            if not script.is_file() or script.suffix not in {"", ".js"}:
                continue
            command_name = script.stem if script.suffix == ".js" else script.name
            dest = install_dir / command_name
            shutil.copy(script, dest)
            dest.chmod(0o755)
            self.log.info("bin.installed", script=command_name)

    def _install_skills(self, workdir: Path) -> set[str]:
        """Copy bundled Skills into the .opencode/skills directory."""
        installed: set[str] = set()
        skills_dir = Path("/app/sandbox_runtime/skills")
        if not skills_dir.is_dir():
            return installed

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
            for source in skill_dir.rglob("*"):
                relative = source.relative_to(skill_dir)
                if any(part == "__pycache__" for part in relative.parts):
                    continue
                if source.name == ".DS_Store" or source.suffix == ".pyc":
                    continue
                if source.is_file() or source.is_symlink():
                    installed.add((Path(".opencode/skills") / skill_dir.name / relative).as_posix())
            installed_any = True

        if installed_any:
            self.log.info("opencode.skills_installed", skills_path=str(skills_dest))
        return installed

    def _setup_managed_oauth(self) -> None:
        """Write OpenCode OAuth sentinels for control-plane-managed providers."""
        openai_managed = os.environ.get("OPENAI_OAUTH_MANAGED")
        xai_managed = os.environ.get("XAI_OAUTH_MANAGED")
        if not openai_managed and not xai_managed:
            return

        try:
            auth_dir = Path.home() / ".local" / "share" / "opencode"
            auth_dir.mkdir(parents=True, exist_ok=True)

            oauth_entry = {
                "type": "oauth",
                "refresh": "managed-by-control-plane",
                "access": "",
                "expires": 0,
            }
            entries = {}
            if openai_managed:
                entries["openai"] = {**oauth_entry}
            if xai_managed:
                entries["xai"] = {**oauth_entry}

            auth_file = auth_dir / "auth.json"
            tmp_file = auth_dir / ".auth.json.tmp"

            existing_entries = {}
            if auth_file.exists():
                try:
                    existing = json.loads(auth_file.read_text())
                    if isinstance(existing, dict):
                        existing_entries = existing
                except (OSError, json.JSONDecodeError):
                    self.log.warn("managed_oauth.existing_auth_invalid")
            existing_entries = {
                key: value
                for key, value in existing_entries.items()
                if not (
                    isinstance(value, dict)
                    and value.get("refresh") == "managed-by-control-plane"
                    and key not in entries
                )
            }
            entries = {**existing_entries, **entries}

            # Write to a temp file created with 0o600 from the start, then
            # atomically rename so the target is never world-readable.
            fd = os.open(str(tmp_file), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            try:
                os.write(fd, json.dumps(entries).encode())
            finally:
                os.close(fd)
            tmp_file.replace(auth_file)

            self.log.info("managed_oauth.setup", providers=list(entries))
        except Exception as e:
            self.log.warn("managed_oauth.setup_error", exc=e)

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

    def _resolve_mcp_servers(self) -> list[dict[str, Any]]:
        """Resolve MCP servers from session config."""
        return self.session_config.get("mcp_servers") or []

    async def _install_mcp_packages(self, servers: list[dict[str, Any]]) -> None:
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

    def _build_mcp_config(self, servers: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
        """Convert MCP server list to OpenCode mcp config format."""
        config: dict[str, dict[str, Any]] = {}
        for server in servers:
            name = server.get("name", "")
            if not name:
                continue
            if server.get("type") == "remote":
                entry: dict[str, Any] = {"type": "remote", "url": server.get("url", "")}
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

    async def start_opencode(self) -> None:
        """Start OpenCode server with configuration."""
        self._setup_managed_oauth()
        self.log.info("opencode.start")

        # Build OpenCode config from session settings
        provider = self.session_config.get("provider", "anthropic")
        model = self.session_config.get("model", "claude-sonnet-4-6")
        opencode_config: dict[str, Any] = {
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

        installed_runtime_paths = self._prepare_opencode_filesystem(workdir)

        # Deploy auth proxy plugins for control-plane-managed subscriptions.
        opencode_dir = workdir / ".opencode"
        managed_plugins = (
            ("OPENAI_OAUTH_MANAGED", "codex-auth-plugin.js", "openai_oauth.plugin_deployed"),
            ("XAI_OAUTH_MANAGED", "xai-auth-plugin.js", "xai_oauth.plugin_deployed"),
        )
        for marker, filename, log_event in managed_plugins:
            plugin_source = Path(f"/app/sandbox_runtime/plugins/{filename}")
            if not plugin_source.exists() or not os.environ.get(marker):
                continue
            plugin_dir = opencode_dir / "plugins"
            plugin_dir.mkdir(parents=True, exist_ok=True)
            shutil.copy(plugin_source, plugin_dir / filename)
            installed_runtime_paths.add(f".opencode/plugins/{filename}")
            self.log.info(log_event)

        if installed_runtime_paths and (workdir / ".git").exists():
            try:
                install_runtime_git_excludes(workdir, installed_runtime_paths)
            except Exception as error:
                self.log.warn("opencode.git_excludes_failed", exc=error)

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

    async def stop_bridge(self) -> None:
        if self.bridge_process and self.bridge_process.returncode is None:
            self.bridge_process.terminate()
            try:
                await asyncio.wait_for(self.bridge_process.wait(), timeout=5.0)
            except TimeoutError:
                self.bridge_process.kill()

    async def stop_opencode(self) -> None:
        if self.opencode_process and self.opencode_process.returncode is None:
            self.opencode_process.terminate()
            try:
                await asyncio.wait_for(self.opencode_process.wait(), timeout=10.0)
            except TimeoutError:
                self.opencode_process.kill()
