/**
 * EC2 Deployer Worker
 *
 * A Cloudflare Worker that manages the lifecycle of Amazon EC2 instances
 * for Open-Inspect sandboxes.
 */

import { DurableObject } from "cloudflare:workers";
import { AwsClient } from "aws4fetch";

interface DeployBody {
  sandboxId: string;
  sessionId: string;
  controlPlaneUrl: string;
  sandboxAuthToken: string;
  provider: string;
  repoOwner: string;
  repoName: string;
  userEnvVars?: Record<string, string>;
  model: string;
}

interface ProviderObjectBody {
  providerObjectId: string;
}

interface CloudflareApiResponse<T> {
  success: boolean;
  result: T;
  errors: { code?: number; message: string }[];
}

interface ResultInfo {
  page: number;
  per_page: number;
  count: number;
  total_count: number;
}

interface TunnelInfo {
  id: string;
  name: string;
  created_at: string;
  deleted_at: string | null;
}

interface CloudflareListTunnelsResponse {
  success: boolean;
  result: TunnelInfo[];
  result_info: ResultInfo;
  errors: { code?: number; message: string }[];
}

interface AwsXmlResult {
  instancesSet?: { item: { instanceId: string } };
}

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
 * Periodically cleans up orphaned Cloudflare tunnels and their associated EC2 instances.
 */
async function cleanupOldResources(env: Env): Promise<void> {
  let page = 1;
  const perPage = 50;
  let hasMore = true;

  while (hasMore) {
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/tunnels?page=${page}&per_page=${perPage}`,
      {
        headers: {
          Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`,
          "Content-Type": "application/json",
        },
      }
    );

    if (!response.ok) {
      console.error(`Failed to list tunnels: ${response.status} ${await response.text()}`);
      break;
    }

    const data = (await response.json()) as CloudflareListTunnelsResponse;
    if (!data.success) {
      console.error(`Cloudflare API error listing tunnels: ${JSON.stringify(data.errors)}`);
      break;
    }

    const now = Date.now();
    for (const tunnel of data.result) {
      if (tunnel.deleted_at || !tunnel.name.startsWith("sandbox-")) continue;

      const createdAt = new Date(tunnel.created_at).getTime();
      const ageMs = now - createdAt;

      // If older than 24 hours
      if (ageMs > 24 * 60 * 60 * 1000) {
        const sandboxId = tunnel.name.slice("sandbox-".length);
        const id = env.EC2_INSTANCE.idFromName(sandboxId);
        const stub = env.EC2_INSTANCE.get(id);

        try {
          // Trigger the DO's teardown which terminates EC2 and deletes tunnel
          await stub.fetch("https://worker.local/delete", { method: "POST" });
          console.log(`Cleaned up orphaned tunnel/sandbox: ${tunnel.name}`);
        } catch (err) {
          console.error(`Failed to trigger cleanup for sandbox ${sandboxId}: ${err}`);
        }
      }
    }

    const { total_count, page: currentPage, per_page } = data.result_info;
    hasMore = currentPage * per_page < total_count;
    page++;
  }
}

/**
 * Worker entry point.
 */
