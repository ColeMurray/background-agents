import type { SandboxSettings } from "@open-inspect/shared/types/integrations";
import type { SourceControlProviderName } from "../../source-control";
import { createLogger } from "../../logger";
import { Sandbox0ApiError, type Sandbox0RestClient, sandbox0Path } from "../sandbox0-rest-client";
import {
  DEFAULT_SANDBOX_TIMEOUT_SECONDS,
  PrebuiltImageUnavailableError,
  SandboxProviderError,
  createVncAccess,
  type SandboxProvider,
  type CreateSandboxConfig,
  type CreateSandboxResult,
  type ResumeConfig,
  type ResumeResult,
  type StopConfig,
  type StopResult,
} from "../provider";
import {
  buildSandboxEnvVars,
  deriveCodeServerPassword,
  deriveVncPassword,
  scmCloneIdentity,
} from "../sandbox-env";
import { resolveServicePorts, resolveTunnelPorts } from "./port-resolution";
import { withRequestDeadline } from "../request-deadline";

const log = createLogger("sandbox0-provider");
const RUNTIME_NAME = "openinspect-runtime";
const ENTRYPOINT = ["/opt/openinspect/start-runtime"];

export const SANDBOX0_PAUSE_TIMEOUT_MS = 120_000;

interface RuntimeSpec {
  name: string;
  command: string[];
  cwd: string;
  env: Record<string, string>;
  lifecycle: { desired_state: string; runtime_recovery: string; restart: { policy: string } };
}
interface RuntimeSession {
  id: string;
  phase: string;
  spec: RuntimeSpec;
}
interface ServiceView {
  id: string;
  port: number;
  public_url?: string;
}

export interface Sandbox0ProviderConfig {
  templateId: string;
  scmProvider: SourceControlProviderName;
  sandboxAccessPasswordSecret: string;
}

/** One durable workspace per Open-Inspect session; pause discards processes, not files. */
export class Sandbox0SandboxProvider implements SandboxProvider {
  readonly name = "sandbox0";
  readonly capabilities = {
    supportsSandboxTimeout: true,
    supportsSnapshots: false,
    supportsRestore: false,
    supportsPersistentResume: true,
    supportsExplicitStop: true,
  };

  constructor(
    readonly client: Sandbox0RestClient,
    readonly config: Sandbox0ProviderConfig
  ) {}

  /** Claim a workspace and launch its runtime, deleting known allocations on startup failure. */
  async createSandbox(config: CreateSandboxConfig): Promise<CreateSandboxResult> {
    let providerObjectId: string | undefined;
    try {
      if (config.prebuiltImageId) {
        throw new PrebuiltImageUnavailableError("Sandbox0 repository prebuilds are not supported");
      }
      const passwords = await this.passwords(config);
      const env = buildSandboxEnvVars(config, {
        scmIdentity: scmCloneIdentity(this.config.scmProvider),
        ...passwords,
      });
      // Runtime installation owns PATH/HOME; credentials use runtime-only storage.
      env.OI_SCM_CRED_CACHE_DIR = "/tmp/oi-scm";
      // The persistent-resume contract cannot renew terminal JWTs yet.
      env.TERMINAL_ENABLED = "";
      const sandbox = await this.client.request<{ sandbox_id: string }>(
        "POST",
        "/api/v1/sandboxes",
        {
          template: this.config.templateId,
          config: {
            ttl: config.timeoutSeconds ?? DEFAULT_SANDBOX_TIMEOUT_SECONDS,
            hard_ttl: 0,
            auto_resume: false,
            services: this.services(config),
          },
        }
      );
      providerObjectId = sandbox.sandbox_id;
      const access = await this.access(providerObjectId, config);
      await this.client.request(
        "POST",
        `${sandbox0Path(providerObjectId)}/sessions`,
        {
          name: RUNTIME_NAME,
          command: ENTRYPOINT,
          cwd: "/workspace",
          env: { ...env, SANDBOX_ID: config.sandboxId },
          // Resume must install the restore boot mode before a new process starts.
          lifecycle: {
            desired_state: "running",
            runtime_recovery: "stop",
            restart: { policy: "never" },
          },
        },
        { idempotencyKey: RUNTIME_NAME }
      );
      return {
        sandboxId: config.sandboxId,
        providerObjectId,
        createdAt: Date.now(),
        ...access,
        ...passwords,
        vncAccess: createVncAccess(access.vncUrl, passwords.vncPassword),
      };
    } catch (error) {
      if (providerObjectId) await this.cleanup(providerObjectId);
      if (error instanceof PrebuiltImageUnavailableError) throw error;
      throw this.classify(error);
    }
  }

