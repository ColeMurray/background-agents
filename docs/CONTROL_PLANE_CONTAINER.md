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

   Every variable is documented in place. The three encryption keys are generated with
   `openssl rand -base64 32`. Generate a MinIO root password with `openssl rand -hex 16` and set it
   as `MINIO_ROOT_PASSWORD`, `AWS_SECRET_ACCESS_KEY` and `LITESTREAM_SECRET_ACCESS_KEY`; the stack
   refuses to start without it. The other MinIO and Litestream defaults work as they are.

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
- `host-alarms.db`: the index of every session's next scheduled deadline.

These three are one deployment's state, and the unit of a deployment backup is the whole volume:
stop the app, snapshot the volume (an EBS snapshot on AWS), start it again. That procedure and its
rehearsal are tracked separately from this stack.

What this stack provides is narrower. Litestream replicates `global.db` continuously to
`LITESTREAM_BUCKET`, and when the app starts on an empty volume and a replica exists, its entrypoint
restores `global.db` before the host boots. That brings back users, settings and the session index.
It does not bring back the session files or the alarm index: the restored index lists sessions whose
files are gone, and the host opens each of those as an empty session when it is next touched, with
no pending deadlines. The entrypoint logs a warning to that effect after every restore. Treat the
replica as protection for the global store, not as recovery of a deployment.

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

## Not yet available on the container

- Repository image builds: the finalization step needs the jobs queue, which has no container
  implementation yet. Sessions start from the base sandbox image.
- The GitHub autofix queue and the Slack and Linear bots: the bots remain Cloudflare Workers and
  reach a container-hosted control plane over HTTPS once that transport lands.
- Crash recovery of scheduled deadlines after an unclean stop.

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
