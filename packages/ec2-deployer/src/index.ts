/**
 * EC2 Deployer Worker
 *
 * A Cloudflare Worker that manages the lifecycle of Amazon EC2 instances
 * for Open-Inspect sandboxes.
 */

import { DurableObject } from "cloudflare:workers";
import { AwsClient } from "aws4fetch";
import crypto from "node:crypto";

export interface Env {
  EC2_INSTANCE: DurableObjectNamespace;
  EC2_API_SECRET: string;
  AWS_ACCESS_KEY_ID: string;
  AWS_SECRET_ACCESS_KEY: string;
  AWS_REGION: string;
  EC2_AMI_ID: string;
  CLOUDFLARE_ACCOUNT_ID: string;
  CLOUDFLARE_API_TOKEN: string;
  CLOUDFLARE_TUNNEL_SECRET: string;
}

/**
 * Worker entry point.
 */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Health check
    if (url.pathname === "/health") {
      return Response.json({ status: "ok", service: "open-inspect-ec2-deployer" });
    }

    // Verify token
    const authHeader = request.headers.get("Authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return new Response("Unauthorized", { status: 401 });
    }

    const token = authHeader.slice(7);
    const isValid = await verifyToken(token, env.EC2_API_SECRET);
    if (!isValid) {
      return new Response("Unauthorized", { status: 401 });
    }

    if (url.pathname === "/deploy" && request.method === "POST") {
      const body = await request.json() as any;
      const id = env.EC2_INSTANCE.idFromName(body.sandboxId);
      const stub = env.EC2_INSTANCE.get(id);
      return stub.fetch(request);
    }

    if ((url.pathname === "/stop" || url.pathname === "/start" || url.pathname === "/delete") && request.method === "POST") {
      const body = await request.json() as any;
      const id = env.EC2_INSTANCE.idFromString(body.providerObjectId);
      const stub = env.EC2_INSTANCE.get(id);
      return stub.fetch(request);
    }

    return new Response("Not Found", { status: 404 });
  },
};

/**
 * Verify HMAC-authenticated token.
 */
async function verifyToken(token: string, secret: string): Promise<boolean> {
  const dotIndex = token.indexOf(".");
  if (dotIndex === -1) return false;

  const timestampPart = token.slice(0, dotIndex);
  const signature = token.slice(dotIndex + 1);

  const timestamp = parseInt(timestampPart, 10);
  if (isNaN(timestamp) || Math.abs(Date.now() - timestamp) > 5 * 60 * 1000) {
    return false;
  }

  const expected = crypto.createHmac("sha256", secret).update(timestampPart).digest("hex");
  return signature === expected;
}

/**
 * EC2 Instance Durable Object
 *
 * Manages the state and lifecycle of a single EC2 instance and its Cloudflare Tunnel.
 */
export class EC2InstanceDO extends DurableObject<Env> {
  private instanceId: string | null = null;
  private tunnelId: string | null = null;
  private tunnelToken: string | null = null;
  private status: string = "pending";
  private createdAt: number = 0;
  private aws: AwsClient;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.aws = new AwsClient({
      accessKeyId: env.AWS_ACCESS_KEY_ID,
      secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
      region: env.AWS_REGION,
      service: "ec2",
    });
    this.ctx.blockConcurrencyWhile(async () => {
      this.instanceId = await this.ctx.storage.get<string>("instanceId") || null;
      this.tunnelId = await this.ctx.storage.get<string>("tunnelId") || null;
      this.tunnelToken = await this.ctx.storage.get<string>("tunnelToken") || null;
      this.status = await this.ctx.storage.get<string>("status") || "pending";
      this.createdAt = await this.ctx.storage.get<number>("createdAt") || 0;
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/deploy") {
      return this.handleDeploy(request);
    }
    if (url.pathname === "/stop") {
      return this.handleStop();
    }
    if (url.pathname === "/start") {
      return this.handleStart();
    }
    if (url.pathname === "/delete") {
      return this.handleDelete();
    }

    return new Response("Not Found", { status: 404 });
  }

