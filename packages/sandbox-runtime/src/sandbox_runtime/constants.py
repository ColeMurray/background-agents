"""Shared constants for sandbox modules."""

# Provider-selected directory for standalone runtime commands. OpenComputer uses
# the sandbox user's bin directory; providers with writable images use /usr/local/bin.
BIN_INSTALL_DIR_ENV_VAR = "OPENINSPECT_BIN_INSTALL_DIR"
DEFAULT_BIN_INSTALL_DIR = "/usr/local/bin"

# Default service ports. The control plane may override the externally-exposed
# ones per session via the *_ENV_VAR env vars below; the entrypoint and ttyd
# proxy fall back to these defaults. TTYD_PORT is localhost-only and fixed — it
# is never exposed and has no env override (7681 is reserved so nothing collides).
CODE_SERVER_PORT = 8080
TTYD_PORT = 7681
TTYD_PROXY_PORT = 7680

# Env vars carrying per-session port overrides for the in-sandbox runtime, set by
# the control plane when the respective feature is enabled.
CODE_SERVER_PORT_ENV_VAR = "CODE_SERVER_PORT"
TTYD_PROXY_PORT_ENV_VAR = "TTYD_PROXY_PORT"

# Dotenv file containing `TUNNEL_<port>=<url>` per line, consumed by local
# services via `--env-file` or direct read.
TUNNEL_ENV_FILE_PATH = "/workspace/.tunnels.env"

# First line of the tunnel env file: names the sandbox the URLs were resolved
# for. The manager's write can land before the entrypoint starts (it only
# needs the container agent, not the supervisor), so the entrypoint's stale
# cleanup keeps a file whose value matches its own SANDBOX_ID and clears
# everything else (snapshot/image leftovers with dead URLs). Mirrored as a
# string literal in the Vercel provider (control-plane).
TUNNEL_ENV_SANDBOX_ID_KEY = "TUNNEL_SANDBOX_ID"

# Comma-separated tunnel ports the manager will resolve. Read by the entrypoint
# to gate stale-file cleanup and the wait-for-fresh-URLs before start.sh.
EXPECTED_TUNNEL_PORTS_ENV_VAR = "EXPECTED_TUNNEL_PORTS"

# Boot warnings queued by the supervisor (which has no control-plane event
# channel) and drained by the bridge as `warning` sandbox events after its
# WebSocket handshake. JSONL: one {scope, message, repoOwner?, repoName?} per line.
BOOT_WARNINGS_FILE_PATH = "/tmp/oi-boot-warnings.jsonl"

# Canonical repository manifest written by the supervisor before any child
# process starts, rewritten on every boot. Consumed by the bridge (push
# targeting) and the JS create-pull-request tool so the /workspace checkout
# layout has a single authority. JSON: {"repositories": [{owner, name, branch,
# path}]}. Mirrored as a string literal in plugins/inspect-plugin.js.
REPO_MANIFEST_FILE_PATH = "/tmp/oi-repo-manifest.json"
