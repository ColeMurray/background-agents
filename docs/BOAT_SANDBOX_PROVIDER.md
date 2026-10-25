# Boat Sandbox Provider

Open-Inspect can use [Boat](https://boat.dev) as the sandbox provider for coding sessions. The
control plane talks directly to the Boat REST API from Cloudflare Workers — there is no separate
service to deploy for this provider; only the base snapshot is built (by Terraform, or manually).

## When to Use It

Use `sandbox_provider = "boat"` when you want sandbox sessions to run in Boat's full Ubuntu virtual
machines (real `systemd`, Docker, passwordless `sudo`) while keeping the same Open-Inspect control
plane, web app, GitHub OAuth, and Slack/GitHub integrations. Boat sandboxes support stop/resume: an
idle session's disk is snapshotted and its machine released, and the next prompt brings the same
sandbox back on a new machine with its files intact.

## Required Configuration

Set these values in `terraform/environments/production/terraform.tfvars`:

```hcl
sandbox_provider = "boat"

boat_api_key       = "boat_..."      # from the Boat dashboard → API keys
boat_base_snapshot = "open-inspect"  # prefix of the saved snapshot to build/use

# Optional
# boat_api_url      = "https://boat.dev/api/v1" # REST API base URL
# boat_org          = ""                        # organization wallet; empty = active wallet
# boat_sandbox_type = "default"                 # machine size when a session requests no resources
```

For GitHub Actions-based deployment, configure the matching repository secrets and variables:

```text
SANDBOX_PROVIDER=boat
BOAT_API_KEY
BOAT_BASE_SNAPSHOT
BOAT_API_URL      # optional
BOAT_ORG          # optional
BOAT_SANDBOX_TYPE # optional
```

The Boat provider also needs the normal Open-Inspect values such as Cloudflare, GitHub App, and web
app configuration. See [GETTING_STARTED.md](./GETTING_STARTED.md) for the full deployment flow.

`boat_base_snapshot` is the Terraform name prefix: snapshots use `<prefix>-<16 lowercase hex>` from
the build-input hash. Boat names allow 63 lowercase letters, digits and dashes in total, so keep the
prefix to 46 characters or fewer. The base prefixes `oi-img` and every prefix starting with
`oi-img-` are reserved for prebuilt images and rejected by Terraform, the module, and build/prune
validation, including manual builds and prune candidates.

Use a unique prefix for each deployment sharing a Boat account or organization wallet. Pruning
treats all exact matching names as belonging to that deployment; reusing a prefix can delete another
deployment's live base snapshot.

### What a stop keeps

A Boat snapshot saves `/home`, new top-level directories and your changes under `/etc`, `/usr`,
`/opt`, `/var`, `/root` and `/srv`. It never saves `/tmp` or `~/.cache`. A resume usually lands on a
new machine; only one within about ten minutes of the stop can get the parked machine back, with
`/tmp` and the running runtime intact. The launcher therefore points the runtime's cross-boot state
(`OPENINSPECT_STATE_DIR`, the harness session id and the repository manifest with the session-start
commits) at `/home/user/.openinspect/state`, so the agent's conversation and the Changes baseline
survive a resume either way. Files the agent writes under `/tmp` do not survive a resume on a new
machine, and tool caches under `~/.cache` are rebuilt there.

### Billing to an organization

When sandboxes are billed to a Boat organization (`boat_org`, or an organization set as the
account's active wallet), every member of the organization can see them, and a `shared` sandbox can
be used by every member: commands, files, ports. A session sandbox's env holds the sandbox auth
token and the user's secrets, so every create asks Boat for a private sandbox: session sandboxes,
image builds (see [Prebuilt Images](#prebuilt-images)) and the snapshot build's own sandboxes alike.
Boat sets the visibility before the sandbox has a machine, so it is never shared, not even for a
moment. A sandbox that still reports itself `shared` is made private
(`POST /sandboxes/{id}/unshare`) before it is used, and one that cannot be fails the spawn and is
deleted.

Personal accounts need nothing: their sandboxes are visible to the owner only.

## Snapshot Build

Boat sandboxes deploy from a **saved snapshot** that contains:

- the Open-Inspect sandbox runtime (`packages/sandbox-runtime`, reachable as `/app`)
- OpenCode and the OpenCode plugin dependencies
- Python 3.12 and Node 24 runtimes under `/opt/openinspect`
- `code-server`, `ttyd`, `agent-browser`, and the browser/desktop tooling used by the agent runtime
- GitHub CLI and a Git credential helper
- the launcher (`/home/user/openinspect/launcher.sh`) that starts the runtime on every boot

The snapshot is built by `packages/boat-infra/build-template.py` from the shared image bundle
([`packages/sandbox-images`](../packages/sandbox-images/README.md)): a build sandbox is created from
Boat's stock Ubuntu image with none of your account's secrets, the bundle is installed in it, its
disk is saved under the name, and a second sandbox deploys from that name to run the image
verification. There are two supported paths.

### Terraform-Managed Snapshot

This is the recommended path for a normal deployment. When `sandbox_provider = "boat"`, the
production `boat.tf` computes the build-input hash through the `sandbox-images` CLI, covering the
runtime, image package, Boat builder and Terraform module. It passes that hash to
`terraform/modules/boat-infra`, which builds a new snapshot under a new name on `terraform apply`
when those inputs change. The control-plane Worker switches to the new name only after the build has
verified it, then Terraform prunes superseded bases (see
[Base Snapshot Pruning](#base-snapshot-pruning)).

```bash
cd terraform/environments/production
terraform init
terraform apply
```

### Manual Snapshot

Use this path to build or test a snapshot before wiring it into Terraform:

```bash
cd packages/boat-infra
uv sync --frozen
export BOAT_API_KEY=boat_…
export BOAT_BASE_SNAPSHOT=open-inspect
uv run --frozen python build-template.py
```

Optional: `BOAT_API_URL`, `BOAT_ORG`, and `BOAT_BUILD_SANDBOX_TYPE` (default `default`; the machine
the image is installed on, which does not change the saved disk). Manual builds use
`<prefix>-<12 hex>-<timestamp>` names. The command prints `{"reference": "<snapshot name>"}`; set
that name as `BOAT_BASE_SNAPSHOT` on the control plane. See
[`packages/boat-infra/README.md`](../packages/boat-infra/README.md) for details.

A build uses two sandbox starts and keeps one saved snapshot. Boat includes a fixed number of saved
snapshots per account or organization wallet and bills each one beyond that; base snapshots and
prebuilt images share the allowance.

### Base Snapshot Pruning

After the control-plane Worker switches to the selected base, Terraform runs
`packages/boat-infra/prune-deployed-snapshots.py`. Changes to the selected snapshot name, Boat API
URL or organization trigger cleanup, even with an unchanged build hash; credentials alone do not. It
also runs on the first apply after the pruning resource is introduced, not on every unchanged apply.
If pruning fails, the Worker stays switched and the next apply retries cleanup. Switching away from
Boat does not delete base snapshots.

The wrapper reads Cloudflare's confirmed deployments and version bindings, verifies the expected
active deployment and desired Boat snapshot, and follows actual deployed base transitions, skipping
same-base redeploys. For `A -> B -> A -> C`, it retains `C` and `A`, not a newer undeployed
snapshot. It never infers the rollback base from snapshot `createdAt` values. Missing or
inconsistent history, split deployments, or a failed active-deployment recheck abort before any
deletion. If available history has no distinct predecessor (a new deployment or truncated history),
cleanup succeeds but skips pruning rather than guessing.

A provider, Boat API URL, organization or prefix change is a scope boundary: the old scope is
untouched and there is no rollback base in the new scope. When pruning proceeds, it retains at most
two applicable bases, not necessarily two on a first deployment or scope change. Only exact
`<prefix>-<16 lowercase hex>` names are candidates. The deployed base and any nonempty replaced base
must both be `ready` names under that prefix; otherwise pruning fails without deleting anything.
Pruning skips `saving` snapshots and deletes the remaining `ready` or `failed` candidates. Manual
names (`<prefix>-<12 hex>-<timestamp>`), prebuilt images, other names and snapshots under other or
longer prefixes are untouched.

The wrapper needs Cloudflare Workers Scripts: Read access; the existing Workers Scripts: Edit
deployment token is sufficient. Terraform supplies the token, account, Worker name and deployment ID
automatically, so no additional manual setup is needed.

Serialize deployments, direct Worker rollbacks and pruning. The wrapper rechecks the active
deployment after reading history, but cannot atomically lock Cloudflare and Boat.

For a manual preview, run `uv run --frozen python build-template.py prune --dry-run` from
`packages/boat-infra` with explicit `BOAT_DEPLOYED_SNAPSHOT` and `BOAT_REPLACED_SNAPSHOT` values
from Worker deployment history and credentials for the same prefix and wallet. Set the replaced
value empty only when you know there was no previous base in that scope, never to work around
missing history. A live-wallet dry run is required before manual deletion; omit `--dry-run` only
after confirming the selection. See the
[manual pruning procedure](../packages/boat-infra/README.md#prune-base-snapshots) for the required
environment variables.

At most one rollback base is retained. A Worker rollback across two or more base generations may
reference a deleted base; sessions without prebuilt images then fail to create until a deployment
rebuilds that name. Deleting a source base does not affect existing sandboxes or standalone prebuilt
repository and environment images.

## Runtime Behavior

The Boat provider creates fresh sandboxes from the saved snapshot, delivering env and starting the
runtime the same way Open-Inspect does on every other provider:

1. the sandbox is created with `noEnv` (none of the Boat account's own secrets or logins) and the
   per-sandbox env — `CONTROL_PLANE_URL`, `SESSION_CONFIG`, the sandbox auth token, user secrets —
   which Boat applies to every process the sandbox starts. The same request names the sandbox, makes
   it private, routes the enabled service ports (code-server, terminal, noVNC) and the configured
   tunnel ports to `https://<subdomain>-<port>.on.boat.dev` URLs, and carries a setup script that
   Boat runs as the sandbox user the moment the machine is up; the script waits for a launch marker,
   then execs the baked launcher
2. the control plane writes the tunnel URLs to `/workspace/.tunnels.env`, then the launch marker
   (`/tmp/openinspect-launch`), so the runtime starts neither before the sandbox is known private
   nor before its tunnel file exists. Boat holds a write to a sandbox that is still starting until
   the sandbox is ready, so the tunnel file lands in the workspace, which snapshots keep, while the
   marker, under `/tmp`, exists only for this machine's launch. A port the create could not route is
   hosted again with its own call
3. the launcher links `/workspace` and `/app` into the home directory, waits for the restored
   toolchain, takes a single-instance lock in `/tmp`, and execs the supervisor
   (`python -m sandbox_runtime.entrypoint`) with its output in
   `/home/user/.openinspect/supervisor.log`. The supervisor records a completed boot in
   `/home/user/.openinspect/boot-complete`; a later launch that finds that file boots in restored
   mode, one that does not boots fresh again. A resume starts the launcher again with a detached
   command, since the setup script runs only at create
4. the supervisor clones or syncs the selected repositories, starts OpenCode and code-server, and
   connects the Open-Inspect bridge back to the control plane; readiness is the bridge phoning home,
   and the shared connecting timeout fails the session otherwise

Machine size follows the session's sandbox settings: a `cpuCores`/`memoryMib` request selects the
smallest Boat size that satisfies it (`small` 2 vCPU/4 GB, `default` 4/8, `large` 8/16, `xlarge`
16/32; `xlarge` needs a Boat plan that offers it), and a session without a request uses
`boat_sandbox_type`. The sandbox lifetime (`sandboxTimeoutMs`, default 2 hours) becomes Boat's
auto-stop TTL, clamped to Boat's bounds of one second to thirty days.

Prebuilt repository and environment images are supported; see [Prebuilt images](#prebuilt-images).
All three harnesses run on Boat. Boat re-links its own coding agents, including a `codex`, under
`/usr/local/bin` at boot, so the Codex harness launches the image's pinned install under
`/opt/openinspect/codex`.

### Ports

Boat's own services hold ports 22, 6080, 8090, 8911 and 47984–48010 on every machine. A sandbox
setting that puts a service or tunnel on one of them is rejected at spawn time, and because 6080 is
noVNC's shared default, Boat sandboxes default the VNC port to **6081** instead.

### Access URLs

The three service ports carry their own authentication (code-server password, terminal token, VNC
password) and the web app embeds the terminal in an iframe, where Boat's access cookie would be a
blocked third-party cookie, so their routes are created as public hosted ports. User tunnel ports
stay behind Boat's token: their URLs carry a `_token` query parameter that a browser exchanges for a
cookie on the first visit. Treat a tunnel URL like a password.

## Prebuilt Images

Enabling prebuilds for a repository (Settings > Images) or an environment (Settings > Environments)
works as on every other provider ([IMAGE_PREBUILD.md](./IMAGE_PREBUILD.md)). On Boat:

- a build sandbox deploys from the base snapshot with only the boot markers in its env, on the
  machine size the scope's settings select. Once it is private and bound to the build, the control
  plane writes the build's env (repositories, clone token, scope secrets, callback contract) to a
  file under `/tmp`, which the launcher reads once and removes, and starts the launcher in
  image-build mode; the runtime clones the repositories, runs each `.openinspect/setup.sh` and
  reports back to the control plane
- finalization archives the build sandbox and saves its disk as a **saved snapshot** called
  `oi-img-<scope>-<digest>`, then deletes the build sandbox. The image is a standalone copy: it
  keeps deploying after its source is gone and never expires until the control plane deletes it
- a session with a ready image deploys from that name instead of the base snapshot, with its own env
  and a fresh boot; the runtime syncs the checkout and skips `setup.sh`

Every image counts toward the wallet's saved-snapshot allowance together with the deployed and
rollback base snapshots. Superseded images are deleted automatically, and Terraform prunes
superseded bases after switching the Worker (see [Base Snapshot Pruning](#base-snapshot-pruning)).
The [Boat prebuilds](./IMAGE_PREBUILD.md#boat-prebuilds) section covers the allowance, what a saved
snapshot keeps (`/tmp` and `~/.cache` are not saved), why the build's env never reaches the image,
and the runbook.

## Lifecycle: Stop and Resume

Open-Inspect drives the lifecycle through the shared lifecycle manager, treating a Boat stop as a
**resumable archive**:

- Idle sessions are **stopped** after the shared inactivity timeout (default 10 minutes): Boat
  snapshots the disk and releases the machine. The stop is confirmed only once Boat reports the
  sandbox archived with a snapshot available.
- Before the TTL lapses, the control plane drains the session and stops the sandbox itself; a
  sandbox that reaches its TTL is archived by Boat the same way.
- The next prompt **resumes** the archived sandbox on a new machine (or the same one within about
  ten minutes of the stop) and starts the runtime again. On the same machine the earlier runtime is
  still running, so the launcher finds its lock taken, exits at once, and that runtime carries on.
  The lock lives in `/tmp` because the first boot takes it while Boat's lazy restore still serves
  the home directory; once the disk has hydrated, a lock file there would be a different file that a
  second launcher could take as well. A sandbox whose earlier boot completed resumes in restored
  mode, so the checkout is kept and `setup.sh` does not run twice; one whose boot was interrupted
  before the harness came up boots fresh again. The hosted URLs stay the same across a stop and
  resume, and so do the code-server and VNC passwords: the control plane keeps the create-time
  credentials of a retained sandbox, so rotating `BOAT_API_KEY` does not lock existing sessions out.
- Boat keeps a stopped sandbox's disk for **14 days**. After that, and when Boat has lost the
  sandbox, the next prompt spawns a fresh sandbox instead.
- Only sandboxes that fail before becoming usable, or are being replaced, are **deleted**.

A stopped sandbox is not billed for machine time and does not count against Boat's concurrent
sandbox limit. Each create and resume counts as one Boat start against your plan's start limits; a
start refused with `429 rate_limited` fails the spawn transiently and is retried by the control
plane's normal recovery.

## Required Secrets

Terraform passes these provider-level values to the control plane:

- `BOAT_API_KEY` — used for the Boat REST API **and** the code-server/VNC password HMAC at create
  time, and to authenticate the snapshot build
- `BOAT_BASE_SNAPSHOT`
- `BOAT_API_URL`, `BOAT_ORG`, `BOAT_SANDBOX_TYPE` (optional)

`BOAT_API_KEY`, `BOAT_API_URL` and `BOAT_ORG` stay bound while `boat_api_key` is set, even after
`sandbox_provider` changes, so prebuilt images and build sandboxes recorded against Boat can still
be finalized and reclaimed; `BOAT_BASE_SNAPSHOT` and `BOAT_SANDBOX_TYPE` follow the active provider.

Model credentials are not among them: Boat sandboxes take every LLM API key from Open-Inspect's
secrets settings, so add `ANTHROPIC_API_KEY` there for Claude models and the equivalent key for any
other provider you use. The runtime also receives repository credentials from Open-Inspect for Git
operations. See [SECRETS.md](./SECRETS.md).

Secrets named like Boat's own variables (`ASCII_TOKEN`, `ASCII_API_URL`, `AGENT_ID`, `PRODUCT_MODE`,
`ENVIRONMENT_ID`, `BOAT_ID`, `SERVICE_PREVIEW_TOKEN`, `BOAT_CLI_TOKEN`) cannot be delivered to a
Boat sandbox and are dropped with a warning in the control-plane logs. Boat allows at most 100
variables and 64 KB of per-sandbox env; a session that exceeds either fails to spawn with a message
naming the limit.

## Verify

After `terraform apply`, verify:

1. The control plane is healthy:

   ```bash
   curl https://open-inspect-control-plane-<deployment_name>.<workers-subdomain>.workers.dev/health
   ```

2. The Boat dashboard (or `GET /saved-snapshots`) lists the Open-Inspect snapshot as `ready`.

3. Starting a session in the web app creates a Boat sandbox and reaches `Connected`.

4. Inside the session, ask a simple repo question such as:

   ```text
   tell me about this repository
   ```

If a session starts but never produces agent output, check the control-plane Worker logs for runtime
startup, bridge connection, and OpenCode health events. Session sandboxes are created with Boat
monitoring off, so Boat keeps no process output for them; the in-sandbox forensics file is
`/home/user/.openinspect/supervisor.log` (reachable via the session's code-server terminal while the
sandbox is alive, or through `boat exec`).

## Common Issues

### Snapshot Was Not Built

When `sandbox_provider = "boat"`, Terraform builds the snapshot during `terraform apply`, keyed on a
hash of the runtime, image package and builder sources. To force a rebuild, change a hashed source
file. For a manual build, set `BOAT_BASE_SNAPSHOT` on the control plane to the exact name the build
printed.

### Spawns Fail With `rate_limited` or `limit_reached`

Boat limits sandbox starts per minute, hour and day, and concurrent sandboxes, per plan. Stopped
sandboxes do not count as concurrent. Raise the plan or pace session creation.

### A Resumed Session Starts From a Fresh Checkout

Boat deletes a stopped sandbox's disk after 14 days. The control plane then spawns a fresh sandbox
for the next prompt; uncommitted work from before the stop is gone. Push or open a pull request
before leaving a session idle for that long.

### Missing Repository Access

Repository access still comes from the configured GitHub App installation. If the dashboard shows no
repositories or a sandbox cannot clone a repo, check the GitHub App installation permissions before
debugging Boat.

### LLM/API Key Problems

Boat sandboxes get every model credential from Open-Inspect's secrets settings. If OpenCode reports
a model or provider error, confirm the key for the selected model is saved at a scope the session
inherits, and that the model is available for that account.

## References

- [Boat API v1](https://docs.boat.dev/api/v1)
- [Boat snapshots: stop and resume](https://docs.boat.dev/snapshots/stop)
- [Boat saved snapshots](https://docs.boat.dev/snapshots/templates)
- [Boat public URLs](https://docs.boat.dev/hosting)
- [Boat limits and errors](https://docs.boat.dev/limits)
