# Modal to Cloudflare Containers Migration

Replace the Modal data plane with Cloudflare Containers so the entire Open-Inspect stack runs on
Cloudflare (plus GitHub for source control). No Modal account required.

## Goals

- Production-ready deployment on Cloudflare only (no Modal, no Vercel)
- Support small-to-large repos with acceptable cold-start performance
- Preserve the existing `SandboxProvider` abstraction — minimal blast radius
- Remove Linear bot (not needed)

## Constraints

- Cloudflare Containers beta — API may change, no SLA
- No native filesystem snapshots (Modal had this)
- Ephemeral disk — resets on container sleep/stop
- Container image fixed at deploy time (cannot swap per-instance)
- Max resources: 4 vCPU, 12 GiB RAM, 20 GB disk per container
- Account limits: 400 GiB total memory, 100 vCPU, 2 TB disk across all containers

## Architecture

The three-tier architecture stays. The migration boundary is the `SandboxProvider` interface.

```
Web (CF Workers/OpenNext) --> Control Plane (CF DO) --> CF Container (Python runtime)
```

### Before vs After

| Component | Before | After |
|---|---|---|
| Web app | Cloudflare Workers (OpenNext) | Same |
| Control plane | Cloudflare Workers + DO | Same (+ SandboxContainer export) |
| Data plane | Modal (Python) | Cloudflare Container |
| Sandbox runtime | Python supervisor + bridge + OpenCode | Same code, different host |
| Slack bot | Cloudflare Workers | Same |
| GitHub bot | Cloudflare Workers | Same |
| Linear bot | Cloudflare Workers | Removed |

### Component Diagram

```
+-----------------------------------+
| Web / Slack / GitHub  (unchanged) |
+-----------------------------------+
| Control Plane DO      (unchanged) |
+-----------------------------------+
| SandboxProvider interface         |  <-- migration boundary
+-----------------------------------+
| CloudflareContainerProvider  NEW  |  <-- replaces ModalProvider
+-----------------------------------+
| SandboxContainer (CF Container)   |  <-- replaces Modal sandbox
+-----------------------------------+
| sandbox-runtime       (unchanged) |
| bridge.py / entrypoint.py         |
| OpenCode                          |
+-----------------------------------+
```

## SandboxContainer Class

A new Durable Object extending Cloudflare's `Container` base class. Exported from the control-plane
Worker alongside `SessionDO` and `SchedulerDO`.

```typescript
export class SandboxContainer extends Container {
  defaultPort = 4096;           // OpenCode server
  sleepAfter = "60m";           // inactivity timeout
  enableInternet = true;        // git, npm, pip, outbound WebSocket
  pingEndpoint = "/health";     // OpenCode health endpoint

  get requiredPorts() {
    // 8080 = code-server, only when enabled
    return this.codeServerEnabled ? [4096, 8080] : [4096];
  }
}
```

### Instance Type

Default: `standard-3` (2 vCPU, 8 GiB RAM, 16 GB disk). Configurable via Terraform variable
`sandbox_instance_type`. Use `standard-4` (4 vCPU, 12 GiB, 20 GB) for heavy repos.

### Lifecycle

| Event | Behavior |
|---|---|
| Start | Control plane calls `getByName(sessionId)` then `startAndWaitForPorts()` |
| Environment | Per-instance env vars passed via `startOptions.envVars` at start time |
| Running | Bridge connects back to control plane DO via outbound WebSocket |
| Keepalive | `onActivityExpired()` returns true while sandbox is active; control plane sends periodic fetch() during prompts |
| Stop (user) | Control plane calls `destroy()` on the container |
| Stop (inactivity) | `onActivityExpired()` returns false, container sleeps |
| Shutdown signal | SIGTERM (15 min grace), same as Modal — no change to supervisor signal handling |

### Environment Variable Injection

Modal injected env vars at sandbox creation time via its API. Cloudflare Containers receive env vars
via the `startAndWaitForPorts()` call:

```typescript
await this.startAndWaitForPorts({
  startOptions: {
    envVars: {
      SANDBOX_ID: config.sandboxId,
      CONTROL_PLANE_URL: config.controlPlaneUrl,
      SANDBOX_AUTH_TOKEN: config.authToken,
      REPO_OWNER: config.repoOwner,
      REPO_NAME: config.repoName,
      GITHUB_TOKEN: config.gitToken,
      ANTHROPIC_API_KEY: config.anthropicKey,
      // ... same env vars as Modal, different injection mechanism
    }
  }
});
```

