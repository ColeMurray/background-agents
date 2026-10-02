/**
 * Daytona sandbox provider — calls the Daytona REST API directly.
 *
 * Ports env-var assembly, label construction, tunnel-URL generation, and
 * code-server password derivation that previously lived in the Python shim.
 *
 * Prebuilt images (snapshots): a spawn creates from the snapshot the control
 * plane selected for it in place of the base one, once this provider has made
 * that snapshot usable or said why it cannot be. A Daytona capture preserves
 * the image's environment, so the boot markers below are set explicitly on
 * every create: a value baked into an image can never decide how a session
 * boots.
 */

import { supportsConfigurableSandboxTimeout } from "@open-inspect/shared/types/integrations";
import { resolveSandboxPortPlan, type SandboxPortPlan } from "./port-resolution";
import { createLogger } from "../../logger";
import type { SourceControlProviderName } from "../../source-control";
import {
  classifyDaytonaError,
  getDaytonaSnapshot,
  LIFECYCLE_POLL_INTERVAL_MS,
} from "../daytona-lifecycle";
import type { DaytonaRestClient, DaytonaCreateSandboxParams } from "../daytona-rest-client";
import {
  DaytonaApiError,
  DaytonaCancelledError,
  DaytonaNotFoundError,
  delayUnlessCancelled,
  parseDaytonaSnapshotState,
} from "../daytona-rest-client";
import {
  buildSandboxEnvVars,
  DEFERRED_START_ENV_VAR,
  deriveCodeServerPassword,
  deriveVncPassword,
  IMAGE_BUILD_MODE_ENV_VAR,
  scmCloneIdentity,
  type ScmCloneIdentity,
} from "../sandbox-env";
import {
  PrebuiltImageActivationPendingError,
  PrebuiltImageUnavailableError,
  SandboxProviderError,
  signalUntilDeadline,
  type CreateSandboxConfig,
  type CreateSandboxResult,
  type ResumeConfig,
  type ResumeResult,
  type SandboxProvider,
  type SandboxProviderCapabilities,
  type StopConfig,
  type StopResult,
  type VncAccess,
} from "../provider";

const log = createLogger("daytona-provider");

// ---------------------------------------------------------------------------
// Constants (ported from packages/daytona-infra/src/config.py)
// ---------------------------------------------------------------------------

export const DEFAULT_PREVIEW_EXPIRY_SECONDS = 3900;

/** How long a spawn waits for a cold prebuilt image before falling back to base. */
const PREBUILT_ACTIVATION_TIMEOUT_MS = 45_000;

// ---------------------------------------------------------------------------
// Provider config
// ---------------------------------------------------------------------------

