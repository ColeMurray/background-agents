# Running the Control Plane in a Container

The control plane runs on Cloudflare Workers in the deployment described in
[GETTING_STARTED.md](./GETTING_STARTED.md). It also runs as one Node process on a container, with
SQLite files on a volume in place of Durable Objects and D1, and an S3-compatible bucket in place of
R2. This is how it runs on AWS, and `docker compose up` is the local stand-in for that instance.

The same application code serves both platforms. Sessions, routes, authentication and the sandbox
providers behave the same; only the platform adapters differ.

## What the stack contains

| Service      | Image                   | Role                                                                                  |
| ------------ | ----------------------- | ------------------------------------------------------------------------------------- |
| `app`        | built from this repo    | The control plane: HTTP API, session WebSockets, cron jobs. Port 8787.                |
| `minio`      | `minio/minio`           | S3-compatible object storage for media and backups. Console on port 9001.             |
| `minio-init` | `minio/mc`              | Creates the `media` and `backups` buckets, then exits.                                |
| `litestream` | `litestream/litestream` | Replicates the global store (`/data/global.db`) to the `backups` bucket every second. |
| `caddy`      | `caddy` (profile `tls`) | Optional TLS termination for a public hostname.                                       |

The web app is not part of the stack. It stays on Vercel in production and runs with `next dev`
locally, pointed at the container (see below).

## Quick start

Prerequisites: Docker with Compose v2, a GitHub App and OAuth app as in
[GETTING_STARTED.md](./GETTING_STARTED.md), and a sandbox provider (Modal by default).

1. Create the configuration file and fill it in:

   ```bash
   cp .env.example .env
   ```

   Every variable is documented in place, and every value a boot cannot do without either ships with
   a working default or is listed here. Generate the three encryption keys — `TOKEN_ENCRYPTION_KEY`,
   `PROVIDER_ACCOUNTS_ENCRYPTION_KEY` and `REPO_SECRETS_ENCRYPTION_KEY` — with
   `openssl rand -base64 32` each. Generate a MinIO root password with `openssl rand -hex 16` and
   set it as `MINIO_ROOT_PASSWORD`, `AWS_SECRET_ACCESS_KEY` and `LITESTREAM_SECRET_ACCESS_KEY`; the
   stack refuses to start without it. The other MinIO and Litestream defaults work as they are.

   The rest of the file boots as shipped. A GitHub App, an OAuth app and a sandbox provider are what
   the stack needs to do anything useful, but their variables are read at use rather than at boot,
   so fill them in when you connect each one.

2. Build and start:

   ```bash
   docker compose up --build
   ```

3. Check it is up:

   ```bash
   curl -s http://localhost:8787/healthz
   ```

   The response reports the migrations applied, the resident sessions, and the state of the cron
   loop and alarm clock. Litestream logs `snapshot written` once the first snapshot is in the
   `backups` bucket; the MinIO console at http://127.0.0.1:9001 shows both buckets.

The app's port and MinIO's ports are published on loopback only. `APP_BIND_ADDRESS` in `.env` moves
the app's port to another interface where something in front of the host restricts access, such as a
security group on AWS. Only the app reads `.env`; the sidecars receive the few variables they need
by name, never the app's secrets.

Stop with `docker compose down`. The data volume survives; `docker compose down -v` deletes it.
Compose gives the app 40 seconds to drain before killing it, which covers the host's 30-second
shutdown budget and the 5 seconds it keeps before forcing its own exit; both values are pinned in
`docker-compose.yml` so a `.env` edit cannot separate them.

## Connecting the web app

In `packages/web/.env.local`:

```bash
CONTROL_PLANE_URL=http://localhost:8787
NEXT_PUBLIC_WS_URL=ws://localhost:8787
SERVICE_AUTH_SECRET=<the SERVICE_AUTH_SECRET_WEB value from .env>
```

Then `npm run dev -w @open-inspect/web`. The container's `WEB_APP_URL` must be the web app's origin
(`http://localhost:3000` by default), because browser sign-in is origin-bound.

## Reaching the container from a sandbox

A sandbox connects back to the control plane over a WebSocket at `WORKER_URL`, so that URL has to be
reachable from the sandbox provider. On a laptop that means a tunnel (for example
`cloudflared tunnel --url http://localhost:8787`) and setting `WORKER_URL` to the tunnel's public
URL. The Modal deployment additionally refuses callbacks to hosts outside its
`ALLOWED_CONTROL_PLANE_HOSTS` list, so add the tunnel host there. Use a Modal environment that is
not serving a production control plane.

## Data, backups and restore

Everything the host persists is under `/data` on the `control-plane-data` volume:

- `global.db`: the global store (the tables D1 holds on Cloudflare).
- `sessions/<id>.db`: one file per session (the Durable Object storage on Cloudflare).
- `host-alarms.db`: the index of every session's next scheduled deadline, and the claim each
  deadline being delivered is leased under.
- `jobs.db`: background jobs waiting to run, leased to a delivery, or dead — what a Cloudflare Queue
  and its dead-letter queue hold on the other host.
- `host-state.json`: the marker that says whether the host stopped cleanly, and the time through
  which the alarm index is known to be complete. See "Recovering from an unclean stop".
- `cache.db`: the cache the host uses where Cloudflare uses KV. Alone among these, it is not
  deployment state — every entry is rebuilt by being used, so a file that cannot be opened is
  discarded and recreated rather than failing the boot.

All but the last are one deployment's state, and the unit of a deployment backup is the whole
volume: stop the app, snapshot the volume (an EBS snapshot on AWS), start it again. That procedure
and its rehearsal are tracked separately from this stack.

What this stack provides is narrower. Litestream replicates `global.db` continuously to
`LITESTREAM_BUCKET`, and when the app starts on an empty volume and a replica exists, its entrypoint
restores `global.db` before the host boots. That brings back users, settings and the session index.
It does not bring back the session files, the alarm index or the jobs table: the restored index
lists sessions whose files are gone, and the host opens each of those as an empty session when it is
next touched, with no pending deadlines. The entrypoint logs a warning to that effect after every
restore. Treat the replica as protection for the global store, not as recovery of a deployment.

`jobs.db` is left out of the replica for the same reason the alarm index is: what it holds is
reconstructible from what _is_ replicated. Every job the control plane produces today is an
image-build finalization, and the image-build scheduler republishes those from `global.db` on its
cron slot — a build still `building` with an accepted completion and no live lease. A future job
kind that cannot be rebuilt that way, such as a session callback, would have to revisit this.

`cache.db` is deliberately excluded from that replication: it holds the repositories listing and a
live GitHub installation token, neither of which belongs in a backup bucket, and a cache refills by
being used. A volume snapshot does capture it, so treat a snapshot as holding a credential and give
it the access policy you would give the database.

