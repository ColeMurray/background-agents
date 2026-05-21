"""Shared constants for sandbox modules."""

CODE_SERVER_PORT = 8080
TTYD_PORT = 7681
TTYD_PROXY_PORT = 7680

# Path inside the sandbox where extra tunnel URLs are exposed in dotenv format.
# Local services consume via `--env-file=.tunnels.env` (Node, Bun, Vite, docker
# compose) or read directly. Format is `TUNNEL_<port>=<url>` per line.
TUNNEL_ENV_FILE_PATH = "/workspace/.tunnels.env"

# Env var carrying the comma-separated list of tunnel ports the manager will
# resolve and write into TUNNEL_ENV_FILE_PATH. Used by the entrypoint to (a)
# clear any stale file at boot and (b) wait for fresh URLs before running
# repo start hooks that may depend on them.
EXPECTED_TUNNEL_PORTS_ENV_VAR = "EXPECTED_TUNNEL_PORTS"
