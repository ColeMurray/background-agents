# Sandbox0

Sandbox0 uses one durable workspace per Open-Inspect session. An idle or stale workspace is paused;
resuming retains its ID and filesystem but starts new processes. No process memory, sockets, PIDs or
`/tmp` contents survive pause. Fatal startup failures and explicit respawns delete the failed
workspace.

## Build and select a runtime template

Install Python 3.12+, `uv`, and the repository's Node dependencies. Supply a Sandbox0 API key
through your secret manager or environment, never as an argument. Building allocates billable
disposable sandboxes in that key's team/region.

```sh
export SANDBOX0_API_URL=https://api.sandbox0.ai
# SANDBOX0_API_KEY must already be set securely.
npm run sandbox:images -- build --provider sandbox0 --output /tmp/sandbox0-image.json
```

The builder installs the shared pinned toolchain in the public `default` template (Ubuntu,
linux/amd64), pauses the finished builder to checkpoint its filesystem, captures a uniquely named
RootFS template, waits for capture completion and runs the shared smoke suite in a fresh claim. It
returns a reference only after verification. It never overwrites an existing template. To retry
verification of a retained candidate, set `OPENINSPECT_IMAGE_CANDIDATE` to its ID. Unselected
candidate templates are retained for inspection; remove them explicitly when no longer needed.
Builder/probe sandboxes have bounded hard TTLs and are deleted after use. An unresolved capture
keeps its source until its hard TTL.

Configure the Node or Workers control plane:

```dotenv
SANDBOX_PROVIDER=sandbox0
SANDBOX0_API_URL=https://api.sandbox0.ai
SANDBOX0_TEMPLATE_ID=<verified-reference>
# SANDBOX0_API_KEY=<secret binding>
```

For Terraform, set `sandbox_provider`, `sandbox0_api_key`, `sandbox0_api_url`, and
`sandbox0_template_id`. Template creation is an explicit pre-deployment step. Self-hosted HTTPS
regional endpoints are supported; loopback HTTP is allowed for isolated development. The API key
needs sandbox read/write and session access; the builder additionally needs template creation/read
access.

## Lifecycle and access boundaries

- `createSandbox`: claim the configured template, configure service routes and launch the shared
  runtime as a supervised Sandbox0 session.
- `stopSandbox`: pause on inactivity/heartbeat timeout, delete on failed startup or respawn. Pause
  is successful only after the API confirms a committed checkpoint.
- `resumeSandbox`: resume the same workspace, then restart the stopped runtime in restore mode (skip
  clone/setup, preserve checkout and agent history, rerun start hooks). An already running attempt
  is left alone. Only a workspace 404 requests a fresh allocation; auth/network failures do not
  discard durable state.
- The runtime TTL pauses workspaces. Hard TTL is disabled for session workspaces so idle retention
  does not silently delete user changes. Operators must manage retained workspace storage and
  cleanup according to their retention policy.
- Code-server and browser desktop use application-level passwords. Custom tunnel ports are public
  HTTP services: applications exposed there must implement any required authentication themselves.
  Routes do not auto-resume a paused workspace.
- Repository prebuilds, per-turn snapshots and the standalone web terminal are not enabled by this
  provider. Persistent resume replaces the session snapshot path; code-server's terminal remains
  available. The standalone terminal needs a provider-neutral token-renewal contract on resume
  before it can be enabled.

## Testing

Unit tests cover REST errors, cleanup, resume ordering, password continuity and capability
boundaries. The opt-in live test uses the real template, runtime, OpenCode and bridge with a
loopback control-plane protocol fixture. It checks two pause/resume cycles, uncommitted Git changes,
runtime identity and editor/desktop ingress. It does not execute a real LLM prompt or exercise the
web UI.

```sh
npm run build -w @open-inspect/shared
npx esbuild packages/control-plane/scripts/smoke-sandbox0.ts --bundle --platform=node --format=esm --outfile=/tmp/oi-sandbox0-smoke.mjs
# Set SANDBOX0_API_KEY and SANDBOX0_TEMPLATE_ID securely first.
node /tmp/oi-sandbox0-smoke.mjs
```

The live test creates only its own sandbox and deletes it in `finally`, with a 30-minute hard TTL as
a fallback. Do not use production customer workspaces as test fixtures.