export default {
  // Reference so bundler does not tree-shake EC2InstanceDO (Cloudflare needs the named export)
  get EC2InstanceDO() {
    return EC2InstanceDO;
  },
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
      // Parse from a clone so we can forward the original (single-use) body to the DO
      const body = (await request.clone().json()) as DeployBody;
      const id = env.EC2_INSTANCE.idFromName(body.sandboxId);
      const stub = env.EC2_INSTANCE.get(id);
      return stub.fetch(request);
    }

    if (
      (url.pathname === "/stop" || url.pathname === "/start" || url.pathname === "/delete") &&
      request.method === "POST"
    ) {
      // Parse from a clone so we can forward the original (single-use) body to the DO
      const body = (await request.clone().json()) as ProviderObjectBody;
      const id = env.EC2_INSTANCE.idFromString(body.providerObjectId);
      const stub = env.EC2_INSTANCE.get(id);
      return stub.fetch(request);
    }

    return new Response("Not Found", { status: 404 });
  },

  async scheduled(_event: ScheduledEvent, env: Env): Promise<void> {
    await cleanupOldResources(env);
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

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(timestampPart));
  const expected = Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
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
      this.instanceId = (await this.ctx.storage.get<string>("instanceId")) || null;
      this.tunnelId = (await this.ctx.storage.get<string>("tunnelId")) || null;
      this.tunnelToken = (await this.ctx.storage.get<string>("tunnelToken")) || null;
      this.status = (await this.ctx.storage.get<string>("status")) || "pending";
      this.createdAt = (await this.ctx.storage.get<number>("createdAt")) || 0;
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
        sandboxId: ((await request.json()) as DeployBody).sandboxId,
        providerObjectId: this.ctx.id.toString(),
        status: this.status,
        createdAt: this.createdAt,
      });
    }

    const body = (await request.json()) as DeployBody;
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
    } catch (error: unknown) {
      // If deployment fails halfway, clean up any partially created resources
      await this.teardown();
      return Response.json(
        {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        },
        { status: 500 }
      );
    }
  }

  private async handleStop(): Promise<Response> {
    if (!this.instanceId)
      return Response.json({ success: false, error: "No instance" }, { status: 404 });
    await this.awsRequest("StopInstances", { InstanceId: [this.instanceId] });
    this.status = "stopped";
    await this.ctx.storage.put("status", this.status);
    return Response.json({ success: true });
  }

  private async handleStart(): Promise<Response> {
    if (!this.instanceId)
      return Response.json({ success: false, error: "No instance" }, { status: 404 });
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

  private async launchEC2Instance(config: DeployBody, tunnelToken: string): Promise<string> {
    // Only includes dynamic configuration that cannot be baked into the AMI.
    const userData = btoa(`#!/bin/bash
# Write dynamic Cloudflare Tunnel token
# sudo cloudflared service install "${tunnelToken}"

# Write dynamic environment for OpenCode server
cat > /etc/opencode/env <<EOF
PATH="/home/ubuntu/.nvm/versions/node/v22.19.0/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/usr/games:/usr/local/games:/snap/bin"
SANDBOX_ID=${config.sandboxId}
SESSION_ID=${config.sessionId}
CONTROL_PLANE_URL=${config.controlPlaneUrl}
SANDBOX_AUTH_TOKEN=${config.sandboxAuthToken}
LLM_PROVIDER=${config.provider}
LLM_MODEL=${config.model}
REPO_OWNER=${config.repoOwner}
REPO_NAME=${config.repoName}
VCS_CLONE_TOKEN=${config.userEnvVars?.["VCS_CLONE_TOKEN"] || config.userEnvVars?.["GITHUB_APP_TOKEN"] || config.userEnvVars?.["GITHUB_TOKEN"] || ""}
ANTHROPIC_API_KEY=${config.userEnvVars?.["ANTHROPIC_API_KEY"] || ""}
EOF

# Trigger start-up of baked services
#systemctl restart cloudflared
systemctl restart sandbox-supervisor
`);

    const result = await this.awsRequest("RunInstances", {
      ImageId: this.env.EC2_AMI_ID,
      InstanceType: "t4g.2xlarge",
      MinCount: "1",
      MaxCount: "1",
      KeyName: "development-am",
      "SecurityGroupId.1": "sg-064453e70f4d22ea9",
      UserData: userData,
      InstanceMarketOptions: {
        MarketType: "spot",
      },
      TagSpecification: [
        {
          ResourceType: "instance",
          Tag: [
            { Key: "Name", Value: `open-inspect-sandbox-${config.sandboxId}` },
            { Key: "OpenInspectSandboxId", Value: config.sandboxId },
          ],
        },
      ],
    });

    const instanceId = result?.instancesSet?.item?.instanceId;
    if (!instanceId) throw new Error(`Failed to launch EC2 instance: ${JSON.stringify(result)}`);
    return instanceId;
  }

  private async createCloudflareTunnel(name: string): Promise<{ id: string; token: string }> {
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${this.env.CLOUDFLARE_ACCOUNT_ID}/tunnels`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.env.CLOUDFLARE_API_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ name, tunnel_secret: this.env.CLOUDFLARE_TUNNEL_SECRET }),
      }
    );
    const result = (await response.json()) as CloudflareApiResponse<{ id: string }>;
    if (!result.success) {
      const authError = result.errors?.some(
        (e) => e.code === 10000 || /authentication/i.test(e.message ?? "")
      );
      if (authError) {
        throw new Error(
          "CF Tunnel creation failed: Cloudflare API authentication error. " +
            "Verify CLOUDFLARE_API_TOKEN (EC2 deployer token with Tunnel read/write) and CLOUDFLARE_ACCOUNT_ID. " +
            `Details: ${JSON.stringify(result.errors)}`
        );
      }
      throw new Error(`CF Tunnel creation failed: ${JSON.stringify(result.errors)}`);
    }

    const tunnelId = result.result.id;
    const token = btoa(
      JSON.stringify({
        a: this.env.CLOUDFLARE_ACCOUNT_ID,
        t: tunnelId,
        s: this.env.CLOUDFLARE_TUNNEL_SECRET,
      })
    );

    return { id: tunnelId, token };
  }

  private async deleteCloudflareTunnel(tunnelId: string) {
    await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${this.env.CLOUDFLARE_ACCOUNT_ID}/tunnels/${tunnelId}`,
      {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${this.env.CLOUDFLARE_API_TOKEN}`,
        },
      }
    );
  }

  private async waitForTunnelOnline(tunnelId: string) {
    for (let i = 0; i < 60; i++) {
      const response = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${this.env.CLOUDFLARE_ACCOUNT_ID}/tunnels/${tunnelId}/connections`,
        {
          headers: { Authorization: `Bearer ${this.env.CLOUDFLARE_API_TOKEN}` },
        }
      );
      const result = (await response.json()) as CloudflareApiResponse<unknown[]>;
      if (result.success && result.result && result.result.length > 0) return;
      await new Promise((r) => setTimeout(r, 5000));
    }
    throw new Error("Timeout waiting for tunnel to come online");
  }

  private async awsRequest(action: string, params: Record<string, unknown>): Promise<AwsXmlResult> {
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

  private flattenParams(params: Record<string, unknown>, prefix = ""): [string, string][] {
    let result: [string, string][] = [];
    for (const [key, value] of Object.entries(params)) {
      const fullKey = prefix ? `${prefix}.${key}` : key;
      if (Array.isArray(value)) {
        value.forEach((v: unknown, i) => {
          if (typeof v === "object" && v !== null) {
            result = result.concat(
              this.flattenParams(v as Record<string, unknown>, `${fullKey}.${i + 1}`)
            );
          } else {
            result.push([`${fullKey}.${i + 1}`, String(v)]);
          }
        });
      } else if (typeof value === "object" && value !== null) {
        result = result.concat(this.flattenParams(value as Record<string, unknown>, fullKey));
      } else {
        result.push([fullKey, String(value)]);
      }
    }
    return result;
  }

  private parseXml(xml: string): AwsXmlResult {
    const res: AwsXmlResult = {};
    const matchInstanceId = xml.match(/<instanceId>(.*?)<\/instanceId>/);
    if (matchInstanceId) {
      res.instancesSet = { item: { instanceId: matchInstanceId[1] } };
    }
    return res;
  }
}
