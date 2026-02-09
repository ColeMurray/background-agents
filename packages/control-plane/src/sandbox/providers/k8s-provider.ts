/**
 * Kubernetes sandbox provider using agent-sandbox CRDs.
 *
 * Creates Sandbox custom resources (agents.x-k8s.io/v1alpha1) instead of
 * raw K8s Jobs. The agent-sandbox controller handles pod creation, stable
 * DNS, auto-expiry, and lifecycle management.
 *
 * @see https://github.com/kubernetes-sigs/agent-sandbox
 */

import * as k8s from "@kubernetes/client-node";
import { createLogger } from "../../logger";
import {
  SandboxProviderError,
  type SandboxProvider,
  type SandboxProviderCapabilities,
  type CreateSandboxConfig,
  type CreateSandboxResult,
  DEFAULT_SANDBOX_TIMEOUT_SECONDS,
} from "../provider";

const log = createLogger("k8s-provider");

/** CRD coordinates for the Sandbox resource. */
const SANDBOX_GROUP = "agents.x-k8s.io";
const SANDBOX_VERSION = "v1alpha1";
const SANDBOX_PLURAL = "sandboxes";

/**
 * Configuration for the K8s sandbox provider.
 */
export interface K8sProviderConfig {
  /** Namespace for sandbox resources (default: "open-inspect") */
  namespace: string;
  /** Docker image for sandbox containers */
  sandboxImage: string;
  /** CPU request (default: "500m") */
  cpuRequest: string;
  /** CPU limit (default: "2") */
  cpuLimit: string;
  /** Memory request (default: "512Mi") */
  memoryRequest: string;
  /** Memory limit (default: "4Gi") */
  memoryLimit: string;
  /** Sandbox timeout in seconds (used for shutdownTime) */
  timeoutSeconds: number;
  /** Node selector for sandbox pods */
  nodeSelector?: Record<string, string>;
  /** Runtime class name for sandbox isolation (e.g., "gvisor", "kata") */
  runtimeClassName?: string;
}

const DEFAULT_CONFIG: K8sProviderConfig = {
  namespace: "open-inspect",
  sandboxImage: "open-inspect-sandbox:latest",
  cpuRequest: "500m",
  cpuLimit: "2",
  memoryRequest: "512Mi",
  memoryLimit: "4Gi",
  timeoutSeconds: DEFAULT_SANDBOX_TIMEOUT_SECONDS,
};

/**
 * Kubernetes sandbox provider backed by the agent-sandbox CRD.
 *
 * Each sandbox session creates a Sandbox custom resource. The agent-sandbox
 * controller creates a pod, headless service (stable DNS), and handles
 * auto-expiry via shutdownTime. SandboxWarmPool is managed separately
 * through K8s manifests.
 */
export class K8sSandboxProvider implements SandboxProvider {
  readonly name = "kubernetes";
  readonly capabilities: SandboxProviderCapabilities = {
    supportsSnapshots: false,
    supportsRestore: false,
    supportsWarm: true,
  };

  private readonly customApi: k8s.CustomObjectsApi;
  private readonly config: K8sProviderConfig;

  constructor(config: Partial<K8sProviderConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };

    const kc = new k8s.KubeConfig();
    kc.loadFromDefault();

