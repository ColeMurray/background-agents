/**
 * Helm/Kubernetes sandbox provider implementation.
 *
 * Deploys sandbox environments as Helm releases in a Kubernetes cluster.
 * Each sandbox is a single pod with all required services, connected
 * to the control plane via a Cloudflare tunnel.
 *
 * The bridge running inside the sandbox connects back to the control
 * plane over WebSocket just like the Modal provider — the streaming
 * protocol is unchanged.
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

const log = createLogger("helm-provider");

// ==================== Helm API Client ====================

export interface HelmApiConfig {
  /** Base URL of the Helm deployer API (e.g., https://helm-deployer.internal) */
  apiUrl: string;
  /** Shared secret for authenticating requests */
  apiSecret: string;
  /** Kubernetes namespace for sandbox pods */
  namespace: string;
  /** Cloudflare tunnel token for sandbox connectivity */
  tunnelToken: string;
}

export interface HelmDeployRequest {
  releaseName: string;
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
  tunnelToken: string;
  namespace: string;
  anthropicApiKey?: string;
  gitCloneToken?: string;
}

export interface HelmDeployResponse {
  success: boolean;
  releaseName: string;
  sandboxId: string;
  status: string;
  createdAt: number;
  error?: string;
}

export interface HelmDeleteRequest {
  releaseName: string;
  namespace: string;
}

export interface HelmDeleteResponse {
  success: boolean;
  releaseName: string;
  deleted: boolean;
  error?: string;
}

/**
 * Client for the Helm deployer API.
 *
 * The deployer is a small HTTP service running in the K8s cluster that
 * receives authenticated requests and runs `helm install/uninstall`.
 */
export class HelmApiClient {
  private readonly config: HelmApiConfig;

  constructor(config: HelmApiConfig) {
    if (!config.apiUrl) {
      throw new Error("HelmApiClient requires apiUrl");
    }
    if (!config.apiSecret) {
      throw new Error("HelmApiClient requires apiSecret");
    }

    this.config = {
      ...config,
      apiUrl: HelmApiClient.normalizeApiUrl(config.apiUrl),
    };
  }

  private static normalizeApiUrl(apiUrl: string): string {
    const trimmed = apiUrl.trim();
    const withProtocol = /^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//.test(trimmed)
      ? trimmed
      : `http://${trimmed}`;
    const withoutTrailingSlash = withProtocol.replace(/\/+$/, "");

    try {
      // Validate URL shape early so bad config fails fast.
      new URL(withoutTrailingSlash);
    } catch {
      throw new Error(`Invalid Helm API URL: ${apiUrl}`);
    }

    return withoutTrailingSlash;
  }

  private async getHeaders(): Promise<Record<string, string>> {
    const token = await generateInternalToken(this.config.apiSecret);
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    };
  }

  async deploy(request: HelmDeployRequest): Promise<HelmDeployResponse> {
    const headers = await this.getHeaders();
    const response = await fetch(`${this.config.apiUrl}/deploy`, {
      method: "POST",
      headers,
      body: JSON.stringify(request),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Helm API error: ${response.status} ${text}`);
    }

    return (await response.json()) as HelmDeployResponse;
  }

  async delete(request: HelmDeleteRequest): Promise<HelmDeleteResponse> {
    const headers = await this.getHeaders();
    const response = await fetch(`${this.config.apiUrl}/delete`, {
      method: "POST",
      headers,
      body: JSON.stringify(request),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Helm API error: ${response.status} ${text}`);
    }

    return (await response.json()) as HelmDeleteResponse;
  }

  async health(): Promise<{ status: string; service: string }> {
    const response = await fetch(`${this.config.apiUrl}/health`);
    if (!response.ok) {
      throw new Error(`Helm API health check failed: ${response.status}`);
    }
    return (await response.json()) as { status: string; service: string };
  }
}

// ==================== Helm Sandbox Provider ====================

/**
 * Helm sandbox provider.
 *
 * Implements the SandboxProvider interface by deploying Helm chart releases
 * into a Kubernetes cluster. Each sandbox is a single pod containing:
 * - OpenCode coding agent
 * - Reverse proxy (Node 22)
 * - Browser for MCP
 * - MongoDB, Jaeger, RedPanda, RabbitMQ, Maildev, MinIO, Redis, Kafka Connect
 * - Cloudflare tunnel for connectivity
 * - ttyd for browser-based terminal access
 *
 * The sandbox bridge connects back to the control plane over WebSocket
 * through the Cloudflare tunnel, maintaining the same streaming protocol
 * as the Modal provider.
 */
export class HelmSandboxProvider implements SandboxProvider {
  readonly name = "helm";

  readonly capabilities: SandboxProviderCapabilities = {
    supportsSnapshots: false,
    supportsRestore: false,
    supportsWarm: false,
  };

  constructor(private readonly client: HelmApiClient) {}

  async createSandbox(config: CreateSandboxConfig): Promise<CreateSandboxResult> {
    try {
      // Generate a Helm release name from sandbox ID (must be DNS-compatible)
      const releaseName = config.sandboxId
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, "-")
        .slice(0, 53);

      const result = await this.client.deploy({
        releaseName,
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
        tunnelToken: this.client["config"].tunnelToken,
        namespace: this.client["config"].namespace,
        anthropicApiKey: config.userEnvVars?.["ANTHROPIC_API_KEY"],
        gitCloneToken: config.userEnvVars?.["VCS_CLONE_TOKEN"],
      });

      if (!result.success) {
        throw new Error(result.error || "Helm deploy failed");
      }

      log.info("Sandbox deployed via Helm", {
        event: "sandbox.helm_deployed",
        release_name: releaseName,
        sandbox_id: result.sandboxId,
      });

      return {
        sandboxId: result.sandboxId,
        providerObjectId: releaseName,
        status: result.status,
        createdAt: result.createdAt,
      };
    } catch (error) {
      throw this.classifyError("Failed to create sandbox via Helm", error);
    }
  }

  private classifyError(message: string, error: unknown): SandboxProviderError {
    if (error instanceof Error) {
      const errorMessage = error.message.toLowerCase();
      if (
        errorMessage.includes("helm api error: 401") ||
        errorMessage.includes('"error":"unauthorized"')
      ) {
        return new SandboxProviderError(
          `${message}: ${error.message}. Verify HELM_API_SECRET matches between control-plane and helm-deployer.`,
          "permanent",
          error
        );
      }
      if (
        errorMessage.includes("fetch failed") ||
        errorMessage.includes("etimedout") ||
        errorMessage.includes("econnreset") ||
        errorMessage.includes("econnrefused") ||
        errorMessage.includes("network") ||
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

/**
 * Create a Helm sandbox provider.
 */
export function createHelmProvider(config: HelmApiConfig): HelmSandboxProvider {
  const client = new HelmApiClient(config);
  return new HelmSandboxProvider(client);
}
