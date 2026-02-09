# Claude Code Project Notes

## Available Skills

- **`/onboarding`** - Interactive guided deployment of your own Open-Inspect instance. Walks through
  repository setup, credential collection, Kubernetes deployment, and verification with user handoffs
  as needed.

## Deploying Your Own Instance

For a complete guide to deploying your own instance of Open-Inspect, see
**[docs/GETTING_STARTED.md](docs/GETTING_STARTED.md)**.

Alternatively, run `/onboarding` for an interactive guided setup.

## Infrastructure Overview

Open-Inspect runs on fully open-source infrastructure on Kubernetes:

| Component          | Technology                      | Purpose                              |
| ------------------ | ------------------------------- | ------------------------------------ |
| Control Plane      | Hono + Rivet Actors             | HTTP API + stateful session actors   |
| Sandbox Runtime    | agent-sandbox CRD (K8s)         | Isolated code execution environments |
| Actor Orchestrator | Rivet Engine                    | Actor scheduling, state persistence  |
| Message Bus        | NATS                            | Inter-service communication          |
| Database           | PostgreSQL                      | Session index, repo metadata, secrets|
| Cache              | Redis                           | Repository list caching              |
| Web Frontend       | Next.js                         | Web client UI                        |

## Control Plane (Hono + Rivet Actors)

### Deployment

```bash
# Build and deploy the control plane
docker build -t open-inspect-control-plane packages/control-plane/
kubectl apply -f k8s/control-plane/
```

### Session Actors

Each session gets its own Rivet Actor instance with:

- **Actor State**: Session metadata, participants, messages, events, artifacts, sandbox status
- **Actions**: RPC methods called by the Hono router (getState, enqueuePrompt, stop, etc.)
- **WebSocket**: Real-time connections from web clients and sandbox processes
- **Hibernation**: Actors sleep when idle and wake instantly on new requests

The actor replaces the previous Cloudflare Durable Object. State is automatically persisted
by Rivet Engine to PostgreSQL.

### API Endpoints

All routes are in `packages/control-plane/src/router.ts`:

- `POST /sessions` - Create session
- `GET /sessions` - List sessions
- `GET /sessions/:id` - Get session state
- `DELETE /sessions/:id` - Delete session
- `POST /sessions/:id/prompt` - Send prompt
- `POST /sessions/:id/stop` - Stop execution
- `GET /sessions/:id/events` - Paginated events
- `GET /sessions/:id/artifacts` - List artifacts
- `GET /sessions/:id/participants` - List participants
- `GET /sessions/:id/messages` - List messages
- `POST /sessions/:id/pr` - Create PR
- `POST /sessions/:id/ws-token` - Generate WebSocket token
- `POST /sessions/:id/archive` - Archive session
- `GET /repos` - List repositories (cached in Redis)
- `GET /repos/:owner/:name/metadata` - Get repo metadata
- `PUT /repos/:owner/:name/metadata` - Update repo metadata
- `GET /repos/:owner/:name/secrets` - List secret keys (values never exposed)
- `PUT /repos/:owner/:name/secrets` - Upsert secrets (batch)
- `DELETE /repos/:owner/:name/secrets/:key` - Delete a single secret
- `GET /health` - Health check

### Database

PostgreSQL stores shared data across sessions:

- **sessions** table: Session index for listing/filtering
- **repo_metadata** table: Custom descriptions, aliases, keywords per repo
- **repo_secrets** table: Encrypted repository-scoped secrets (AES-256-GCM)

Managed via `packages/control-plane/src/db/postgres.ts`.

### Caching

The `/repos` endpoint caches the enriched repository list in Redis with a 5-minute TTL.
On cache miss it re-fetches from GitHub API and PostgreSQL.

### API Authentication

Sandbox pods authenticate to the control plane using HMAC-signed tokens via the
`INTERNAL_API_SECRET` shared secret. Tokens expire after 5 minutes.

## Sandbox Runtime (agent-sandbox CRD)

