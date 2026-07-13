# Open-Inspect E2B Template Tooling

Builds the E2B sandbox **template** that Open-Inspect E2B sandboxes are created from.

The control plane talks to the E2B REST API directly at runtime — these files are for building the
template image, analogous to `packages/daytona-infra` for Daytona.

## What's here

- **`e2b.Dockerfile`** — the template image. Mirrors the pinned toolchain in
  `packages/daytona-infra/src/toolchain.py` (Python 3.12, Node 22, `opencode-ai`, `code-server`,
  `agent-browser`, bun) and copies `packages/sandbox-runtime` to `/app/sandbox_runtime`. **Keep the
  versions in sync with `toolchain.py`.**
- **`oi-launch.py`** — the template **start command**. E2B runs the start command once at build,
  snapshots it, and resumes it per create — so it cannot receive per-session env. This launcher
  waits for the control plane to drop `/tmp/oi-session.env` (via envd), loads it, and `exec`s the
  supervisor (`python -m sandbox_runtime.entrypoint`) with that env +
  `HOME=/home/user`/`PYTHONPATH`/`NODE_PATH`. See `docs/SANDBOX_PROVIDER_MODELS.md` for why.
- **`build-template.py`** — stages `sandbox_runtime`, then builds the template programmatically via
  the **E2B Template SDK** (`Template().fromDockerfile(...).copy(...).setStartCmd(...)`),
  authenticated with the runtime API key. Used both for manual builds and by the Terraform module.

## Auth: one credential

- **`E2B_API_KEY`** — the runtime key the control-plane worker uses for the E2B REST API (and
  code-server password HMAC), **and** what the Template SDK uses to authenticate the build. Get it
  from the [E2B dashboard](https://e2b.dev) → API Keys. (The old CLI access-token flow is gone —
  E2B's guidance is to use the API key.)

## Manual build

```bash
cd packages/e2b-infra
npm install                         # installs the e2b SDK (workspace dep)
export E2B_API_KEY=e2b_…            # from the E2B dashboard → API Keys
export E2B_TEMPLATE_ID=open-inspect-sandbox
node build-template.py
```

Optional: `E2B_TEMPLATE_CPU` (default 2), `E2B_TEMPLATE_MEM` (default 1024).

Rebuild whenever `packages/sandbox-runtime` or this directory changes.

> Builds are automated via Terraform when `sandbox_provider = "e2b"`. The
> `terraform/modules/e2b-infra` module hashes `packages/e2b-infra` + `packages/sandbox-runtime/src`
> and rebuilds the template on `terraform apply` when either changes. Manual runs are only for
> initial setup or debugging.

## Notes

- The template build runs remotely on E2B (amd64), so local architecture is irrelevant.
- E2B runs sandboxes as non-root `user` (HOME=`/home/user`) via a login shell and does not propagate
  Docker `ENV` — the Dockerfile and launcher account for this. See the gotchas in
  `docs/SANDBOX_PROVIDER_MODELS.md`.

## Local end-to-end test (runbook)

Unit/integration tests and the template boot are verified, but the **bridge ↔ control-plane
WebSocket** can only be exercised against a running control plane. This needs interactive auth, so
it's a manual run.

**Prerequisites**

- `packages/control-plane/.dev.vars` with `E2B_API_KEY` (already set), plus `SANDBOX_PROVIDER=e2b`,
  `E2B_TEMPLATE_ID=open-inspect-sandbox`, and GitHub App creds (`GITHUB_APP_ID`,
  `GITHUB_APP_PRIVATE_KEY` in PKCS#8, `GITHUB_APP_INSTALLATION_ID`).
- The template built (`node build-template.py`) — already done as `open-inspect-sandbox`.
- A test GitHub repo the App can clone.

**Run**

1. Expose a public control-plane URL the sandbox bridge can reach:
   - `wrangler dev --remote` (runs on the CF edge with a public URL), or
   - `wrangler dev` (local) + `cloudflared tunnel --url http://localhost:8787`.
2. Set `CONTROL_PLANE_URL` (in `.dev.vars` / the create config) to that public URL.
3. Start a session against the test repo and watch control-plane logs for the bridge connecting.

**Smoke checklist** (the parts only a live run proves)

- [ ] Fresh session: bridge connects, agent **responds to a prompt**.
- [ ] **Agent responds to a _new_ prompt after pause→resume** (proves bridge reconnect — the #1
      resume risk).
- [ ] Resume preserves filesystem (create a file, idle to pause, resume, file still there).
- [ ] Idle timeout **pauses** (not kills) — `POST /sandboxes/{id}/pause`, resumable.
- [ ] Long session (> ~55 min on Hobby): a transparent pause/resume cycle, visible in logs as
      `sandbox.runtime_cap_reset`, no user-visible interruption.
- [ ] code-server URL works after resume with the same password.
- [ ] Operator/deployment stop **kills** via `DELETE /sandboxes/{id}`.