  private async handleDeploy(request: Request): Promise<Response> {
    if (this.instanceId) {
      return Response.json({
        success: true,
        sandboxId: (await request.json() as any).sandboxId,
        providerObjectId: this.ctx.id.toString(),
        status: this.status,
        createdAt: this.createdAt,
      });
    }

    const body = await request.json() as any;
    this.createdAt = Date.now();
    await this.ctx.storage.put("createdAt", this.createdAt);

    try {
      // 1. Create Cloudflare Tunnel
      const tunnelName = `sandbox-${body.sandboxId}`;
      const tunnelResult = await this.createCloudflareTunnel(tunnelName);
      this.tunnelId = tunnelResult.id;
      this.tunnelToken = tunnelResult.token;
      await this.ctx.storage.put("tunnelId", this.tunnelId);
      await this.ctx.storage.put("tunnelToken", this.tunnelToken);

      // 2. Launch EC2 Instance
      this.instanceId = await this.launchEC2Instance(body, this.tunnelToken!);
      await this.ctx.storage.put("instanceId", this.instanceId);

      this.status = "spawning";
      await this.ctx.storage.put("status", this.status);

      // 3. Wait for tunnel to come online
      await this.waitForTunnelOnline(this.tunnelId!);

      this.status = "running";
      await this.ctx.storage.put("status", this.status);

      // 4. Schedule 24-hour auto-teardown
      await this.ctx.storage.setAlarm(Date.now() + 24 * 60 * 60 * 1000);

      return Response.json({
        success: true,
        sandboxId: body.sandboxId,
        providerObjectId: this.ctx.id.toString(),
        status: this.status,
        createdAt: this.createdAt,
      });
    } catch (error: any) {
      return Response.json({
        success: false,
        error: error.message,
      }, { status: 500 });
    }
  }

  private async handleStop(): Promise<Response> {
    if (!this.instanceId) return Response.json({ success: false, error: "No instance" }, { status: 404 });
    await this.awsRequest("StopInstances", { InstanceId: [this.instanceId] });
    this.status = "stopped";
    await this.ctx.storage.put("status", this.status);
    return Response.json({ success: true });
  }

  private async handleStart(): Promise<Response> {
    if (!this.instanceId) return Response.json({ success: false, error: "No instance" }, { status: 404 });
    await this.awsRequest("StartInstances", { InstanceId: [this.instanceId] });
    this.status = "running";
    await this.ctx.storage.put("status", this.status);
    // After starting, wait for the tunnel to come back online
    await this.waitForTunnelOnline(this.tunnelId!);
    return Response.json({ success: true });
  }

  private async handleDelete(): Promise<Response> {
    await this.teardown();
    return Response.json({ success: true });
  }

  async alarm() {
    await this.teardown();
  }

  private async teardown() {
    if (this.instanceId) {
      await this.awsRequest("TerminateInstances", { InstanceId: [this.instanceId] });
    }
    if (this.tunnelId) {
      await this.deleteCloudflareTunnel(this.tunnelId);
    }
    await this.ctx.storage.deleteAll();
    this.instanceId = null;
    this.tunnelId = null;
    this.tunnelToken = null;
    this.status = "deleted";
  }

  private async launchEC2Instance(config: any, tunnelToken: string): Promise<string> {
    const userData = btoa(`#!/bin/bash
# Configure Cloudflare Tunnel
mkdir -p /etc/cloudflared
cat > /etc/cloudflared/config.yml <<EOF
tunnel: ${this.tunnelId}
credentials-file: /etc/cloudflared/credentials.json
ingress:
  - hostname: "*"
    service: http://localhost:3000
  - service: http_status:404
EOF

# Store the tunnel token for cloudflared
echo "${tunnelToken}" > /etc/cloudflared/token

# Create a systemd service for cloudflared if it doesn't use the token file by default
cat > /etc/systemd/system/cloudflared.service <<EOF
[Unit]
Description=Cloudflare Tunnel
After=network.target

[Service]
ExecStart=/usr/local/bin/cloudflared tunnel --no-autoupdate run --token ${tunnelToken}
Restart=always
User=root

[Install]
WantedBy=multi-user.target
EOF

# Configure OpenCode server environment
mkdir -p /etc/opencode
cat > /etc/opencode/env <<EOF
SANDBOX_ID=${config.sandboxId}
SESSION_ID=${config.sessionId}
CONTROL_PLANE_URL=${config.controlPlaneUrl}
SANDBOX_AUTH_TOKEN=${config.sandboxAuthToken}
LLM_PROVIDER=${config.provider}
LLM_MODEL=${config.model}
EOF

# Start services
systemctl daemon-reload
systemctl enable cloudflared
systemctl start cloudflared
systemctl enable opencode-server
systemctl start opencode-server
`);

    const result = await this.awsRequest("RunInstances", {
      ImageId: this.env.EC2_AMI_ID,
      InstanceType: "t3.medium",
      MinCount: "1",
      MaxCount: "1",
      UserData: userData,
      TagSpecification: [
        {
          ResourceType: "instance",
          Tag: [
            { Key: "Name", Value: `open-inspect-sandbox-${config.sandboxId}` },
            { Key: "OpenInspectSandboxId", Value: config.sandboxId }
          ]
        }
      ]
    });

    const instanceId = result?.instancesSet?.item?.instanceId;
    if (!instanceId) throw new Error(`Failed to launch EC2 instance: ${JSON.stringify(result)}`);
    return instanceId;
  }