  /** Restart a stopped attempt in restore mode without rotating workspace identity or credentials. */
  async resumeSandbox(config: ResumeConfig): Promise<ResumeResult> {
    const path = sandbox0Path(config.providerObjectId);
    try {
      let sandbox;
      try {
        sandbox = await this.client.request<{ status: string }>("GET", path);
      } catch (error) {
        if (error instanceof Sandbox0ApiError && error.status === 404)
          return {
            success: false,
            shouldSpawnFresh: true,
            error: "Sandbox0 workspace no longer exists",
          };
        throw error;
      }
      // Apply the new runtime TTL before resuming. Never change the durable retention policy.
      await this.client.request("PUT", path, {
        config: {
          ttl: config.timeoutSeconds ?? DEFAULT_SANDBOX_TIMEOUT_SECONDS,
          auto_resume: false,
        },
      });
      if (sandbox.status === "paused") await this.client.request("POST", `${path}/resume`);
      else if (sandbox.status !== "running")
        throw new SandboxProviderError(`Sandbox0 workspace is ${sandbox.status}`, "transient");
      const { sessions } = await this.client.request<{ sessions: RuntimeSession[] }>(
        "GET",
        `${path}/sessions`
      );
      const runtime = sessions.find(
        (s) => s.spec.name === RUNTIME_NAME && s.spec.env?.SANDBOX_ID === config.sandboxId
      );
      if (!runtime)
        throw new Error("Sandbox0 workspace has no matching Open-Inspect runtime session");
      const access = await this.access(config.providerObjectId, config);
      // API-key rotation must not change passwords already installed in the guest.
      const passwords = {
        codeServerPassword: runtime.spec.env.CODE_SERVER_PASSWORD,
        vncPassword: runtime.spec.env.VNC_PASSWORD,
      };
      // An interrupted resume may already have started this attempt. Do not replace it.
      if (!["running", "starting", "pending"].includes(runtime.phase)) {
        await this.client.request("PUT", `${path}/sessions/${encodeURIComponent(runtime.id)}`, {
          ...runtime.spec,
          env: {
            ...runtime.spec.env,
            RESTORED_FROM_SNAPSHOT: "true",
            SANDBOX_TIMEOUT_SECONDS: String(
              config.timeoutSeconds ?? DEFAULT_SANDBOX_TIMEOUT_SECONDS
            ),
          },
          lifecycle: { ...runtime.spec.lifecycle, desired_state: "running" },
        });
      }
      return {
        success: true,
        providerObjectId: config.providerObjectId,
        ...access,
        ...passwords,
        vncAccess: createVncAccess(access.vncUrl, passwords.vncPassword),
      };
    } catch (error) {
      throw this.classify(error);
    }
  }

  /** Preserve idle workspaces with a checkpoint; discard failed or explicitly replaced ones. */
  async stopSandbox(config: StopConfig): Promise<StopResult> {
    try {
      if (["inactivity_timeout", "heartbeat_timeout"].includes(config.reason)) {
        await this.pauseSandbox(config.providerObjectId, config.signal);
      } else {
        await this.deleteSandbox(config.providerObjectId, config.signal);
      }
      return { success: true };
    } catch (error) {
      if (error instanceof Sandbox0ApiError && error.status === 404) return { success: true };
      throw this.classify(error);
    }
  }

  /** Wait for durable pause commitment rather than treating transaction acceptance as success. */
  private async pauseSandbox(id: string, callerSignal?: AbortSignal): Promise<void> {
    const path = sandbox0Path(id);
    await withRequestDeadline(
      "Sandbox0",
      `${path}/pause`,
      SANDBOX0_PAUSE_TIMEOUT_MS,
      callerSignal,
      async (signal) => {
        const result = await this.client.request<{ paused: boolean }>(
          "POST",
          `${path}/pause`,
          undefined,
          { signal }
        );
        if (result.paused) return;
        // 202 is transaction acceptance, not proof that the RootFS is durable.
        while (true) {
          signal.throwIfAborted();
          const sandbox = await this.client.request<{ status: string }>("GET", path, undefined, {
            signal,
          });
          if (sandbox.status === "paused") return;
          // A quiescing carrier can project as "failed" before pause commits.
          // Only confirmed "paused" is success; all other states remain bounded
          // by this operation's deadline (or an explicit concurrent deletion).
          if (sandbox.status === "terminating") {
            throw new SandboxProviderError(`Sandbox0 pause failed: ${sandbox.status}`, "transient");
          }
          await new Promise<void>((resolve, reject) => {
            const onAbort = () => {
              clearTimeout(timer);
              reject(signal.reason);
            };
            const timer = setTimeout(() => {
              signal.removeEventListener("abort", onAbort);
              resolve();
            }, 1000);
            signal.addEventListener("abort", onAbort, { once: true });
            if (signal.aborted) onAbort();
          });
        }
      }
    );
  }

