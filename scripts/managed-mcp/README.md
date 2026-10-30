# Local managed MCP verification

This is a **loopback-only test fixture**, not a production MCP gateway. Test-only controls select
synthetic reader/operator identities; PKCE, code consumption, client/resource binding, bearer
authentication, rotation and tool authorization are exercised independently of an external identity
provider.

From the repository root, with Node 24 and dependencies installed:

```sh
npm run build -w @open-inspect/shared
npx esbuild scripts/managed-mcp/example-server.ts --bundle --platform=node --format=esm --target=node24 --outfile=scripts/managed-mcp/.example-server.mjs
node scripts/managed-mcp/.example-server.mjs
```

In a second terminal:

```sh
uv venv --python 3.12 .venv-managed-mcp
uv pip install --python .venv-managed-mcp/bin/python -e 'packages/sandbox-runtime[dev]'
npm install --prefix /tmp/open-inspect-managed-mcp-tools opencode-ai@1.18.29
.venv-managed-mcp/bin/python scripts/managed-mcp/native-canary.py --opencode /tmp/open-inspect-managed-mcp-tools/node_modules/.bin/opencode
```

The canary verifies OpenCode **1.18.29** and Claude Agent SDK **0.2.168**, creates isolated native
HOME/config/data directories, and makes no model inference calls. It checks native deferred OpenCode
connect, fresh personal sessions/catalogs for both users in both clients, teardown after route
eligibility closes, fixture reader denial/operator success, and a single mutation despite a failed
response. The example proxy uses the production relay/credential store with real local HTTP on both
sides, but synthetic context selection; actual route, admission and Durable Object behavior are
tested separately in Workerd. Hosted callback behavior requires separate deployment verification.

The separate Claude configuration regression needs only the Python environment, not the example
server or an API key:

```sh
.venv-managed-mcp/bin/python scripts/managed-mcp/claude-config-canary.py
```

It uses production MCP formatting/policy helpers and the exact SDK pin to prove that unavailable
managed names cannot initialize same-name user/project connectors, available names use the explicit
managed HTTP entry, and unrelated user/project stdio connectors remain usable. It checks an
unavailable → available → unavailable sequence using isolated temporary configuration.

The OpenCode cancellation regression also needs only the Python environment and pinned binary:

```sh
.venv-managed-mcp/bin/python scripts/managed-mcp/opencode-cancel-canary.py --opencode /tmp/open-inspect-managed-mcp-tools/node_modules/.bin/opencode
```

It reproduces the pin's late-connect behavior: cancelling a control request and observing a
successful disconnect does **not** fence pending initialization in the native server. The production
wrapper must remain poisoned and refuse following turns after an uncertain prepare. The control
plane also keeps delegation disabled for that allocation across bridge-only restarts; recovery
requires replacing the sandbox/native server, not merely reconnecting its bridge.

## Automated suites

Run heavy checks serially:

```sh
npm run test -w @open-inspect/control-plane -- --maxWorkers=1
npm run test:integration -w @open-inspect/control-plane -- --maxWorkers=1 test/integration/managed-mcp-conformance.test.ts test/integration/managed-mcp-proxy.test.ts test/integration/mcp-servers.test.ts
npm run test -w @open-inspect/shared -- --maxWorkers=1
npm run test -w @open-inspect/slack-bot -- --maxWorkers=1 src/completion
npm run test -w @open-inspect/web -- --maxWorkers=1 src/components/settings/mcp-connections-settings.test.tsx src/components/settings/mcp-servers-settings.test.tsx src/components/settings/settings-registry.test.ts src/app/api/mcp-connections/oauth/callback/route.test.ts src/components/sidebar/metadata-section.test.tsx
.venv-managed-mcp/bin/python -m pytest packages/sandbox-runtime/tests -q --basetemp "$(mktemp -d /tmp/mcp-py.XXXXXX)"
```

A short pytest temp directory avoids macOS AF_UNIX socket path limits in the existing Docker-control
tests. Three Linux-only runtime tests may skip on macOS.