    this.customApi = kc.makeApiClient(k8s.CustomObjectsApi);
  }

  /**
   * Create a new sandbox as an agent-sandbox Sandbox CR.
   *
   * The agent-sandbox controller will:
   * 1. Create a pod from the embedded podTemplate
   * 2. Create a headless service for stable DNS
   * 3. Auto-delete the Sandbox after shutdownTime expires
   */
  async createSandbox(sandboxConfig: CreateSandboxConfig): Promise<CreateSandboxResult> {
    const {
      sessionId,
      sandboxId,
      repoOwner,
      repoName,
      controlPlaneUrl,
      sandboxAuthToken,
      provider: llmProvider,
      model,
      userEnvVars,
      opencodeSessionId,
      gitUserName,
      gitUserEmail,
      traceId,
      requestId,
    } = sandboxConfig;

    const sandboxName = `sandbox-${sandboxId.substring(0, 24)}`;

    // Build environment variables
    const env: Array<{ name: string; value: string }> = [
      { name: "SANDBOX_ID", value: sandboxId },
      { name: "CONTROL_PLANE_URL", value: controlPlaneUrl },
      { name: "SANDBOX_AUTH_TOKEN", value: sandboxAuthToken },
      { name: "REPO_OWNER", value: repoOwner },
      { name: "REPO_NAME", value: repoName },
      { name: "SESSION_ID", value: sessionId },
      { name: "LLM_PROVIDER", value: llmProvider },
      { name: "MODEL", value: model },
      { name: "PYTHONUNBUFFERED", value: "1" },
    ];

    if (opencodeSessionId) env.push({ name: "OPENCODE_SESSION_ID", value: opencodeSessionId });
    if (gitUserName) env.push({ name: "GIT_USER_NAME", value: gitUserName });
    if (gitUserEmail) env.push({ name: "GIT_USER_EMAIL", value: gitUserEmail });
    if (traceId) env.push({ name: "TRACE_ID", value: traceId });
    if (requestId) env.push({ name: "REQUEST_ID", value: requestId });

    if (userEnvVars) {
      for (const [key, value] of Object.entries(userEnvVars)) {
        env.push({ name: key, value });
      }
    }

    // Compute shutdown time (ISO 8601)
    const shutdownTime = new Date(
      Date.now() + this.config.timeoutSeconds * 1000,
    ).toISOString();

    // Build the Sandbox custom resource
    const sandbox = {
      apiVersion: `${SANDBOX_GROUP}/${SANDBOX_VERSION}`,
      kind: "Sandbox",
      metadata: {
        name: sandboxName,
        namespace: this.config.namespace,
        labels: {
          "app.kubernetes.io/name": "open-inspect-sandbox",
          "app.kubernetes.io/component": "sandbox",
          "app.kubernetes.io/part-of": "open-inspect",
          "open-inspect/session-id": sessionId,
          "open-inspect/sandbox-id": sandboxId,
        },
      },
      spec: {
        podTemplate: {
          metadata: {
            labels: {
              "app.kubernetes.io/name": "open-inspect-sandbox",
              "open-inspect/session-id": sessionId,
              "open-inspect/sandbox-id": sandboxId,
            },
          },
          spec: {
            automountServiceAccountToken: false,
            restartPolicy: "Never",
            ...(this.config.runtimeClassName && {
              runtimeClassName: this.config.runtimeClassName,
            }),
            ...(this.config.nodeSelector && {
              nodeSelector: this.config.nodeSelector,
            }),
            containers: [
              {
                name: "sandbox",
                image: this.config.sandboxImage,
                env,
                ports: [
                  { containerPort: 4096, name: "opencode", protocol: "TCP" },
                ],
                resources: {
                  requests: {
                    cpu: this.config.cpuRequest,
                    memory: this.config.memoryRequest,
                  },
                  limits: {
                    cpu: this.config.cpuLimit,
                    memory: this.config.memoryLimit,
                  },
                },
                securityContext: {
                  allowPrivilegeEscalation: false,
                },
              },
            ],
          },
        },
        shutdownTime,
        shutdownPolicy: "Delete",
      },
    };

    try {
      await this.customApi.createNamespacedCustomObject({
        group: SANDBOX_GROUP,
        version: SANDBOX_VERSION,
        namespace: this.config.namespace,
        plural: SANDBOX_PLURAL,
        body: sandbox,
      });

      const createdAt = Date.now();

      log.info("Sandbox created", {
        event: "sandbox.created",
        sandbox_id: sandboxId,
        session_id: sessionId,
        sandbox_name: sandboxName,
        namespace: this.config.namespace,
        shutdown_time: shutdownTime,
      });

      return {
        sandboxId,
        providerObjectId: sandboxName,
        status: "spawning",
        createdAt,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);

      log.error("Failed to create Sandbox", {
        event: "sandbox.create_failed",
        sandbox_id: sandboxId,
        session_id: sessionId,
        sandbox_name: sandboxName,
        error: message,
      });

      if (
        message.includes("timeout") ||
        message.includes("ECONNREFUSED") ||
        message.includes("ECONNRESET")
      ) {
        throw new SandboxProviderError(
          `Failed to create Sandbox: ${message}`,
          "transient",
          err instanceof Error ? err : undefined,
        );
      }

      throw new SandboxProviderError(
        `Failed to create Sandbox: ${message}`,
        "permanent",
        err instanceof Error ? err : undefined,
      );
    }
  }

  /**
   * Delete a sandbox by removing the Sandbox CR.
   * The agent-sandbox controller handles pod and service cleanup.
   */
  async destroySandbox(sandboxName: string): Promise<void> {
    try {
      await this.customApi.deleteNamespacedCustomObject({
        group: SANDBOX_GROUP,
        version: SANDBOX_VERSION,
        namespace: this.config.namespace,
        plural: SANDBOX_PLURAL,
        name: sandboxName,
      });
      log.info("Sandbox deleted", { sandbox_name: sandboxName });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("404") || message.includes("not found")) {
        log.info("Sandbox already deleted", { sandbox_name: sandboxName });
        return;
      }
      throw err;
    }
  }

  /**
   * Pause a sandbox by scaling replicas to 0.
   * The controller deletes the pod but keeps the Sandbox resource.
   */
  async pauseSandbox(sandboxName: string): Promise<void> {
    await this.customApi.patchNamespacedCustomObject({
      group: SANDBOX_GROUP,
      version: SANDBOX_VERSION,
      namespace: this.config.namespace,
      plural: SANDBOX_PLURAL,
      name: sandboxName,
      body: { spec: { replicas: 0 } },
    });
    log.info("Sandbox paused", { sandbox_name: sandboxName });
  }

  /**
   * Resume a paused sandbox by scaling replicas back to 1.
   */
  async resumeSandbox(sandboxName: string): Promise<void> {
    await this.customApi.patchNamespacedCustomObject({
      group: SANDBOX_GROUP,
      version: SANDBOX_VERSION,
      namespace: this.config.namespace,
      plural: SANDBOX_PLURAL,
      name: sandboxName,
      body: { spec: { replicas: 1 } },
    });
    log.info("Sandbox resumed", { sandbox_name: sandboxName });
  }

  /**
   * Get the stable DNS FQDN for a sandbox.
   * Returns null if the sandbox is not ready.
   */
  async getSandboxFQDN(sandboxName: string): Promise<string | null> {
    try {
      const response = await this.customApi.getNamespacedCustomObject({
        group: SANDBOX_GROUP,
        version: SANDBOX_VERSION,
        namespace: this.config.namespace,
        plural: SANDBOX_PLURAL,
        name: sandboxName,
      });
      const status = (response as Record<string, unknown>).status as
        | { serviceFQDN?: string }
        | undefined;
      return status?.serviceFQDN ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Check if a sandbox is ready (pod running + service created).
   */
  async isSandboxReady(sandboxName: string): Promise<boolean> {
    try {
      const response = await this.customApi.getNamespacedCustomObject({
        group: SANDBOX_GROUP,
        version: SANDBOX_VERSION,
        namespace: this.config.namespace,
        plural: SANDBOX_PLURAL,
        name: sandboxName,
      });
      const status = (response as Record<string, unknown>).status as
        | { conditions?: Array<{ type: string; status: string }> }
        | undefined;
      if (!status?.conditions) return false;
      return status.conditions.some(
        (c) => c.type === "Ready" && c.status === "True",
      );
    } catch {
      return false;
    }
  }
}

/**
 * Create a K8s sandbox provider with the given configuration.
 */
export function createK8sProvider(
  config: Partial<K8sProviderConfig> = {},
): K8sSandboxProvider {
  return new K8sSandboxProvider(config);
}
