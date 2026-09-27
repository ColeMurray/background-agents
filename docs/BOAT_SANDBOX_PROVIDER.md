# Boat Sandbox Provider

Open-Inspect can run coding sessions on [Boat](https://boat.dev). The control plane calls Boat's v1
REST API directly from Cloudflare Workers or the Node host; there is no provider-side Open-Inspect
service. Boat supplies the VM, automatic filesystem capture, private hosted ports, and same-ID
stop/resume. The existing Open-Inspect runtime still owns repository setup, both agent harnesses,
and the outbound control-plane WebSocket.

## Configuration

```hcl
sandbox_provider = "boat"

boat_api_key               = "boat_..."
boat_sandbox_access_secret = "a stable random secret with at least 32 characters"

# Optional
boat_api_url              = "https://boat.dev/api/v1"
boat_org                  = "personal"
boat_template_prefix      = "" # derives a deployment-specific managed prefix
boat_sandbox_type         = "default" # small, default, or large
boat_template_sandbox_type = "default"
boat_build_api_key        = "boat_..." # falls back to boat_api_key
boat_base_snapshot        = ""         # verified manual pin; skips managed build
```

For a non-Terraform Node deployment, set the equivalent variables:

```text
SANDBOX_PROVIDER=boat
BOAT_API_KEY=...
BOAT_SANDBOX_ACCESS_SECRET=...
BOAT_BASE_SNAPSHOT=...
BOAT_API_URL=https://boat.dev/api/v1
BOAT_ORG=...
BOAT_SANDBOX_TYPE=default
```

`BOAT_SANDBOX_ACCESS_SECRET` derives code-server and VNC passwords. Keep it stable when rotating the
Boat API key so resumed sandboxes retain their access credentials.

## API Keys

Use scoped, expiring service keys. The runtime key needs:

- `sandbox.create`, `sandbox.read`, `sandbox.update`, `sandbox.stop`, `sandbox.resume`, and
  `sandbox.delete`
- `exec`, `file.write`, `host`, `snapshot.read`, and `account.read` (deletion-operation status)

The build key additionally needs `snapshot.write`. It is consumed only by Terraform/local template
construction and is never bound to the control-plane Worker. If one key is used for both roles,
leave `boat_build_api_key` empty.

## Lifecycle

Boat is represented as a persistent-resume provider:

- Fresh sessions deploy from the verified named snapshot with `noEnv: true` and only the explicit
  Open-Inspect session environment.
- Open-Inspect passes a finite TTL on every create and resume. It never disables Boat auto-stop.
- Inactivity and pre-expiry shutdown send a non-forced stop. Boat captures the filesystem first and
  refuses the stop rather than discarding unsaved writes.
- A later prompt resumes the same Boat sandbox ID, restores its original environment, recreates
  private routes, and launches the runtime exactly once through a `flock`-guarded script.
- Permanent replacement/deletion uses Boat's confirmation header. Boat removes the sandbox from
  normal reads immediately; physical deletion can remain `blocked` while deduplicated snapshot data
  is shared, without leaving runnable compute.

The public OpenAPI currently calls the retained state `archived`; live API/CLI 1.0.28 validation on
September 24, 2026 returned `stopped`. Open-Inspect accepts both and requires `snapshotAvailable`
before recording preservation success.

## Persistent Workspace

Boat documents `/home/user` plus selected system trees as captured. `/workspace` itself is not
captured. Open-Inspect therefore stores user state at:

```text
/home/user/openinspect/workspace
```

The persistent launcher and `/app` payload live under `/home/user/openinspect`. It recreates `/app`
and `/workspace` as symlinks, then force-reads the required `/opt`, desktop, and noVNC trees until
Boat's lazy snapshot hydration is stable. Live probes confirmed `/app` is not captured and that
starting immediately can observe `/opt` as absent or being renamed by hydration; launch waits rather
than racing or duplicating the provider's working root restore. Existing runtime, editor,
repository, and harness paths remain unchanged after preparation.

Boat's Ubuntu host disables the unprivileged user namespaces Chrome's process sandbox requires. The
Boat template therefore configures agent-browser with `--no-sandbox`; isolation remains the Boat VM
boundary. Other sandbox providers keep their existing Chrome sandbox configuration.

Processes do not survive Boat stop/resume. The launcher is deliberately safe to invoke after an
ambiguous command response: a filesystem lock permits one supervisor, and session credentials stay
in Boat's retained per-sandbox environment rather than on the command line.

## Resources And Timeouts

CPU/memory settings map upward to Boat's public machine presets:

| Type      | CPU | Memory    |
| --------- | --- | --------- |
| `small`   | 2   | 4096 MiB  |
| `default` | 4   | 8192 MiB  |
| `large`   | 8   | 16384 MiB |

Requests larger than `large` fail instead of silently receiving fewer resources. `xlarge` is not
enabled because Boat's CLI documents it but the public OpenAPI does not. Session TTLs must be whole
seconds from 1 through 2,592,000 (30 days); account-plan limits may be lower.

## Private Access

Code-server, ttyd, noVNC, and configured tunnel ports use Boat's private `host` routes. Their URLs
contain a bearer `_token` query parameter and are encrypted by the existing sandbox-access storage.
They must never be logged or made public. The web URL helpers preserve `_token` when adding ttyd
authentication or the noVNC path and password fragment.

Live compatibility probes confirmed private hosted HTTP and WebSocket upgrades and stable tokens
after resume. An expired ttyd JWT disables terminal access with a warning; it never destroys a
successfully resumed persistent sandbox.

The same live probe also confirmed that `noEnv: true` with explicit environment variables excludes
account configuration, resume with omitted `env` retains the original session environment,
`archiveAfter` advances from resume time, hand-launched processes do not survive, and outbound WSS
from Boat succeeds. Create lost-response/idempotency behavior is covered by the documented API
contract and mocked transport tests; the production fresh-bridge canary remains mandatory.

## Base Template

Terraform builds a hash-qualified immutable named snapshot before deploying a Worker that references
it:

1. Pack the shared provider-neutral image bundle and verify frozen locks.
2. Install it in a finite-TTL, no-env Boat sandbox.
3. Save a named snapshot under `<boat_template_prefix>-<build hash>`.
4. Deploy a fresh verifier from that exact snapshot.
5. Run the full image smoke suite plus private hosted HTTP/WebSocket probes.
6. Publish the snapshot name only after verification and delete temporary sandboxes.

Boat permits ten named snapshots. The builder deletes only stale snapshots under its deployment
prefix, protects the currently deployed reference while constructing a candidate, and keeps the new
and immediately previous references after Worker deployment. It never deletes unrelated account
snapshots. `boat_base_snapshot` is the manual rollback/override pin.

Manual build:

```bash
cd packages/boat-infra
uv sync --frozen
BOAT_BUILD_API_KEY=boat_... \
BOAT_TEMPLATE_PREFIX=openinspect-production \
uv run --frozen python build_template.py
```

## Unsupported Capabilities

Boat is intentionally not registered in Open-Inspect's repository/environment image-build subsystem.
The public platform offers at most ten account-level named templates, not independently addressable
provider artifacts suitable for an unbounded set of repositories. Settings > Images and image-build
API routes therefore report Boat as unsupported. This does not affect the shared base runtime
template or persistent session recovery.

Boat also has no public region selector or GPU support. Native Boat repository environments are not
used; Open-Inspect keeps its credential-brokered GitHub, GitLab, and Bitbucket clone path.

## Release Canaries

The Terraform build is the automated live provider gate. Before enabling production, also verify:

1. Fresh session reaches early bridge and `ready` with both OpenCode and Claude Agent harnesses.
2. GitHub, GitLab, and Bitbucket clone/push paths use brokered credentials.
3. Code-server, terminal, noVNC, and generic HTTP/WebSocket tunnels work through private routes.
4. Uncommitted files, `.git`, and agent state survive explicit stop and provider TTL auto-stop.
5. Resume launches exactly one runtime and reports a refreshed finite deadline.
6. Ambiguous create/launch/stop/resume/delete calls do not duplicate or discard retained state.
7. Template replacement near the ten-snapshot limit preserves current and rollback artifacts.

Use `boat list --json`, `boat info <id> --json`, and `boat deletion status <operation> --json` for
provider-side diagnosis. In control-plane logs, query
`component="boat-rest-client" msg="boat.request"` and `component="boat-provider"`; complete private
URLs and environment values are intentionally absent.

## Provider Switching

Before switching away from Boat, stop/drain active sessions and keep `BOAT_API_KEY`, the current
named snapshot, and the previous rollback snapshot configured through the rollback window. Archived
Boat sandboxes retain storage but no running compute. Open-Inspect does not migrate recovery state
across providers; switching back to Boat makes retained sessions eligible to resume again.

## References

- [Boat platform guide](https://docs.boat.dev/platform-guide)
- [Boat API v1](https://docs.boat.dev/api/v1)
- [Snapshots and copies](https://docs.boat.dev/snapshots)
- [Private hosting](https://docs.boat.dev/hosting)
- [Scoped API keys](https://docs.boat.dev/api-keys)
