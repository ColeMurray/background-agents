# Amazon EC2 Sandbox Provider Setup

This guide provides instructions for setting up the Amazon EC2 sandbox provider for Open-Inspect.

## 1. Prepare the Amazon Machine Image (AMI)

The EC2 provider expects an AMI with all necessary tools pre-installed. The launcher will only provide dynamic configuration via `UserData`.

### Required Packages
Install the following on your base image (e.g., Ubuntu 22.04):
- `cloudflared` (Cloudflare Tunnel client)
- `node` (version 20+)
- `git`
- `docker` (optional, if your agent needs it)
- OpenCode server (the bridge application)

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

#### OpenCode Server (`/etc/systemd/system/opencode-server.service`)
Configure the server to load environment variables from `/etc/opencode/env`.

```ini
[Unit]
Description=OpenCode Server
After=network.target cloudflared.service

[Service]
EnvironmentFile=/etc/opencode/env
ExecStart=/usr/local/bin/opencode-server
Restart=always
User=ubuntu
WorkingDirectory=/home/ubuntu

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
- `cloudflare_api_token_ec2`: A Cloudflare API token with "Cloudflare Tunnel" read/write permissions for your account.
- `cloudflare_tunnel_secret_ec2`: A random string used as the secret for all created tunnels.

### Security
- `ec2_api_secret`: A random hex string (32 chars) for authenticating the control plane to the EC2 deployer worker.

## 3. How it Works

1.  **Deployment**: When a session starts with `sandboxProvider: "ec2"`, the control plane calls the EC2 Deployer Worker.
2.  **Orchestration**: The worker creates a unique Cloudflare Tunnel and launches an EC2 instance using the provided AMI and dynamic `UserData`.
3.  **Bootstrapping**: The `UserData` writes the tunnel token to `/etc/cloudflared/token` and session details to `/etc/opencode/env`, then restarts the services.
4.  **Connectivity**: `cloudflared` connects to Cloudflare, and the OpenCode bridge connects back to the control plane via the tunnel.
5.  **Lifecycle**:
    *   **Activity**: If the session goes inactive, the instance is stopped (power off) to save costs. It is started again when activity resumes.
    *   **Cleanup**: After 24 hours (or on session completion), the instance is terminated and the Cloudflare Tunnel is deleted.