export interface DaytonaProviderConfig {
  scmProvider: SourceControlProviderName;
  gitlabAccessToken?: string;
  /** Secret used for domain-separated sandbox access password derivation. */
  sandboxAccessPasswordSecret: string;
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export class DaytonaSandboxProvider implements SandboxProvider {
  readonly name = "daytona";

  readonly capabilities: SandboxProviderCapabilities = {
    supportsSandboxTimeout: supportsConfigurableSandboxTimeout(this.name),
    supportsSnapshots: false,
    supportsRestore: false,
    supportsPersistentResume: true,
    supportsExplicitStop: true,
  };

  constructor(
    private readonly client: DaytonaRestClient,
    private readonly providerConfig: DaytonaProviderConfig
  ) {}

  // -----------------------------------------------------------------------
  // SandboxProvider interface
  // -----------------------------------------------------------------------

  async createSandbox(config: CreateSandboxConfig): Promise<CreateSandboxResult> {
    try {
      // A prebuilt image id is a Daytona snapshot; spawn from it in place of
      // the base image. Selection is the control plane's (image-selection.ts);
      // this only has to make the chosen snapshot usable or say why not.
      const snapshot = config.prebuiltImageId || this.client.requireBaseSnapshot();
      if (config.prebuiltImageId) {
        await this.ensurePrebuiltImageUsable(config.prebuiltImageId);
      }

      const portPlan = resolveSandboxPortPlan(
        {
          codeServer: config.codeServerEnabled === true,
          terminal: config.sandboxSettings?.terminalEnabled === true,
          vnc: config.vncEnabled === true,
        },
        config.sandboxSettings
      );
      const envVars = await this.buildEnvVars(config, portPlan);
      const labels = this.buildLabels(config);

      const params: DaytonaCreateSandboxParams = {
        name: config.sandboxId,
        snapshot,
        env: envVars,
        labels,
        autoStopInterval: this.client.config.autoStopIntervalMinutes,
        autoArchiveInterval: this.client.config.autoArchiveIntervalMinutes,
        public: false,
      };
      if (this.client.config.target) {
        params.target = this.client.config.target;
      }

      const sandbox = await this.client.createSandbox(params);

      // Preview URLs are user-facing extras, not how a session runs: resolve
      // each independently so one unavailable service cannot hide the live
      // sandbox or other access that succeeded.
      const access = await this.buildTunnelUrls(
        sandbox.id,
        config.sandboxId,
        config.timeoutSeconds,
        portPlan
      );

      return {
        sandboxId: config.sandboxId,
        providerObjectId: sandbox.id,
        createdAt: Date.now(),
        lifetime: { kind: "none", observedAtMs: Date.now() },
        ...access,
      };
    } catch (error) {
      // Already classified (the prebuilt-image guards) — rethrow so the
      // manager can tell a cold image from a broken one.
      if (error instanceof SandboxProviderError) throw error;
      throw classifyDaytonaError("Failed to create Daytona sandbox", error);
    }
  }

  async resumeSandbox(config: ResumeConfig): Promise<ResumeResult> {
    try {
      const portPlan = resolveSandboxPortPlan(
        {
          codeServer: config.codeServerEnabled === true,
          terminal: config.sandboxSettings?.terminalEnabled === true,
          vnc: config.vncEnabled === true,
        },
        config.sandboxSettings
      );
      let sandbox;
      try {
        sandbox = await this.client.getSandbox(config.providerObjectId);
      } catch (error) {
        if (error instanceof DaytonaNotFoundError) {
          return {
            success: false,
            error: "Sandbox no longer exists in Daytona",
            shouldSpawnFresh: true,
          };
        }
        throw error;
      }

      const state = sandbox.state;
      if ((state === "error" || state === "build_failed") && sandbox.recoverable) {
        await this.client.recoverSandbox(config.providerObjectId);
      } else if (state !== "started") {
        // Covers stopped, archived, and non-recoverable error states —
        // Daytona's start endpoint handles the state transition internally.
        await this.client.startSandbox(config.providerObjectId);
      }

      // Tunnel URL generation runs after start so a preview-URL failure
      // doesn't mask a successful resume.
      const access = await this.buildTunnelUrls(
        config.providerObjectId,
        config.sandboxId,
        config.timeoutSeconds,
        portPlan
      );

      return {
        success: true,
        providerObjectId: sandbox.id,
        lifetime: { kind: "none", observedAtMs: Date.now() },
        ...access,
      };
    } catch (error) {
      if (error instanceof SandboxProviderError) throw error;
      throw classifyDaytonaError("Failed to resume Daytona sandbox", error);
    }
  }

  async stopSandbox(config: StopConfig): Promise<StopResult> {
    const signal = signalUntilDeadline(config.deadlineAtMs, config.signal);
    try {
      try {
        const destroy = config.intent === "destroy";
        if (destroy) {
          await this.client.deleteSandbox(config.providerObjectId, ...(signal ? [signal] : []));
        } else {
          await this.client.stopSandbox(config.providerObjectId, ...(signal ? [signal] : []));
          if (config.intent === "preserve") {
            const stopped = await this.client.getSandbox(config.providerObjectId, signal);
            if (stopped.state !== "stopped" && stopped.state !== "archived") {
              return { success: false, error: `Sandbox state was ${stopped.state} after stop` };
            }
          }
        }
      } catch (error) {
        if (error instanceof DaytonaNotFoundError) {
          if (config.intent === "preserve") {
            return {
              success: false,
              error: "Sandbox disappeared before graceful shutdown was verified",
            };
          }
          return { success: true };
        }
        throw error;
      }
      return { success: true };
    } catch (error) {
      if (error instanceof SandboxProviderError) throw error;
      throw classifyDaytonaError(
        `Failed to ${config.intent === "destroy" ? "delete" : "stop"} Daytona sandbox`,
        error
      );
    }
  }

  // -----------------------------------------------------------------------
  // Env var assembly (ported from service.py _build_env)
  // -----------------------------------------------------------------------

  private async buildEnvVars(
    config: CreateSandboxConfig,
    portPlan: SandboxPortPlan
  ): Promise<Record<string, string>> {
    const envVars = buildSandboxEnvVars(config, {
      scmIdentity: this.cloneIdentity(),
      portPlan,
      emitDisabledTerminalEnv: true,
      codeServerPassword: config.codeServerEnabled
        ? await deriveCodeServerPassword(
            config.sandboxId,
            this.providerConfig.sandboxAccessPasswordSecret
          )
        : undefined,
      vncPassword: config.vncEnabled
        ? await deriveVncPassword(config.sandboxId, this.providerConfig.sandboxAccessPasswordSecret)
        : undefined,
    });

    // Every boot marker is stated, never merely omitted: a container capture
    // preserves the image's environment, so an absent key would leave a value
    // the image was built with in force. The runtime reads each as
    // `=== "true"`, so "false" is an explicit no.
    //
    // The callback-contract keys (OI_REPO_IMAGE_*) are deliberately NOT set,
    // not even to "": the runtime treats the PRESENCE of any of them as a
    // build-callback context and aborts the boot on a partial one.
    Object.assign(envVars, {
      [DEFERRED_START_ENV_VAR]: "false",
      [IMAGE_BUILD_MODE_ENV_VAR]: "false",
      RESTORED_FROM_SNAPSHOT: "false",
      FROM_REPO_IMAGE: config.prebuiltImageId ? "true" : "false",
    });
    if (config.prebuiltImageId) {
      envVars.REPO_IMAGE_SHA = config.prebuiltImageSha ?? "";
    }
    return envVars;
  }

  private cloneIdentity(): ScmCloneIdentity {
    return scmCloneIdentity(this.providerConfig.scmProvider);
  }

  // -----------------------------------------------------------------------
  // Label assembly (ported from service.py _build_labels)
  // -----------------------------------------------------------------------

  private buildLabels(config: CreateSandboxConfig): Record<string, string> {
    return {
      openinspect_framework: "open-inspect",
      openinspect_session_id: config.sessionId,
      openinspect_expected_sandbox_id: config.sandboxId,
      ...(config.repoOwner && config.repoName
        ? { openinspect_repo: `${config.repoOwner}/${config.repoName}` }
        : {}),
    };
  }

  // -----------------------------------------------------------------------
  // Tunnel URL generation (ported from service.py _build_tunnel_urls)
  // -----------------------------------------------------------------------

  private async buildTunnelUrls(
    daytonaSandboxId: string,
    logicalSandboxId: string,
    timeoutSeconds: number | undefined,
    portPlan: SandboxPortPlan
  ): Promise<{
    codeServerUrl?: string;
    codeServerPassword?: string;
    ttydUrl?: string;
    vncAccess?: VncAccess;
    tunnelUrls?: Record<string, string>;
  }> {
    const expirySeconds = resolvePreviewExpirySeconds(timeoutSeconds);
    const requests: Array<{
      kind: "codeServer" | "terminal" | "vnc" | "tunnel";
      port: number;
    }> = [];
    if (portPlan.codeServerPort !== undefined) {
      requests.push({ kind: "codeServer", port: portPlan.codeServerPort });
    }
    if (portPlan.terminalPort !== undefined) {
      requests.push({ kind: "terminal", port: portPlan.terminalPort });
    }
    if (portPlan.vncPort !== undefined) {
      requests.push({ kind: "vnc", port: portPlan.vncPort });
    }
    for (const port of portPlan.extraTunnelPorts) {
      requests.push({ kind: "tunnel", port });
    }
    const previews = await Promise.allSettled(
      requests.map(async (request) => {
        const preview = await this.client.getSignedPreviewUrl(
          daytonaSandboxId,
          request.port,
          expirySeconds
        );
        let password: string | undefined;
        if (request.kind === "codeServer") {
          password = await deriveCodeServerPassword(
            logicalSandboxId,
            this.providerConfig.sandboxAccessPasswordSecret
          );
        } else if (request.kind === "vnc") {
          password = await deriveVncPassword(
            logicalSandboxId,
            this.providerConfig.sandboxAccessPasswordSecret
          );
        }
        return { request, url: preview.url, password };
      })
    );

    let codeServerUrl: string | undefined;
    let codeServerPassword: string | undefined;
    let ttydUrl: string | undefined;
    let vncAccess: VncAccess | undefined;
    const tunnelUrls: Record<string, string> = {};
    for (const [index, preview] of previews.entries()) {
      if (preview.status === "rejected") {
        const request = requests[index];
        log.warn("daytona.preview_url_failed", {
          sandbox_id: logicalSandboxId,
          access_kind: request.kind,
          port: request.port,
          error: preview.reason instanceof Error ? preview.reason.message : String(preview.reason),
        });
        continue;
      }
      const { request, url, password } = preview.value;
      if (request.kind === "codeServer") {
        codeServerUrl = url;
        codeServerPassword = password;
      } else if (request.kind === "terminal") {
        ttydUrl = url;
      } else if (request.kind === "vnc" && password) {
        vncAccess = { url, password };
      } else if (request.kind === "tunnel") {
        tunnelUrls[String(request.port)] = url;
      }
    }

    return {
      codeServerUrl,
      codeServerPassword,
      ttydUrl,
      vncAccess,
      tunnelUrls: Object.keys(tunnelUrls).length > 0 ? tunnelUrls : undefined,
    };
  }

  // -----------------------------------------------------------------------
  // Prebuilt images
  // -----------------------------------------------------------------------

  /**
   * Make a selected prebuilt snapshot usable, or say why it cannot be.
   *
   * `PREBUILT_ACTIVATION_TIMEOUT_MS` is the budget for the whole flow, not
   * for one of its requests: the deadline is fixed before the first call, and
   * the read, the activation, every poll and every wait run under the signal
   * that expires with it. A spawn therefore waits the advertised time for a
   * cold image, whatever each individual request costs.
   *
   * An inactive snapshot is cold storage, not corruption: it is activated and
   * waited for. An activation that outlasts the budget is reported as pending,
   * which fails this spawn WITHOUT retiring the image — unlike a missing or
   * terminal snapshot, which is reported as unavailable so the row is failed
   * and the next reconciliation rebuilds it.
   */
  private async ensurePrebuiltImageUsable(prebuiltImageId: string): Promise<void> {
    const deadline = Date.now() + PREBUILT_ACTIVATION_TIMEOUT_MS;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), PREBUILT_ACTIVATION_TIMEOUT_MS);
    const signal = controller.signal;
    try {
      const snapshot = await getDaytonaSnapshot(this.client, prebuiltImageId, signal);
      if (!snapshot) {
        throw new PrebuiltImageUnavailableError("Daytona prebuilt snapshot no longer exists");
      }
      const state = parseDaytonaSnapshotState(snapshot.state);
      if (state === "active") return;
      if (state === "error" || state === "build_failed" || state === "removing") {
        throw new PrebuiltImageUnavailableError(
          `Daytona prebuilt snapshot is ${state} and cannot be used`
        );
      }

      if (state === "inactive") {
        await this.client.activateSnapshot(snapshot.id, signal);
      }
      for (;;) {
        const current = await getDaytonaSnapshot(this.client, snapshot.id, signal);
        // A snapshot that is gone, or on its way out, is gone for the same
        // reason the pre-activation read gives: waiting it out would spend
        // the budget and then report an artifact worth keeping.
        if (!current) {
          throw new PrebuiltImageUnavailableError("Daytona prebuilt snapshot no longer exists");
        }
        const currentState = parseDaytonaSnapshotState(current.state);
        if (currentState === "active") return;
        if (
          currentState === "error" ||
          currentState === "build_failed" ||
          currentState === "removing"
        ) {
          throw new PrebuiltImageUnavailableError(
            `Daytona prebuilt snapshot is ${currentState} and cannot be used`
          );
        }
        if (Date.now() >= deadline) {
          throw new PrebuiltImageActivationPendingError(
            `Daytona prebuilt snapshot is still ${currentState}`
          );
        }
        await delayUnlessCancelled(LIFECYCLE_POLL_INTERVAL_MS, signal);
      }
    } catch (error) {
      // Only an answer about this artifact may retire it. A classification
      // already made inside the flow stands; a budget that ran out and a
      // provider that could not be reached are facts about the transport, so
      // the spawn fails transiently and the image stays in rotation. An auth
      // or request error still fails hard as a permanent error that leaves
      // the image alone: it says the call was wrong, and softening it would
      // hide a broken deployment behind slow spawns.
      if (error instanceof SandboxProviderError) throw error;
      if (signal.aborted) {
        throw new PrebuiltImageActivationPendingError(
          "Daytona prebuilt snapshot did not become usable within the activation budget",
          error instanceof Error ? error : undefined
        );
      }
      if (error instanceof DaytonaNotFoundError) {
        throw new PrebuiltImageUnavailableError(
          "Daytona prebuilt snapshot no longer exists",
          error
        );
      }
      const unreachable = daytonaUnreachableReason(error);
      if (unreachable) {
        throw new PrebuiltImageActivationPendingError(
          `Daytona could not confirm the prebuilt snapshot (${unreachable})`,
          error instanceof Error ? error : undefined
        );
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers (ported from config.py)
// ---------------------------------------------------------------------------

function resolvePreviewExpirySeconds(timeoutSeconds: number | undefined): number {
  if (!timeoutSeconds) return DEFAULT_PREVIEW_EXPIRY_SECONDS;
  return Math.min(86400, Math.max(900, timeoutSeconds + 300));
}

/**
 * Why Daytona could not answer for an artifact right now, or null when the
 * failure is an answer.
 *
 * A rate-limited or unavailable API, and a request that never completed, say
 * nothing about the snapshot they were asked about; a rejected or malformed
 * request does. Only the second kind may retire an image, so only the first
 * is named here. The reason carries the status and nothing else: response
 * bodies never travel in it.
 */
function daytonaUnreachableReason(error: unknown): string | null {
  if (error instanceof DaytonaApiError) {
    return error.status === 429 || error.status >= 500 ? `HTTP ${error.status}` : null;
  }
  if (error instanceof DaytonaCancelledError) return "the request was cancelled";
  if (error instanceof Error && error.name === "AbortError") return "the request timed out";
  return SandboxProviderError.isTransientNetworkError(error)
    ? "the request did not complete"
    : null;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createDaytonaProvider(
  client: DaytonaRestClient,
  providerConfig: DaytonaProviderConfig
): DaytonaSandboxProvider {
  return new DaytonaSandboxProvider(client, providerConfig);
}
