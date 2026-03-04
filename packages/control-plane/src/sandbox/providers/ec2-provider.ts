/**
 * EC2 sandbox provider implementation.
 *
 * Deploys sandbox environments as Amazon EC2 instances.
 * Each sandbox is a dedicated EC2 instance running the OpenCode server
 * and other required services, connected to the control plane via
 * a Cloudflare tunnel created by the EC2 deployer worker.
 */

import {
  DEFAULT_SANDBOX_TIMEOUT_SECONDS,
  SandboxProviderError,
  type SandboxProvider,
  type SandboxProviderCapabilities,
  type CreateSandboxConfig,
  type CreateSandboxResult,
} from "../provider";
import { generateInternalToken } from "@open-inspect/shared";
import { createLogger } from "../../logger";

const log = createLogger("ec2-provider");

// ==================== EC2 API Client ====================

export interface EC2ApiConfig {
  /** Base URL of the EC2 deployer API (Cloudflare Worker) */
  apiUrl: string;
  /** Shared secret for authenticating requests */
  apiSecret: string;
}

export interface EC2DeployRequest {
  sandboxId: string;
  sessionId: string;
  repoOwner: string;
  repoName: string;
  controlPlaneUrl: string;
  sandboxAuthToken: string;
  provider: string;
  model: string;
  branch?: string;
  agent?: string;
  userEnvVars?: Record<string, string>;
  timeoutSeconds?: number;
  scmProvider?: "github" | "bitbucket";
}

export interface EC2DeployResponse {
  success: boolean;
  sandboxId: string;
  providerObjectId: string; // The EC2 Instance ID or Durable Object ID
  status: string;
  createdAt: number;
  error?: string;
}

/**
 * Client for the EC2 deployer worker.
 */
export class EC2ApiClient {
  private readonly config: EC2ApiConfig;

  constructor(config: EC2ApiConfig) {
    if (!config.apiUrl) {
      throw new Error("EC2ApiClient requires apiUrl");
    }
    if (!config.apiSecret) {
      throw new Error("EC2ApiClient requires apiSecret");
    }
    this.config = config;
  }

  private async getHeaders(): Promise<Record<string, string>> {
    const token = await generateInternalToken(this.config.apiSecret);
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    };
  }

  async deploy(request: EC2DeployRequest): Promise<EC2DeployResponse> {
    const response = await fetch(`${this.config.apiUrl}/deploy`, {
      method: "POST",
      headers: await this.getHeaders(),
      body: JSON.stringify(request),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`EC2 deployer error: ${response.status} ${text}`);
    }

    return (await response.json()) as EC2DeployResponse;
  }

  async stop(providerObjectId: string): Promise<{ success: boolean }> {
    const response = await fetch(`${this.config.apiUrl}/stop`, {
      method: "POST",
      headers: await this.getHeaders(),
      body: JSON.stringify({ providerObjectId }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`EC2 deployer error: ${response.status} ${text}`);
    }

    return (await response.json()) as { success: boolean };
  }

  async start(providerObjectId: string): Promise<{ success: boolean }> {
    const response = await fetch(`${this.config.apiUrl}/start`, {
      method: "POST",
      headers: await this.getHeaders(),
      body: JSON.stringify({ providerObjectId }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`EC2 deployer error: ${response.status} ${text}`);
    }

    return (await response.json()) as { success: boolean };
  }
}

// ==================== EC2 Sandbox Provider ====================

export class EC2SandboxProvider implements SandboxProvider {
  readonly name = "ec2";

  readonly capabilities: SandboxProviderCapabilities = {
    supportsSnapshots: false,
    supportsRestore: false,
    supportsWarm: false,
  };

  constructor(private readonly client: EC2ApiClient) {}

  async stopSandbox(providerObjectId: string): Promise<void> {
    const result = await this.client.stop(providerObjectId);
    if (!result.success) throw new Error("Failed to stop EC2 instance");
  }

  async startSandbox(providerObjectId: string): Promise<void> {
    const result = await this.client.start(providerObjectId);
    if (!result.success) throw new Error("Failed to start EC2 instance");
  }

  async createSandbox(config: CreateSandboxConfig): Promise<CreateSandboxResult> {
    try {
      const result = await this.client.deploy({
        sandboxId: config.sandboxId,
        sessionId: config.sessionId,
        repoOwner: config.repoOwner,
        repoName: config.repoName,
        controlPlaneUrl: config.controlPlaneUrl,
        sandboxAuthToken: config.sandboxAuthToken,
        provider: config.provider,
        model: config.model,
        branch: config.branch,
        agent: config.agent,
        userEnvVars: config.userEnvVars,
        timeoutSeconds: config.timeoutSeconds ?? DEFAULT_SANDBOX_TIMEOUT_SECONDS,
      });

      if (!result.success) {
        throw new Error(result.error || "EC2 deploy failed");
      }

      log.info("Sandbox deployed via EC2", {
        event: "sandbox.ec2_deployed",
        sandbox_id: result.sandboxId,
        provider_object_id: result.providerObjectId,
      });

      return {
        sandboxId: result.sandboxId,
        providerObjectId: result.providerObjectId,
        status: result.status,
        createdAt: result.createdAt,
      };
    } catch (error) {
      throw this.classifyError("Failed to create sandbox via EC2", error);
    }
  }

  private classifyError(message: string, error: unknown): SandboxProviderError {
    if (error instanceof Error) {
      const errorMessage = error.message.toLowerCase();
      if (
        errorMessage.includes("ec2 deployer error: 401") ||
        errorMessage.includes('"error":"unauthorized"')
      ) {
        return new SandboxProviderError(`${message}: Unauthorized`, "permanent", error);
      }
      if (
        errorMessage.includes("fetch failed") ||
        errorMessage.includes("timeout") ||
        errorMessage.includes("502") ||
        errorMessage.includes("503") ||
        errorMessage.includes("504")
      ) {
        return new SandboxProviderError(`${message}: ${error.message}`, "transient", error);
      }
    }
    return new SandboxProviderError(
      `${message}: ${error instanceof Error ? error.message : String(error)}`,
      "permanent",
      error instanceof Error ? error : undefined
    );
  }
}

export function createEC2Provider(config: EC2ApiConfig): EC2SandboxProvider {
  const client = new EC2ApiClient(config);
  return new EC2SandboxProvider(client);
}