Sandboxes are managed by the [kubernetes-sigs/agent-sandbox](https://github.com/kubernetes-sigs/agent-sandbox)
controller, which provides pod lifecycle, stable DNS, network isolation, warm pools, and auto-expiry.

### Building the Image

```bash
cd packages/sandbox-runtime
docker build -t open-inspect-sandbox .
```

### How Sandboxes Work

When a session needs a sandbox:

1. Control plane creates a `Sandbox` custom resource (`agents.x-k8s.io/v1alpha1`)
2. agent-sandbox controller creates a pod + headless service (stable DNS)
3. Pod starts the supervisor process (`entrypoint.py`)
4. Supervisor: git clone → setup script → OpenCode server → bridge
5. Bridge connects to control plane WebSocket
6. Events flow bidirectionally through WebSocket
7. Sandbox auto-expires via `shutdownTime` (controller deletes pod + service)

### Warm Pools

`SandboxWarmPool` pre-creates sandbox pods so new sessions start instantly:

```yaml
# k8s/sandbox/warmpool.yaml
apiVersion: extensions.agents.x-k8s.io/v1alpha1
kind: SandboxWarmPool
metadata:
  name: open-inspect-sandbox-pool
spec:
  replicas: 2                          # Number of pre-warmed pods
  sandboxTemplateRef:
    name: open-inspect-sandbox         # References the SandboxTemplate
```

### Network Isolation

The `SandboxTemplate` defines a `NetworkPolicy` that restricts sandbox egress to:
- DNS (port 53)
- HTTPS (port 443) for GitHub/LLM APIs
- Control plane (port 8080) within the `open-inspect` namespace

### Runtime Isolation

For stronger isolation, uncomment `runtimeClassName: gvisor` in the SandboxTemplate
or set `runtimeClassName` in the provider config. Kata Containers is also supported.

### Environment Variables

Sandbox pods receive configuration via the Sandbox CR's embedded podTemplate:

| Variable            | Description                           |
| ------------------- | ------------------------------------- |
| CONTROL_PLANE_URL   | Base URL for control plane            |
| SANDBOX_AUTH_TOKEN   | Auth token for this sandbox           |
| SANDBOX_ID          | Unique sandbox identifier             |
| SESSION_ID          | Session this sandbox belongs to       |
| REPO_OWNER          | Repository owner                      |
| REPO_NAME           | Repository name                       |
| PROVIDER            | LLM provider (default: "anthropic")   |
| MODEL               | LLM model (default: "claude-haiku-4-5") |
| ANTHROPIC_API_KEY   | API key for Claude                    |

### Common Issues

1. **Sandbox can't connect to control plane** - Check that CONTROL_PLANE_URL is correct and the
   control plane service is reachable from the sandbox namespace.

2. **Git clone fails** - Verify GitHub App credentials are correctly configured in
   `k8s/control-plane/secret.yaml`.

3. **OpenCode fails to start** - Check sandbox pod logs:
   `kubectl -n open-inspect logs -l open-inspect/sandbox-id={id}`

## GitHub App Authentication

> **Single-Tenant Design**: The GitHub App configuration uses a single installation ID
> (`GITHUB_APP_INSTALLATION_ID`) shared by all users. This system is designed for
> internal/single-tenant deployment only.

### Required Secrets

GitHub App credentials (`GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_APP_INSTALLATION_ID`) are
needed by **two services**:

1. **Sandbox pods** - for cloning repos and pushing commits
2. **Control plane** - for listing installation repositories (`/repos` endpoint)

Both are configured via K8s Secrets in `k8s/control-plane/secret.yaml`.

### Token Lifetime

- GitHub App installation tokens expire after **1 hour**
- Generate fresh tokens for operations that may happen after startup

### Token Flow

```
Startup (git sync):  Sandbox pod → generate token → git clone
Push (PR creation):  Control plane → generate fresh token → WebSocket → sandbox
PR API:              Control plane → user OAuth token → GitHub API (server-side only)
```

## Rivet Engine

### What It Does

The Rivet Engine is a Rust-based orchestrator that manages actor lifecycle:

- Allocates actors to runners
- Persists actor state to PostgreSQL
- Handles hibernation (sleep/wake)
- Routes requests to the correct actor
- Health checking and failover

### Deployment

Two K8s Deployments in `k8s/rivet-engine/`:

1. **Main deployment** (2+ replicas, HPA) - `--except-services singleton`
2. **Singleton deployment** (1 replica) - Runs all services including singletons

Dependencies: NATS (`k8s/nats/`) and PostgreSQL (`k8s/postgres/`).

### Health Check

```bash
kubectl -n open-inspect port-forward svc/rivet-engine 6421:6421
curl http://localhost:6421/health
```

## Coding Conventions

### Durations and timeouts

- **Use seconds for Python, milliseconds for TypeScript.** These match the native conventions of
  each ecosystem. Never use minutes or hours as the unit.
- **Encode the unit in the name.** Python: `timeout_seconds`. TypeScript: `timeoutMs`.
- **Define each default value exactly once.** Extract to a named constant and import everywhere.
- **Don't restate literal values in comments.**

### Extending existing patterns

- When threading an existing field through new code paths, evaluate whether the existing design
  (naming, types, units) is correct — don't blindly propagate it.

## Kubernetes Manifests

All K8s manifests are in the `k8s/` directory:

```
k8s/
├── namespace.yaml
├── kustomization.yaml
├── ingress.yaml
├── rivet-engine/     # Actor orchestrator
├── nats/             # Message bus
├── postgres/         # Database
├── redis/            # Cache
├── control-plane/    # API + Actors
├── web/              # Frontend
└── sandbox/          # agent-sandbox CRDs (template, warmpool, RBAC)
```

### Quick Deploy

```bash
kubectl apply -k k8s/
kubectl -n open-inspect get pods
```

## Testing

### End-to-End Test Flow

```bash
# Port-forward control plane
kubectl -n open-inspect port-forward svc/control-plane 3001:3001

# Create session
curl -X POST http://localhost:3001/sessions \
  -H "Content-Type: application/json" \
  -d '{"repoOwner":"owner","repoName":"repo"}'

# Send prompt
curl -X POST http://localhost:3001/sessions/{sessionId}/prompt \
  -H "Content-Type: application/json" \
  -d '{"content":"...","authorId":"test","source":"web"}'

# Check events
curl http://localhost:3001/sessions/{sessionId}/events
```

### Viewing Logs

```bash
# Control plane logs
kubectl -n open-inspect logs -l app=control-plane -f

# Sandbox pod logs
kubectl -n open-inspect logs -l open-inspect/sandbox-id={sandboxId} -f

# Rivet Engine logs
kubectl -n open-inspect logs -l app=rivet-engine -f

# NATS logs
kubectl -n open-inspect logs -l app=nats -f
```