To rehearse the restore, remove the containers that hold the volume open, delete the volume (its
name is prefixed with the compose project name, the checkout's directory name by default), then
bring the whole stack back and confirm replication resumed:

```bash
docker compose rm -sf app litestream
docker volume rm "$(basename "$PWD")_control-plane-data"
docker compose up -d --wait
docker compose logs app | grep litestream.restore
docker compose logs litestream | grep "snapshot written"
```

## Recovering from an unclean stop

A `docker compose down`, a `docker compose up -d` that recreates the app, and a stopped instance all
end in `SIGTERM`, which the host drains: it stops accepting, finishes what is in flight, quiesces
every session, closes the files, and writes `host-state.json` saying the stop was clean. A kill, an
OOM, a power loss or a drain that ran out of budget writes no such marker, and the next boot has two
things to put right.

**Deadlines the index never recorded.** A session's scheduled wake-up is written twice: the session
core commits it to the session's own file and then arms the runtime alarm, which here is a row in
`host-alarms.db`. On Cloudflare both writes land in one Durable Object storage; here they are two
files, so a process that dies between them leaves a deadline the session knows about and the index
does not. The session would still fire it the next time anything touched it, but a session nobody
touches again would not. So a boot that finds no clean marker reads the session files written since
the last time the index was known complete, and arms each file's earliest deadline. That can only
bring a wake-up forward — it never postpones or replaces what the index already holds — and a
session file that cannot be read is logged and skipped rather than failing the boot. On a fresh
volume there are no session files and the scan costs nothing; on a volume written by a build that
predates the marker it is one full pass.

**Jobs the dead process was running.** A claim on a job is a lease, and a lease runs for fifteen
minutes. Waiting one out after every restart would leave a build finalization sitting for a quarter
of an hour, so starting the poller returns every claim no delivery in this process owns — a claim
belonging to a process that is gone — to pending at once. The attempt that process spent stays
spent, exactly as a queue counts a delivery however it ended, so a job whose handler takes the
process down with it still runs out of attempts and ends in the dead rows. A claim whose lease
simply ran out is a different thing, a handler that hung, and is still recovered on the sweep.

**Two processes at once.** Neither recovery guards against another live process holding the same
volume: a boot-time reclaim assumes the claims it finds belong to nobody. That assumption is the
deploy shape's, not the code's. Compose recreates the app container in place, and the new container
cannot start until the old one has released the volume; the AWS deploy replaces the instance the
same way. If that ever changes — two app containers behind a load balancer, a blue/green deploy that
overlaps the old and new instances, or anything else that lets two hosts open one data directory —
these recoveries stop being safe, and the claims would have to carry the boot id of the process that
holds them so a live one could be told from a dead one. Until then that column would only be a
column nothing reads.

## TLS

For a public hostname, set `CADDY_DOMAIN` in `.env`, point the DNS record at the host, open ports 80
and 443, and start with the profile:

```bash
docker compose --profile tls up -d
```

Caddy obtains the certificate and proxies HTTP and WebSocket traffic to the app over the compose
network, so `APP_BIND_ADDRESS` stays on loopback and the plaintext port is never reachable from
outside. `WORKER_URL` is then `https://<CADDY_DOMAIN>` and the web app's `NEXT_PUBLIC_WS_URL` is
`wss://<CADDY_DOMAIN>`.

## Configuration on AWS

On AWS the container reads the same `.env` variables from its environment. The deploy step
materializes them from SSM Parameter Store; nothing is baked into the image. With an instance role,
leave `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` empty and the SDK uses the role.

The instance runs this same stack with one overlay, `docker-compose.aws.yml`:

```bash
docker compose -f docker-compose.yml -f docker-compose.aws.yml up -d
```

It changes three things and nothing else. The app runs the image `CONTROL_PLANE_IMAGE` names — an
ordinary `.env` entry, written from SSM like the rest, so changing the tag is a `terraform apply`
and a restart rather than a new instance — rather than a build, because the instance has no
checkout. MinIO does not run, because S3 is the object store and Litestream's replica target. And
Caddy leaves the `tls` profile and starts with the rest, because TLS is not optional on a public
address.

`.env` still has to carry `MINIO_ROOT_PASSWORD`: Compose interpolates the base file before it
applies an overlay, so that variable's `:?` guard fires whether or not MinIO is among the services
that end up running. The AWS deployment gives it an unused value.

[docs/AWS_BRING_UP.md](AWS_BRING_UP.md) is the whole path from an empty account to `/healthz` over
HTTPS.

## The smoke test

CI boots this stack on every pull request and round-trips one session through it:

```bash
scripts/compose-smoke.sh
```

It runs under its own Compose project name and a temporary environment file, so it never touches
this checkout's `.env` or a development stack's containers and volumes. It builds the image, brings
the stack up with a stand-in for the Modal data plane, creates a session, sends a prompt, and waits
for that exact message's reply to arrive on a subscribed client socket. Then it checks what only a
booted container shows: migrations applied, the cron loop ticking, Litestream replicating, a clean
drain on SIGTERM, and a readable failure when a required key is blank.

The stand-in lives in `packages/control-plane/test/smoke/`. It answers the control plane's sandbox
endpoints, verifying the same HMAC token Modal verifies, then connects back over the compose network
and plays the bridge. Nothing reaches a cloud, so the smoke needs no credentials.

To run it beside a stack already holding the default ports, move its published ones:

```bash
SMOKE_APP_PORT=8798 SMOKE_MINIO_PORT=9010 SMOKE_MINIO_CONSOLE_PORT=9011 \
  SMOKE_FAKE_MODAL_PORT=9910 scripts/compose-smoke.sh
```

## Not yet available on the container

- Repository image builds: the finalization step is a background job (`src/jobs.ts`), and the jobs
  seam has no container implementation yet, so build triggers fail before registration or provider
  startup. Sessions start from the base sandbox image.
- The GitHub autofix queue and the Slack and Linear bots: the bots remain Cloudflare Workers and
  reach a container-hosted control plane over HTTPS once that transport lands.

## Building the image alone

```bash
docker build -f packages/control-plane/Dockerfile -t open-inspect-control-plane .
docker run --rm -p 127.0.0.1:8787:8787 --env-file .env -e LITESTREAM_BUCKET= \
  -v control-plane-data:/data open-inspect-control-plane
```

`LITESTREAM_BUCKET=` turns the restore-on-empty step off: outside the compose network there is no
`minio` host, and the entrypoint would otherwise try to reach it before the host boots. Point
`LITESTREAM_ENDPOINT` at a reachable bucket instead to keep the restore. The entrypoint refuses a
plain-`http://` endpoint unless `OBJECT_STORE_ALLOW_HTTP=true`, the same opt-in the host applies to
its own object store, and removes a stray `global.db-wal` or `-shm` left without its database so it
cannot be replayed over the restored or new file.

The build runs from the repository root so that `packages/shared` and the D1 migrations are in the
context. The runtime image contains the bundled host, the migrations and the `litestream` binary; no
`node_modules`.