  private async createCloudflareTunnel(name: string): Promise<{ id: string, token: string }> {
    const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${this.env.CLOUDFLARE_ACCOUNT_ID}/tunnels`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${this.env.CLOUDFLARE_API_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name, tunnel_secret: this.env.CLOUDFLARE_TUNNEL_SECRET }),
    });
    const result = await response.json() as any;
    if (!result.success) throw new Error(`CF Tunnel creation failed: ${JSON.stringify(result.errors)}`);

    const tunnelId = result.result.id;
    const token = btoa(JSON.stringify({
      a: this.env.CLOUDFLARE_ACCOUNT_ID,
      t: tunnelId,
      s: this.env.CLOUDFLARE_TUNNEL_SECRET,
    }));

    return { id: tunnelId, token };
  }

  private async deleteCloudflareTunnel(tunnelId: string) {
    await fetch(`https://api.cloudflare.com/client/v4/accounts/${this.env.CLOUDFLARE_ACCOUNT_ID}/tunnels/${tunnelId}`, {
      method: "DELETE",
      headers: {
        "Authorization": `Bearer ${this.env.CLOUDFLARE_API_TOKEN}`,
      },
    });
  }

  private async waitForTunnelOnline(tunnelId: string) {
    for (let i = 0; i < 60; i++) {
      const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${this.env.CLOUDFLARE_ACCOUNT_ID}/tunnels/${tunnelId}/connections`, {
        headers: { "Authorization": `Bearer ${this.env.CLOUDFLARE_API_TOKEN}` },
      });
      const result = await response.json() as any;
      if (result.success && result.result && result.result.length > 0) return;
      await new Promise(r => setTimeout(r, 5000));
    }
    throw new Error("Timeout waiting for tunnel to come online");
  }

  private async awsRequest(action: string, params: Record<string, any>): Promise<any> {
    const url = new URL(`https://ec2.${this.env.AWS_REGION}.amazonaws.com/`);
    url.searchParams.set("Action", action);
    url.searchParams.set("Version", "2016-11-15");

    // Flatten params for Query API
    this.flattenParams(params).forEach(([key, value]) => {
      url.searchParams.set(key, value);
    });

    const response = await this.aws.fetch(url.toString());
    const text = await response.text();

    if (!response.ok) {
      throw new Error(`AWS API error (${action}): ${response.status} ${text}`);
    }

    // Simplified XML to JSON parsing (only for the fields we need)
    return this.parseXml(text);
  }

  private flattenParams(params: any, prefix = ""): [string, string][] {
    let result: [string, string][] = [];
    for (const [key, value] of Object.entries(params)) {
      const fullKey = prefix ? `${prefix}.${key}` : key;
      if (Array.isArray(value)) {
        value.forEach((v, i) => {
          if (typeof v === "object") {
            result = result.concat(this.flattenParams(v, `${fullKey}.${i + 1}`));
          } else {
            result.push([`${fullKey}.${i + 1}`, String(v)]);
          }
        });
      } else if (typeof value === "object") {
        result = result.concat(this.flattenParams(value, fullKey));
      } else {
        result.push([fullKey, String(value)]);
      }
    }
    return result;
  }

  private parseXml(xml: string): any {
    const res: any = {};
    const matchInstanceId = xml.match(/<instanceId>(.*?)<\/instanceId>/);
    if (matchInstanceId) {
      res.instancesSet = { item: { instanceId: matchInstanceId[1] } };
    }
    return res;
  }
}
