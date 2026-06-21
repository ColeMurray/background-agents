"""Shared constants for sandbox modules."""

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

# Comma-separated tunnel ports the manager will resolve. Read by the entrypoint
# to gate stale-file cleanup and the wait-for-fresh-URLs before start.sh.
EXPECTED_TUNNEL_PORTS_ENV_VAR = "EXPECTED_TUNNEL_PORTS"