  /** Request deletion idempotently; an already absent workspace needs no further action. */
  async deleteSandbox(id: string, signal?: AbortSignal): Promise<void> {
    try {
      await this.client.request("DELETE", sandbox0Path(id), undefined, { signal });
    } catch (error) {
      if (!(error instanceof Sandbox0ApiError && error.status === 404)) throw error;
    }
  }

  /** Attempt teardown without masking the original startup error. */
  private async cleanup(id: string): Promise<void> {
    try {
      await this.deleteSandbox(id);
    } catch {
      log.warn("sandbox0.cleanup_failed", { sandbox_id: id });
    }
  }

  /** Derive access credentials for initial creation only; resume reuses the stored credentials. */
  private async passwords(
    config: Pick<CreateSandboxConfig, "sandboxId" | "codeServerEnabled" | "vncEnabled">
  ) {
    return {
      codeServerPassword: config.codeServerEnabled
        ? await deriveCodeServerPassword(config.sandboxId, this.config.sandboxAccessPasswordSecret)
        : undefined,
      vncPassword: config.vncEnabled
        ? await deriveVncPassword(config.sandboxId, this.config.sandboxAccessPasswordSecret)
        : undefined,
    };
  }

  /** Expose runtime-managed ports without allowing incoming traffic to auto-resume the workspace. */
  private services(
    config: Pick<CreateSandboxConfig, "sandboxSettings" | "codeServerEnabled" | "vncEnabled">
  ) {
    const { codeServerPort, vncPort } = resolveServicePorts(config.sandboxSettings);
    const ports = new Set(resolveTunnelPorts(config.sandboxSettings?.tunnelPorts));
    if (config.codeServerEnabled) ports.add(codeServerPort);
    if (config.vncEnabled) ports.add(vncPort);
    return [...ports].map((port) => ({
      id: `oi-${port}`,
      port,
      runtime: { type: "manual" },
      ingress: { public: true, routes: [{ id: "default", path_prefix: "/", resume: false }] },
    }));
  }

  /** Separate editor/desktop access from development tunnels using provider-returned URLs. */
  private async access(
    id: string,
    config: { codeServerEnabled?: boolean; vncEnabled?: boolean; sandboxSettings?: SandboxSettings }
  ) {
    const { services } = await this.client.request<{ services: ServiceView[] }>(
      "GET",
      `${sandbox0Path(id)}/services`
    );
    const { codeServerPort, vncPort } = resolveServicePorts(config.sandboxSettings);
    // `publishable` concerns function revisions, not manual HTTP ingress.
    const url = (port: number) => services.find((s) => s.port === port)?.public_url;
    const tunnelUrls = Object.fromEntries(
      resolveTunnelPorts(config.sandboxSettings?.tunnelPorts)
        .filter(
          (p) =>
            !(config.codeServerEnabled && p === codeServerPort) &&
            !(config.vncEnabled && p === vncPort)
        )
        .flatMap((p) => (url(p) ? [[String(p), url(p)!]] : []))
    );
    return {
      codeServerUrl: config.codeServerEnabled ? url(codeServerPort) : undefined,
      vncUrl: config.vncEnabled ? url(vncPort) : undefined,
      tunnelUrls,
    };
  }

  /** Map retryable provider failures without losing existing provider-neutral error semantics. */
  private classify(error: unknown): SandboxProviderError {
    if (error instanceof SandboxProviderError) return error;
    if (error instanceof Sandbox0ApiError) {
      const transient = error.status === 409 || error.status === 429 || error.status >= 500;
      return new SandboxProviderError(error.message, transient ? "transient" : "permanent", error);
    }
    return SandboxProviderError.fromFetchError("Sandbox0 operation failed", error);
  }
}
