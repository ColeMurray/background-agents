# Docker in Modal Sandboxes

Modal sessions run on a gVisor sandbox by default. A session can opt into a Docker-capable Modal VM
instead, which boots the same runtime, harness, bridge, code-server and repository checkout on the
VM host and adds a supervised Docker daemon for user workloads: PostgreSQL, Redis, Compose stacks,
application containers. The harness never runs inside a user container.

```text
Modal VM sandbox
├── runtime supervisor, bridge, harness, code-server, terminal, /workspace
└── dockerd (owned by the supervisor, started before repository hooks)
    ├── user PostgreSQL container
    └── user application containers
```

This is a Modal-only launch variant selected by one sandbox setting. It is not a new provider and it
changes nothing for sessions that do not opt in.

## The setting

`dockerEnabled` is a sandbox setting like ports and timeouts, so it resolves through the same
layers: global default, repository override, environment override, then an optional one-off choice
when a session is created.

| Value   | Meaning                                                     |
| ------- | ----------------------------------------------------------- |
| omitted | Inherit from the layer below; the built-in default is off.  |
| `false` | Use the standard sandbox, even if a lower layer enabled it. |
| `true`  | Require the Docker-capable VM. A session never falls back.  |

Anything else, such as `null` or the string `"true"`, is rejected: a malformed Docker choice fails
settings writes and session creation instead of being defaulted.

In the web app, **Settings → Sandbox** offers _Enabled_ / _Disabled_ at global scope and _Inherit_ /
_Enabled_ / _Disabled_ at repository and environment scope. The session composer adds a one-off
choice: configured sandbox, standard sandbox, or Docker. The API equivalent is
`dockerEnabled: true | false` on `POST /sessions`.

## What a Docker session gets

- `docker`, `docker build`, `docker run` and `docker compose` in the workspace, with a daemon that
  is ready before `.openinspect/setup.sh` and `.openinspect/start.sh` run.
- Frozen resources. The session persists the CPU and memory it launched with: the configured
  `cpuCores` / `memoryMib`, or 2 cores and 4096 MiB when none are set. Modal sizes VM memory at
  launch, so these do not change for the life of the session, and child sessions inherit them.
- Prepared images and snapshots of its own kind. Repository and environment prebuilds for a
  Docker-enabled scope are built on the Docker image; a default prebuild is never used for a Docker
  session, nor the reverse. A saved snapshot restores only into a session of the same kind.
- No new network surface. The Docker socket is not exposed, and a published container port is not a
  tunnel: add it to `tunnelPorts` like any other port.

Running containers do not survive a snapshot. Workspace files, pulled and built images and named
volumes do, so keep start hooks idempotent: a restored session recreates its stack from them.
Docker's bridge and Compose pools live in `10.200.0.0/24` and `10.201.0.0/16`; avoid overlapping
subnets in your own Compose files.

## Operator enablement

Two Terraform variables control the feature, and they are deliberately separate.

| Variable                       | Effect                                                                                                                        |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| `provision_modal_vm_sandboxes` | Build, verify and deploy the Docker-capable Modal image next to the default one. The app then serves Docker-enabled sessions. |
| `enable_modal_vm_sandboxes`    | Admit new Docker-enabled sessions, children and image builds. Requires provisioning. Sets `ENABLE_MODAL_VM_SANDBOXES`.        |

Roll out in this order:

1. Deploy this release with both variables off. Every service now understands `dockerEnabled` and
   refuses it cleanly.
2. Set `provision_modal_vm_sandboxes = true`. The next Modal deploy builds the default image,
   publishes its reference, then builds the Docker variant and verifies it on the VM runtime: the
   standard smoke suite plus a real daemon start, `docker buildx build`, `docker run` and a Compose
   network, all without a registry. A failed Docker build never replaces the verified default image.
   Manually, that is `BUILD_MODAL_VM_IMAGE=true uv run python deploy.py --build-sandbox-image` from
   `packages/modal-infra`.
3. Set `enable_modal_vm_sandboxes = true` and enable the setting for a small set of repositories or
   environments first.

To roll back, close admission only: set `enable_modal_vm_sandboxes = false` and leave provisioning
on. Sessions that were already admitted keep restoring their snapshots and are cleaned up normally;
new Docker requests get a `docker_not_available` error. Do not turn provisioning off, roll back to a
release that ignores `dockerEnabled`, or move to another sandbox provider while Docker sessions
exist: such a session is refused rather than silently relaunched on the wrong runtime.

Admission errors on session creation are stable codes: `docker_not_allowed` (the sandbox provider is
not Modal), `docker_not_available` (admission is closed), and `invalid_sandbox_settings` (a
malformed stored Docker choice).

## How it fits together

- The control plane freezes the effective `dockerEnabled`, CPU and memory into the session's
  persisted sandbox settings at creation; later settings changes never move an existing session.
- The Modal provider translates that boolean into the Docker image, Modal's VM runtime option and a
  reserved runtime variable, `OPENINSPECT_DOCKER_ENABLED`, which user environment variables cannot
  set. A Modal deployment that predates the setting reports no Docker launch, and the control plane
  stops that sandbox and fails the session instead of continuing without Docker.
- Docker VM launches are named after the session generation, so a create whose response was lost is
  adopted on retry rather than duplicated, and a predecessor VM the control plane never learned the
  id of is retired before its successor starts.
- The runtime supervisor starts `dockerd` before repository hooks, treats an unexpected daemon exit
  as fatal, stops it cleanly before an image build reports success, and stops it last on shutdown.
  The daemon logs to `/var/log/dockerd.log` inside the sandbox.
