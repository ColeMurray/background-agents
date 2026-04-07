# Open-Inspect Daytona Infrastructure

Thin Daytona shim service for Open-Inspect.

The control plane talks to Daytona through this HTTP service because the published TypeScript SDK
does not bundle cleanly for the Cloudflare Worker target used by `packages/control-plane`.

## What it does

- Creates Open-Inspect sandboxes from a named Daytona base snapshot
- Resumes stopped sandboxes with the same logical sandbox ID and auth token
- Stops sandboxes explicitly on inactivity or stale heartbeat
- Generates signed preview URLs for code-server and extra tunnel ports
- Seeds the Daytona base snapshot from the repo-local sandbox runtime

## Environment

- `DAYTONA_API_KEY`
- `DAYTONA_API_URL`
- `DAYTONA_TARGET`
- `DAYTONA_SERVICE_SECRET`
- `DAYTONA_BASE_SNAPSHOT`
- `DAYTONA_AUTO_STOP_INTERVAL_MINUTES`
- `ALLOWED_CONTROL_PLANE_HOSTS`
- `SCM_PROVIDER`
- `GITHUB_APP_ID`
- `GITHUB_APP_PRIVATE_KEY`
- `GITHUB_APP_INSTALLATION_ID`
- `GITLAB_ACCESS_TOKEN`
- `OPEN_INSPECT_REPO_ROOT`

## Local usage

```bash
cd packages/daytona-infra
uv sync --extra dev
uv run python -m src.bootstrap --force
uv run uvicorn src.app:app --host 0.0.0.0 --port 8788
```

The bootstrap command rebuilds the named Daytona base snapshot from the current repo contents.
Re-run it whenever `packages/sandbox-runtime` or the sandbox toolchain changes.