The Python sandbox runtime sees identical environment variables regardless of host.

## CloudflareContainerProvider

Implements the existing `SandboxProvider` interface.

### Capabilities (Phase 1)

```typescript
readonly capabilities: SandboxProviderCapabilities = {
  supportsSnapshots: false,
  supportsRestore: false,
  supportsWarm: false,  // not needed: 2-3s cold start
};
```

### createSandbox()

1. Get container stub: `env.SANDBOX_CONTAINER.getByName(sandboxId)`
2. Store session metadata (session ID, status) in container's DO storage (survives sleep cycles, used by `onActivityExpired()` to decide keepalive)
3. Call `startAndWaitForPorts()` with per-instance env vars (sandbox config, repo info, auth tokens)
4. Return `CreateSandboxResult` with sandbox ID and status

### Error Classification

Same transient vs permanent classification as Modal provider:
- Transient: network errors, container start timeout, 502/503/504
- Permanent: invalid config, account limits exceeded, 4xx errors

### No Snapshot/Restore (Phase 1)

`takeSnapshot()` and `restoreFromSnapshot()` not implemented. The lifecycle manager already handles
providers that don't support these — it falls back to fresh `createSandbox()` calls.

## Fast Start Strategy

Without Modal's filesystem snapshots, cold-start performance relies on:

### Single Base Image

One Dockerfile with all tools pre-installed. Built at deploy time via wrangler.

Contents (mirrors `packages/modal-infra/src/images/base.py`):
- Debian bookworm-slim
- Node.js 22 LTS + pnpm + Bun
- Python 3.12 + uv
- Git, curl, build-essential, jq
- GitHub CLI (gh)
- agent-browser + headless Chromium
- code-server
- OpenCode CLI
- sandbox-runtime package

### Cold Start Budget

| Step | First Session | Follow-up (alive) | Follow-up (slept) |
|---|---|---|---|
| Container start | 2-3s | 0s | 2-3s |
| Shallow clone | 5-15s | 0s | 5-15s |
| setup.sh | 15-60s | 0s | 15-60s (disk reset) |
| start.sh | 0-5s | 0s | 0-5s |
| OpenCode start | 3-5s | 0s | 3-5s |
| **Total** | **25-85s** | **0s** | **25-85s** |

The `sleepAfter: 60m` timeout means most interactive sessions hit the "container still alive" case
(0s overhead). When a container sleeps, the ephemeral disk resets — the slept case is equivalent to a
first session. The 60-minute timeout is chosen to keep containers alive for typical working sessions.

### Phase 2: R2 Dependency Cache (Future, Out of Scope)

If cold starts prove too slow for specific repos:
- After `setup.sh`, tar key directories (node_modules, .venv) and upload to R2
- On next cold start, download from R2 before running setup.sh
- Key: `{repo_owner}/{repo_name}/{lockfile_hash}.tar.gz`

This is additive and does not affect the Phase 1 architecture.

## Sandbox Runtime

The Python sandbox runtime (`packages/sandbox-runtime/`) runs unchanged inside the Container.

### No Changes Required

- `entrypoint.py` — supervisor, process management, signal handling, setup/start scripts
- `bridge.py` — WebSocket connection to control plane, event buffering, prompt handling, git push
- `constants.py`, `types.py` — shared types and constants
- `auth/` — GitHub App auth, internal auth

### Snapshot-Related Code Becomes No-ops

- `RESTORED_FROM_SNAPSHOT` env var — never set (always fresh start)
- `FROM_REPO_IMAGE` / `REPO_IMAGE_SHA` — not applicable
- Snapshot callbacks to control plane — never triggered

The entrypoint already handles the "no snapshot" path as its default behavior.

### Dockerfile

New file: `packages/control-plane/Dockerfile.sandbox`

Translates the Modal image definition from `packages/modal-infra/src/images/base.py` to a standard
Dockerfile. Same tools, same versions, same layout.

```dockerfile
FROM debian:bookworm-slim

# System dependencies
RUN apt-get update && apt-get install -y \
    git curl build-essential openssh-client jq ca-certificates gnupg

# Node.js 22 LTS
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y nodejs \
    && npm install -g pnpm bun

# Python 3.12 + uv
RUN apt-get install -y python3.12 python3.12-venv python3-pip \
    && pip install uv --break-system-packages

# GitHub CLI
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=...] ..." \
    > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update && apt-get install -y gh

# agent-browser + Chromium
RUN npm install -g @anthropic/agent-browser

# code-server
RUN curl -fsSL https://code-server.dev/install.sh | sh

# OpenCode CLI
RUN npm install -g opencode @opencode-ai/plugin

# Sandbox runtime
COPY packages/sandbox-runtime/ /app/sandbox_runtime/
RUN cd /app && pip install -e sandbox_runtime/ --break-system-packages

ENV NODE_PATH=/usr/lib/node_modules
WORKDIR /workspace

CMD ["python3", "-m", "sandbox_runtime.entrypoint"]
```

