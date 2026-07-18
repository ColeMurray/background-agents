# Open-Inspect E2B Template Tooling

Builds the E2B sandbox **template** that Open-Inspect E2B sandboxes are created from.

The control plane talks to the E2B REST API directly at runtime — these files are only for building
the template image, not runtime operations.

## What's here

- **`e2b.Dockerfile`** — the template image: the pinned sandbox toolchain (Python 3.12, Node 22,
  `opencode-ai`, `code-server`, `agent-browser`, bun) plus `packages/sandbox-runtime` copied to
  `/app/sandbox_runtime`. **Toolchain versions are pinned — keep them in sync with the other sandbox
  providers when bumping.**
- **`oi-launch.py`** — the template **start command**. E2B runs the start command once at build,
  snapshots it, and resumes it per create — so it cannot receive per-session env. This launcher
  waits for the control plane to drop `/tmp/oi-session.env` (via envd), loads it, and `exec`s the
  supervisor (`python -m sandbox_runtime.entrypoint`) with that env +
  `HOME=/home/user`/`PYTHONPATH`/`NODE_PATH`.
- **`build-template.py`** — stages `sandbox_runtime`, then builds the template programmatically via
  the **E2B Template SDK** (`Template().from_dockerfile(...).copy(...).set_start_cmd(...)`),
  authenticated with the runtime API key. Used both for manual builds and by the Terraform module.

## Auth: one credential

- **`E2B_API_KEY`** — the runtime key the control-plane worker uses for the E2B REST API (and
  code-server password HMAC), **and** what the Template SDK uses to authenticate the build. Get it
  from the [E2B dashboard](https://e2b.dev) → API Keys.

## Manual build

```bash
cd packages/e2b-infra
uv sync --frozen
export E2B_API_KEY=e2b_…            # from the E2B dashboard → API Keys
export E2B_TEMPLATE_ID=open-inspect-sandbox
uv run python build-template.py
```

Optional: `E2B_TEMPLATE_CPU` (default 2), `E2B_TEMPLATE_MEM` (default 1024).

Rebuild whenever `packages/sandbox-runtime` or this directory changes.

> Builds are automated via Terraform when `sandbox_provider = "e2b"`. The
> `terraform/modules/e2b-infra` module hashes `packages/e2b-infra` + `packages/sandbox-runtime/src`
> and rebuilds the template on `terraform apply` when either changes. Manual runs are only for
> initial setup or debugging.
>
> E2B runs sandboxes as non-root `user` (HOME=`/home/user`) via a login shell and does not propagate
> Docker `ENV` — the Dockerfile and launcher account for this.

## Verification

E2B provider and REST client behavior is covered by the control-plane unit suite. The template
tooling has no dedicated live integration suite, and the bridge ↔ control-plane WebSocket path can
only be exercised against a running control plane and E2B account.

Prerequisites: `packages/control-plane/.dev.vars` with `SANDBOX_PROVIDER=e2b`, `E2B_API_KEY`,
`E2B_TEMPLATE_ID`, and GitHub App credentials (`GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY` in PKCS#8,
`GITHUB_APP_INSTALLATION_ID`); the template built (`uv run python build-template.py`); a test repo
the App can clone.

1. Expose a public control-plane URL the sandbox bridge can reach: `wrangler dev --remote`, or
   `wrangler dev` + `cloudflared tunnel --url http://localhost:8787`.
2. Set `CONTROL_PLANE_URL` to that public URL.
3. Start a session against the test repo.

| Criterion                   | Test method                                                                     |
| --------------------------- | ------------------------------------------------------------------------------- |
| Fresh session works         | Bridge connects; agent responds to a prompt                                     |
| Pause → resume works        | Agent responds to a new prompt after resume; files from before the pause remain |
| Idle pauses (not kills)     | Idle timeout triggers `POST /sandboxes/{id}/pause`; session is resumable        |
| TTL lapse recovers          | Past the TTL the sandbox auto-pauses (not killed); the next prompt resumes it   |
| code-server survives resume | Same URL and password work after resume                                         |
| Stop pauses (resumable)     | Idle/heartbeat stop pauses; only a never-connected sandbox is killed (`DELETE`) |
