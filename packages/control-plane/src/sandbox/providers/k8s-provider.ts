/**
 * Kubernetes sandbox provider.
 *
 * Replaces the Modal sandbox provider. Creates K8s Jobs to run
 * sandbox containers with the same environment and lifecycle.
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

/**
 * Configuration for the K8s sandbox provider.
 */
export interface K8sProviderConfig {
  /** Namespace for sandbox pods (default: "sandboxes") */
  namespace: string;
  /** Docker image for sandbox containers */
  sandboxImage: string;
  /** CPU request for sandbox pods (default: "500m") */
  cpuRequest: string;
  /** CPU limit for sandbox pods (default: "2") */
  cpuLimit: string;
  /** Memory request for sandbox pods (default: "512Mi") */
  memoryRequest: string;
  /** Memory limit for sandbox pods (default: "4Gi") */
  memoryLimit: string;
  /** Sandbox timeout in seconds */
  timeoutSeconds: number;
  /** Service account name for sandbox pods (default: "sandbox-sa") */
  serviceAccountName: string;
  /** Node selector for sandbox pods */
  nodeSelector?: Record<string, string>;
}

const DEFAULT_CONFIG: K8sProviderConfig = {
  namespace: "sandboxes",
  sandboxImage: "open-inspect-sandbox:latest",
  cpuRequest: "500m",
  cpuLimit: "2",
  memoryRequest: "512Mi",
  memoryLimit: "4Gi",
  timeoutSeconds: DEFAULT_SANDBOX_TIMEOUT_SECONDS,
  serviceAccountName: "sandbox-sa",
};

/**
 * Kubernetes-based sandbox provider.
 *
 * Creates K8s Jobs with a single pod to run sandbox containers.
 * Each sandbox gets its own Job with environment variables matching
 * the original Modal sandbox configuration.
 */
export class K8sSandboxProvider implements SandboxProvider {
  readonly name = "kubernetes";
  readonly capabilities: SandboxProviderCapabilities = {
    supportsSnapshots: false, // TODO: implement via container commits or volume snapshots
    supportsRestore: false,
    supportsWarm: false,
  };

  private readonly batchApi: k8s.BatchV1Api;
  private readonly coreApi: k8s.CoreV1Api;
  private readonly config: K8sProviderConfig;

  constructor(config: Partial<K8sProviderConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };

    const kc = new k8s.KubeConfig();
    kc.loadFromDefault(); // Uses in-cluster config or ~/.kube/config

    this.batchApi = kc.makeApiClient(k8s.BatchV1Api);
    this.coreApi = kc.makeApiClient(k8s.CoreV1Api);
  }

  /**
   * Create a new sandbox as a K8s Job.
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

    const jobName = `sandbox-${sandboxId.substring(0, 24)}`;

    // Build environment variables
    const envVars: k8s.V1EnvVar[] = [
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

    if (opencodeSessionId) {
      envVars.push({ name: "OPENCODE_SESSION_ID", value: opencodeSessionId });
    }
    if (gitUserName) {
      envVars.push({ name: "GIT_USER_NAME", value: gitUserName });
    }
    if (gitUserEmail) {
      envVars.push({ name: "GIT_USER_EMAIL", value: gitUserEmail });
    }
    if (traceId) {
      envVars.push({ name: "TRACE_ID", value: traceId });
    }
    if (requestId) {
      envVars.push({ name: "REQUEST_ID", value: requestId });
    }

    // Add user-provided environment variables (repo secrets)
    if (userEnvVars) {
      for (const [key, value] of Object.entries(userEnvVars)) {
        envVars.push({ name: key, value });
      }
    }

    // Build the Job spec
    const job: k8s.V1Job = {
      apiVersion: "batch/v1",
      kind: "Job",
      metadata: {
        name: jobName,
        namespace: this.config.namespace,
        labels: {
          "app.kubernetes.io/name": "open-inspect-sandbox",
          "app.kubernetes.io/component": "sandbox",
          "open-inspect/session-id": sessionId,
          "open-inspect/sandbox-id": sandboxId,
        },
      },
      spec: {
        ttlSecondsAfterFinished: 300, // Clean up completed jobs after 5 minutes
        activeDeadlineSeconds: this.config.timeoutSeconds,
        backoffLimit: 0, // No retries -- sandbox failures are handled by control plane
        template: {
          metadata: {
            labels: {
              "app.kubernetes.io/name": "open-inspect-sandbox",
              "open-inspect/session-id": sessionId,
              "open-inspect/sandbox-id": sandboxId,
            },
          },
          spec: {
            serviceAccountName: this.config.serviceAccountName,
            restartPolicy: "Never",
            ...(this.config.nodeSelector && { nodeSelector: this.config.nodeSelector }),
            containers: [
              {
                name: "sandbox",
                image: this.config.sandboxImage,
                env: envVars,
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
              },
            ],
          },
        },
      },
    };

    try {
      const response = await this.batchApi.createNamespacedJob({
        namespace: this.config.namespace,
        body: job,
      });

      const createdAt = Date.now();

      log.info("Sandbox Job created", {
        event: "sandbox.created",
        sandbox_id: sandboxId,
        session_id: sessionId,
        job_name: jobName,
        namespace: this.config.namespace,
      });

      return {
        sandboxId,
        providerObjectId: jobName,
        status: "spawning",
        createdAt,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);

      log.error("Failed to create sandbox Job", {
        event: "sandbox.create_failed",
        sandbox_id: sandboxId,
        session_id: sessionId,
        job_name: jobName,
        error: message,
      });

      // Classify the error
      if (
        message.includes("timeout") ||
        message.includes("ECONNREFUSED") ||
        message.includes("ECONNRESET")
      ) {
        throw new SandboxProviderError(
          `Failed to create sandbox Job: ${message}`,
          "transient",
          err instanceof Error ? err : undefined,
        );
      }

      throw new SandboxProviderError(
        `Failed to create sandbox Job: ${message}`,
        "permanent",
        err instanceof Error ? err : undefined,
      );
    }
  }
}

/**
 * Create a K8s sandbox provider with the given configuration.
 */
export function createK8sProvider(config: Partial<K8sProviderConfig> = {}): K8sSandboxProvider {
  return new K8sSandboxProvider(config);
}
