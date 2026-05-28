"""Shared constants for sandbox modules."""

CODE_SERVER_PORT = 8080
TTYD_PORT = 7681
TTYD_PROXY_PORT = 7680

# Dotenv file containing `TUNNEL_<port>=<url>` per line, consumed by local
# services via `--env-file` or direct read.
TUNNEL_ENV_FILE_PATH = "/workspace/.tunnels.env"

# Comma-separated tunnel ports the manager will resolve. Read by the entrypoint
# to gate stale-file cleanup and the wait-for-fresh-URLs before start.sh.
EXPECTED_TUNNEL_PORTS_ENV_VAR = "EXPECTED_TUNNEL_PORTS"