Exact versions and install commands will be finalized from the current `images/base.py`.

## Terraform Changes

### Added

**Container config in `workers-control-plane.tf`:**
- `containers` block for `SandboxContainer` (image, instance_type, max_instances)
- `SANDBOX_CONTAINER` Durable Object binding
- Migration tag for new sqlite class

**New variables in `variables.tf`:**
- `sandbox_instance_type` (default: `"standard-3"`)
- `sandbox_max_instances` (default: `20`)

### Removed

| Resource | File | Action |
|---|---|---|
| Modal deployment | `modal.tf` | Delete file |
| Modal variables | `variables.tf` | Remove modal_token_id, modal_token_secret, modal_workspace, modal_api_secret |
| Linear bot worker | `workers-linear-bot.tf` | Delete file |
| Linear KV namespace | `kv.tf` | Remove linear entries |
| Linear variables | `variables.tf` | Remove linear-related variables |

### Modified

| File | Change |
|---|---|
| `workers-control-plane.tf` | Add container config, remove Modal env vars |
| `variables.tf` | Add sandbox vars, remove Modal + Linear vars |
| `terraform.tfvars.example` | Remove Modal + Linear sections, add sandbox config |
| `outputs.tf` | Update verification commands (no Modal health check) |

### Two-Phase Deploy

Still required for Durable Object bindings. Same process as today:
1. Phase 1: `enable_durable_object_bindings = false`
2. Phase 2: `enable_durable_object_bindings = true`

### Simplified Credentials

| Before | After |
|---|---|
| Cloudflare API token | Cloudflare API token (same) |
| Modal token ID + secret | Not needed |
| Modal workspace | Not needed |
| Vercel token + team ID | Not needed |
| GitHub App credentials | GitHub App credentials (same) |
| Anthropic API key | Anthropic API key (same) |
| 6 generated secrets | 4 generated secrets |

One cloud provider bill instead of three.

## Packages Removed

| Package | Approx Size | Reason |
|---|---|---|
| `packages/modal-infra/` | ~3,000 lines Python | Replaced by Container |
| `packages/linear-bot/` | ~1,500 lines TypeScript | Not needed |

## Control-Plane File Changes

### Removed

| File | Purpose |
|---|---|
| `src/sandbox/client.ts` | Modal HTTP API client |
| `src/sandbox/providers/modal-provider.ts` | Modal SandboxProvider |

### Added

| File | Purpose |
|---|---|
| `src/sandbox/providers/cloudflare-container-provider.ts` | New SandboxProvider |
| `src/containers/sandbox-container.ts` | SandboxContainer class |
| `Dockerfile.sandbox` | Container image definition |

### Modified

| File | Change |
|---|---|
| `src/sandbox/lifecycle/manager.ts` | Wire new provider (minimal, uses interface) |
| `src/session/durable-object.ts` | Add SANDBOX_CONTAINER binding type, pass to provider |
| `src/index.ts` | Export SandboxContainer class |

## Unchanged Packages

| Package | Why |
|---|---|
| `packages/shared/` | No Modal-specific types |
| `packages/web/` | Talks to control plane only |
| `packages/slack-bot/` | Creates sessions via control plane API |
| `packages/github-bot/` | Creates sessions via control plane API |
| `packages/sandbox-runtime/` | Runs identically inside Container |

## Out of Scope

- R2 dependency caching (Phase 2, only if cold starts prove too slow)
- Multi-provider support (replacing Modal, not adding alongside)
- D1 schema changes (existing tables work as-is; snapshot fields become unused)
- Web UI changes (provider-agnostic)
- WebSocket protocol changes (identical bridge behavior)

## Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| Containers beta API changes | Medium | Pin compatibility_date, monitor changelog |
| 20 GB disk too small for large monorepos | Low | Use standard-4 (20 GB), or split workload |
| Cold start too slow without snapshots | Medium | Phase 2 R2 cache; 60m sleepAfter keeps alive for sessions |
| Account resource limits hit | Low | Monitor usage; max_instances caps concurrent containers |
| Outbound WebSocket reliability | Low | Bridge already has reconnection + exponential backoff |
