# Amazon EC2 Sandbox Provider Setup

This guide provides instructions for setting up the Amazon EC2 sandbox provider for Open-Inspect.

## 1. Prepare the Amazon Machine Image (AMI)

The EC2 provider expects an AMI with all necessary tools pre-installed. The launcher will only
provide dynamic configuration via `UserData`.

### Required Packages

Install the following on your base image (e.g., Ubuntu 22.04):

- `cloudflared` (Cloudflare Tunnel client)
- `node` (version 20+)
- `git`
- `docker` (optional, if your agent needs it)
- `opencode` (The coding agent server)
- Python 3.12+ (for the bridge and supervisor)

### Open-Inspect Components

The AMI must contain the sandbox supervisor and bridge code from
`packages/modal-infra/src/sandbox/`.

1.  Copy the `packages/modal-infra/src/sandbox/` directory to
    `/usr/local/lib/python3.12/dist-packages/sandbox/` (or equivalent).
2.  Install Python dependencies: `httpx`, `structlog`, `websockets`.

### Directory Structure

Create the following directories with appropriate permissions:

- `/etc/cloudflared/` (for tunnel configuration)
- `/etc/opencode/` (for environment variables)

### Systemd Units

#### Cloudflare Tunnel (`/etc/systemd/system/cloudflared.service`)

Configure `cloudflared` to read the token from `/etc/cloudflared/token`.

```ini
[Unit]
Description=Cloudflare Tunnel
After=network.target

[Service]
ExecStart=/usr/local/bin/cloudflared tunnel --no-autoupdate run --token-file /etc/cloudflared/token
Restart=always
User=root

[Install]
WantedBy=multi-user.target
```

#### Sandbox Supervisor (`/etc/systemd/system/sandbox-supervisor.service`)

The supervisor manages the lifecycle of the OpenCode server and the agent bridge.

```ini
[Unit]
Description=Open-Inspect Sandbox Supervisor
After=network.target cloudflared.service

[Service]
EnvironmentFile=/etc/opencode/env
# Run the supervisor module
ExecStart=/usr/bin/python3 -m sandbox.entrypoint
Restart=always
User=ubuntu
WorkingDirectory=/home/ubuntu
# Ensure workspace directory exists
ExecStartPre=/usr/bin/mkdir -p /workspace
ExecStartPre=/usr/bin/chown ubuntu:ubuntu /workspace

[Install]
WantedBy=multi-user.target
```

## 2. Terraform Configuration

Set the following variables in your `terraform.tfvars` or environment:

### AWS Credentials

- `aws_access_key_id`: Your AWS Access Key ID.
- `aws_secret_access_key`: Your AWS Secret Access Key.
- `aws_region`: The region where instances will be launched (e.g., `us-east-1`).
- `ec2_ami_id`: The ID of the AMI you prepared in Step 1.

### Cloudflare Credentials (for the Deployer)

- `cloudflare_api_token_ec2`: A Cloudflare API token with "Cloudflare Tunnel" read/write permissions
  for your account.
- `cloudflare_tunnel_secret_ec2`: A random string used as the secret for all created tunnels.

### Security

- `ec2_api_secret`: A random hex string (32 chars) for authenticating the control plane to the EC2
  deployer worker.

## 3. How it Works

1.  **Deployment**: When a session starts with `sandboxProvider: "ec2"`, the control plane calls the
    EC2 Deployer Worker.
2.  **Orchestration**: The worker creates a unique Cloudflare Tunnel and launches an EC2 instance
    using the provided AMI and dynamic `UserData`.
3.  **Bootstrapping**: The `UserData` writes the tunnel token to `/etc/cloudflared/token` and
    session details to `/etc/opencode/env`, then restarts the supervisor service.
4.  **Supervisor**: The supervisor (`sandbox.entrypoint`) handles git cloning/syncing, starts the
    OpenCode server, and then starts the bridge (`sandbox.bridge`).
5.  **Connectivity**: `cloudflared` connects to Cloudflare, and the bridge connects back to the
    control plane WebSocket through the tunnel.
6.  **Lifecycle**:
    - **Activity**: If the session goes inactive, the instance is stopped (power off) to save costs.
      It is started again when activity resumes.
    - **Cleanup**: After 24 hours (or on session completion), the instance is terminated and the
      Cloudflare Tunnel is deleted.
