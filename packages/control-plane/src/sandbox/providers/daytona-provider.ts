/**
 * Daytona sandbox provider — calls the Daytona REST API directly.
 *
 * Ports env-var assembly, label construction, tunnel-URL generation, and
 * code-server password derivation that previously lived in the Python shim.
 *
 * Prebuilt images (snapshots): the image-build workflow runs
 * `.openinspect/setup.sh` once in a temporary source sandbox
 * (triggerImageBuild), and finalization captures that sandbox's filesystem
 * into a named snapshot the adapter reconciles. A prebuilt spawn is then an
 * ordinary create with that snapshot in place of the base one.
 *
 * Daytona's capture preserves the container's configuration, which is why the
 * build's credentials never ride its create request: the source is created
 * dormant, and the build is launched over the toolbox's stdin channel once
 * its id is bound. A session created from the resulting image therefore
 * starts the ordinary runtime with its own fresh identity — the markers below
 * are set explicitly on every create so a value baked into an image can never
 * decide how a session boots.
 */

import type { SandboxSettings } from "@open-inspect/shared/types/integrations";
import { resolveServicePorts, resolveTunnelPorts } from "./port-resolution";
import { createLogger } from "../../logger";
import type { SourceControlProviderName } from "../../source-control";
import type {
  DaytonaRestClient,
  DaytonaCreateSandboxParams,
  DaytonaSandboxResponse,
  DaytonaSandboxState,
  DaytonaSnapshotResponse,
  DaytonaToolboxTarget,
} from "../daytona-rest-client";
import {
  DaytonaApiError,
  DaytonaCancelledError,
  DaytonaNotFoundError,
  daytonaBuildResourceName,
  delayUnlessCancelled,
  parseDaytonaSandboxState,
  parseDaytonaSnapshotState,
} from "../daytona-rest-client";
import {
  buildSandboxEnvVars,
  DEFERRED_START_ENV_VAR,
  deriveCodeServerPassword,
  deriveVncPassword,
  IMAGE_BUILD_CONTEXT_START_ARGUMENT,
  IMAGE_BUILD_MODE_ENV_VAR,
  imageBuildSandboxIdentity,
  scmCloneIdentity,
  type ScmCloneIdentity,
} from "../sandbox-env";
import {
  PrebuiltImageActivationPendingError,
  SandboxProviderError,
  type CreateSandboxConfig,
  type CreateSandboxResult,
  type ImageBuildProviderTriggerConfig,
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

const DEFAULT_PREVIEW_EXPIRY_SECONDS = 3900;

const SECONDS_PER_MINUTE = 60;
const MS_PER_MINUTE = 60_000;

// ---------------------------------------------------------------------------
// Image-build constants
// ---------------------------------------------------------------------------

/** The one process session a build source ever opens. */
const BUILD_PROCESS_SESSION_ID = "oi-build";

/**
 * The launch command. Static and secret-free by construction: everything the
 * build needs arrives on the command's stdin, which Daytona is asked not to
 * echo into its command log.
 */
const IMAGE_BUILD_LAUNCH_COMMAND = `python -m sandbox_runtime.entrypoint ${IMAGE_BUILD_CONTEXT_START_ARGUMENT}`;

/** Wire version of the launch context (sandbox_runtime/image_build_context_start.py). */
const IMAGE_BUILD_CONTEXT_VERSION = 1;

/**
 * Wall-clock end of a build source's hard TTL, recorded as a label so
 * finalization can bound its capture deadline by the lifetime of the sandbox
 * it must capture — without depending on a create response it may never have
 * seen.
 */
const BUILD_EXPIRES_AT_LABEL = "openinspect_expires_at";

/** Daytona reads 0 as "the maximum interval", which is what a build source wants. */
const MAX_AUTO_ARCHIVE_INTERVAL = 0;

const LIFECYCLE_POLL_INTERVAL_MS = 2_000;
const BUILD_START_TIMEOUT_MS = 120_000;
/** Long enough for the launcher to reject an unusable context and exit. */
const BUILD_LAUNCH_SETTLE_MS = 3_000;
const BUILD_STOP_TIMEOUT_MS = 60_000;
/** Deletion is asynchronous; this is how long one cleanup attempt watches it. */
const CLEANUP_POLL_TIMEOUT_MS = 30_000;
/** How long the trigger path's own compensating delete may take. */
const BUILD_COMPENSATION_DELETE_MS = 5_000;
/** How long a spawn waits for a cold prebuilt image before falling back to base. */
const PREBUILT_ACTIVATION_TIMEOUT_MS = 45_000;

/** States a sandbox never leaves for a state anything can be done from. */
const TERMINAL_SANDBOX_STATES = new Set<DaytonaSandboxState>([
  "destroyed",
  "destroying",
  "error",
  "build_failed",
]);

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
    supportsSandboxTimeout: false,
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

      const envVars = await this.buildEnvVars(config);
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

      // Preview URLs are user-facing extras, not how a session runs: the
      // runtime dials the control plane itself. Failing the create here would
      // throw away the only handle to a live sandbox that has no hard TTL, so
      // the create reports the id it was given and the access fields stay
      // empty until the next resume issues them.
      let codeServerUrl: string | undefined;
      let codeServerPassword: string | undefined;
      let vncAccess: VncAccess | undefined;
      let tunnelUrls: Record<string, string> | undefined;
      try {
        const tunnels = await this.buildTunnelUrls(
          sandbox.id,
          config.sandboxId,
          config.timeoutSeconds,
          config.codeServerEnabled,
          config.vncEnabled,
          config.sandboxSettings
        );
        codeServerUrl = tunnels.codeServerUrl;
        codeServerPassword = tunnels.codeServerPassword;
        vncAccess = tunnels.vncAccess;
        tunnelUrls = tunnels.tunnelUrls;
      } catch (tunnelError) {
        log.warn("daytona.create_tunnel_urls_failed", {
          sandbox_id: config.sandboxId,
          error: tunnelError instanceof Error ? tunnelError.message : String(tunnelError),
        });
      }

      return {
        sandboxId: config.sandboxId,
        providerObjectId: sandbox.id,
        createdAt: Date.now(),
        codeServerUrl,
        codeServerPassword,
        vncAccess,
        tunnelUrls,
      };
    } catch (error) {
      // Already classified (the prebuilt-image guards) — rethrow so the
      // manager can tell a cold image from a broken one.
      if (error instanceof SandboxProviderError) throw error;
      throw this.classifyError("Failed to create Daytona sandbox", error);
    }
  }

  async resumeSandbox(config: ResumeConfig): Promise<ResumeResult> {
    try {
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
      let codeServerUrl: string | undefined;
      let codeServerPassword: string | undefined;
      let vncAccess: VncAccess | undefined;
      let tunnelUrls: Record<string, string> | undefined;
      try {
        const tunnels = await this.buildTunnelUrls(
          config.providerObjectId,
          config.sandboxId,
          config.timeoutSeconds,
          config.codeServerEnabled,
          config.vncEnabled,
          config.sandboxSettings
        );
        codeServerUrl = tunnels.codeServerUrl;
        codeServerPassword = tunnels.codeServerPassword;
        vncAccess = tunnels.vncAccess;
        tunnelUrls = tunnels.tunnelUrls;
      } catch (tunnelError) {
        log.warn("daytona.resume_tunnel_urls_failed", {
          sandbox_id: config.sandboxId,
          error: tunnelError instanceof Error ? tunnelError.message : String(tunnelError),
        });
      }

      return {
        success: true,
        providerObjectId: sandbox.id,
        codeServerUrl,
        codeServerPassword,
        vncAccess,
        tunnelUrls,
      };
    } catch (error) {
      if (error instanceof SandboxProviderError) throw error;
      throw this.classifyError("Failed to resume Daytona sandbox", error);
    }
  }

  async stopSandbox(config: StopConfig): Promise<StopResult> {
    try {
      try {
        if (config.reason === "respawn") {
          await this.client.deleteSandbox(
            config.providerObjectId,
            ...(config.signal ? [config.signal] : [])
          );
        } else {
          await this.client.stopSandbox(config.providerObjectId);
        }
      } catch (error) {
        if (error instanceof DaytonaNotFoundError) {
          return { success: true };
        }
        throw error;
      }
      return { success: true };
    } catch (error) {
      if (error instanceof SandboxProviderError) throw error;
      throw this.classifyError(
        `Failed to ${config.reason === "respawn" ? "delete" : "stop"} Daytona sandbox`,
        error
      );
    }
  }

  // -----------------------------------------------------------------------
  // Env var assembly (ported from service.py _build_env)
  // -----------------------------------------------------------------------

  private async buildEnvVars(config: CreateSandboxConfig): Promise<Record<string, string>> {
    const envVars = buildSandboxEnvVars(config, {
      scmIdentity: this.cloneIdentity(),
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
    codeServerEnabled: boolean | undefined,
    vncEnabled: boolean | undefined,
    sandboxSettings: SandboxSettings | undefined
  ): Promise<{
    codeServerUrl?: string;
    codeServerPassword?: string;
    vncAccess?: VncAccess;
    tunnelUrls?: Record<string, string>;
  }> {
    const expirySeconds = resolvePreviewExpirySeconds(timeoutSeconds);
    const { codeServerPort, vncPort } = resolveServicePorts(sandboxSettings);
    let tunnelPorts = resolveTunnelPorts(sandboxSettings?.tunnelPorts);
    let codeServerUrl: string | undefined;
    let codeServerPassword: string | undefined;
    let vncAccess: VncAccess | undefined;

    if (codeServerEnabled) {
      const preview = await this.client.getSignedPreviewUrl(
        daytonaSandboxId,
        codeServerPort,
        expirySeconds
      );
      codeServerUrl = preview.url;
      codeServerPassword = await deriveCodeServerPassword(
        logicalSandboxId,
        this.providerConfig.sandboxAccessPasswordSecret
      );
      tunnelPorts = tunnelPorts.filter((p) => p !== codeServerPort);
    }

    if (vncEnabled) {
      const preview = await this.client.getSignedPreviewUrl(
        daytonaSandboxId,
        vncPort,
        expirySeconds
      );
      const password = await deriveVncPassword(
        logicalSandboxId,
        this.providerConfig.sandboxAccessPasswordSecret
      );
      vncAccess = { url: preview.url, password };
      tunnelPorts = tunnelPorts.filter((p) => p !== vncPort);
    }

    let tunnelUrls: Record<string, string> | undefined;
    if (tunnelPorts.length > 0) {
      const entries = await Promise.all(
        tunnelPorts.map(async (port) => {
          const preview = await this.client.getSignedPreviewUrl(
            daytonaSandboxId,
            port,
            expirySeconds
          );
          return [String(port), preview.url] as const;
        })
      );
      tunnelUrls = Object.fromEntries(entries);
    }

    return { codeServerUrl, codeServerPassword, vncAccess, tunnelUrls };
  }

  // -----------------------------------------------------------------------
  // Image-build source lifecycle
  // -----------------------------------------------------------------------

  /**
   * Start a Daytona image build.
   *
   * Daytona's container capture preserves the container's configuration —
   * environment included — so nothing secret may ride the create request.
   * The source is created dormant instead (`OI_DEFERRED_START`), which makes
   * the create safe to issue before anything is bound; its id is bound; and
   * only then is the build launched, over the toolbox's stdin channel, with
   * the whole build context in one line the provider is asked not to echo.
   *
   * Ordering is the contract: nothing repository-shaped runs before the bind,
   * so a build that reports completion is always a build whose row names the
   * sandbox that reported it.
   */
  async triggerImageBuild(config: ImageBuildProviderTriggerConfig): Promise<void> {
    const identity = imageBuildSandboxIdentity(config, Date.now());
    const sourceName = await daytonaBuildResourceName("source", config.buildId);
    const ttlMinutes = Math.ceil(config.providerSessionTimeoutSeconds / SECONDS_PER_MINUTE);
    const expiresAt = Date.now() + ttlMinutes * MS_PER_MINUTE;

    let sandboxId: string | undefined;
    try {
      const params: DaytonaCreateSandboxParams = {
        name: sourceName,
        snapshot: this.client.requireBaseSnapshot(),
        // The only two values a capture may inherit: neither is secret, and
        // the launcher clears the dormant marker before the build composes.
        env: { [DEFERRED_START_ENV_VAR]: "true", PYTHONUNBUFFERED: "1" },
        labels: { ...identity.labels, [BUILD_EXPIRES_AT_LABEL]: String(expiresAt) },
        // A long quiet setup hook must not look idle, and a stopped source
        // must survive until finalization captures it: no auto-stop, and the
        // longest archive interval the deployment allows. The hard TTL is
        // what ends this sandbox.
        autoStopInterval: 0,
        autoArchiveInterval: MAX_AUTO_ARCHIVE_INTERVAL,
        ttlMinutes,
        public: false,
      };
      if (this.client.config.target) {
        params.target = this.client.config.target;
      }

      const created = await this.client.createSandbox(params);
      sandboxId = created.id;
      // Reject a hostile or empty id BEFORE binding it: the id is persisted
      // as the build's provider session and addressed in toolbox paths.
      assertSafeProviderSessionId(created.id);
      await config.onProviderSessionCreated(created.id);

      const started = await this.awaitSandboxState(created.id, "started", BUILD_START_TIMEOUT_MS);
      const target: DaytonaToolboxTarget = {
        sandboxId: created.id,
        baseUrl: await this.client.resolveToolboxBaseUrl(created.id, { sandbox: started }),
      };
      await this.client.createProcessSession(target, BUILD_PROCESS_SESSION_ID);
      const command = await this.client.executeSessionCommand(
        target,
        BUILD_PROCESS_SESSION_ID,
        IMAGE_BUILD_LAUNCH_COMMAND
      );
      await this.client.sendSessionCommandInput(
        target,
        BUILD_PROCESS_SESSION_ID,
        command.cmdId,
        buildLaunchContextLine(config, created.id, identity.sandboxId, this.cloneIdentity())
      );

      // The launcher rejects an unusable context before it composes anything,
      // and exits. Give it a moment, then read the exit status: a build that
      // already refused its own launch must fail the trigger rather than be
      // waited on until the callback times out.
      await delayUnlessCancelled(BUILD_LAUNCH_SETTLE_MS);
      const launched = await this.client.getSessionCommand(
        target,
        BUILD_PROCESS_SESSION_ID,
        command.cmdId
      );
      if (typeof launched.exitCode === "number" && launched.exitCode !== 0) {
        throw new SandboxProviderError(
          `Daytona image-build launcher exited ${launched.exitCode}`,
          "permanent"
        );
      }

      log.info("daytona.image_build_triggered", {
        build_id: config.buildId,
        scope_kind: config.scopeKind,
        scope_id: config.scopeId,
        sandbox_id: created.id,
        request_id: config.correlation.request_id,
        trace_id: config.correlation.trace_id,
      });
    } catch (error) {
      // Anything after create leaves a sandbox that can never build; delete it
      // rather than leak it until its TTL. A failed compensation is logged and
      // left to maintenance, which finds the source by the same reserved name.
      if (sandboxId) {
        await this.deleteBuildSandboxBestEffort(sandboxId, config.buildId);
      }
      if (error instanceof SandboxProviderError) throw error;
      throw this.classifyError("Failed to trigger Daytona image build", error);
    }
  }

  /**
   * Bring a build source to `stopped`, the only state Daytona captures from.
   *
   * Reports back rather than throwing when the sandbox is merely still
   * stopping: that is a pending finalization, not a failure. A source that
   * has reached a terminal state can never be captured, and says so.
   */
  async stopBuildSandboxForCapture(
    providerSessionId: string,
    signal?: AbortSignal
  ): Promise<"stopped" | "stopping"> {
    const sandbox = await this.client.getSandbox(providerSessionId, signal);
    const state = parseDaytonaSandboxState(sandbox.state);
    if (state === "stopped") return "stopped";
    if (TERMINAL_SANDBOX_STATES.has(state)) {
      throw new SandboxProviderError(
        `Daytona build sandbox is ${state} and can no longer be captured`,
        "permanent"
      );
    }
    if (state !== "stopping") {
      await this.client.stopSandbox(providerSessionId, signal);
    }
    return (await this.pollSandboxState(
      providerSessionId,
      "stopped",
      BUILD_STOP_TIMEOUT_MS,
      signal
    ))
      ? "stopped"
      : "stopping";
  }

  /**
   * Ask Daytona to capture a stopped source's filesystem under `snapshotName`.
   *
   * Acceptance is not an artifact: the response is the source sandbox, and
   * only a snapshot lookup can say whether the capture produced anything. A
   * name that already exists is accepted too — the caller reserved it, so
   * reconciling it is exactly the right next step.
   */
  async captureBuildSnapshot(
    providerSessionId: string,
    snapshotName: string,
    signal?: AbortSignal
  ): Promise<void> {
    try {
      await this.client.createSandboxSnapshot(
        providerSessionId,
        { name: snapshotName, includeMemory: false },
        signal
      );
    } catch (error) {
      if (error instanceof DaytonaApiError && error.status === 409) return;
      throw error;
    }
  }

  /** The snapshot under `nameOrId`, or null when the provider has none. */
  async getBuildSnapshot(
    nameOrId: string,
    signal?: AbortSignal
  ): Promise<DaytonaSnapshotResponse | null> {
    try {
      return await this.client.getSnapshot(nameOrId, signal);
    } catch (error) {
      if (error instanceof DaytonaNotFoundError) return null;
      throw error;
    }
  }

  /** Bring an inactive snapshot back. Takes the immutable id, never a name. */
  async activateBuildSnapshot(snapshotId: string, signal?: AbortSignal): Promise<void> {
    await this.client.activateSnapshot(snapshotId, signal);
  }

  /**
   * Read a build's bound source sandbox, refusing one whose labels say it
   * belongs to another build. Null when the provider no longer has it.
   */
  async getBuildSandbox(
    providerSessionId: string,
    expectedBuildId: string,
    signal?: AbortSignal
  ): Promise<DaytonaSandboxResponse | null> {
    let sandbox: DaytonaSandboxResponse;
    try {
      sandbox = await this.client.getSandbox(providerSessionId, signal);
    } catch (error) {
      if (error instanceof DaytonaNotFoundError) return null;
      throw error;
    }
    if (!ownsBuildSource(sandbox, expectedBuildId)) {
      throw new SandboxProviderError(
        "Daytona sandbox does not carry this build's ownership labels",
        "permanent"
      );
    }
    return sandbox;
  }

  /**
   * Find a build's source sandbox by the name reserved for it, for a create
   * whose response never arrived. Ownership is checked before the caller is
   * told anything: a name collision must never hand back someone else's
   * sandbox for deletion.
   */
  async findBuildSandboxByName(
    buildId: string,
    signal?: AbortSignal
  ): Promise<DaytonaSandboxResponse | null> {
    const name = await daytonaBuildResourceName("source", buildId);
    let sandbox: DaytonaSandboxResponse;
    try {
      sandbox = await this.client.getSandbox(name, signal);
    } catch (error) {
      if (error instanceof DaytonaNotFoundError) return null;
      throw error;
    }
    return ownsBuildSource(sandbox, buildId) ? sandbox : null;
  }

  /**
   * Delete the exact temporary source of one build.
   *
   * Ownership is verified against the build labels before anything
   * destructive happens, and deletion is observed to completion: Daytona's
   * delete is asynchronous, so HTTP acceptance is not reclamation. A source
   * still destroying when the budget runs out leaves the obligation pending
   * rather than reporting a teardown that has not happened.
   */
  async deleteBuildSandbox(
    providerSessionId: string,
    expectedBuildId: string,
    signal?: AbortSignal
  ): Promise<void> {
    const sandbox = await this.getBuildSandbox(providerSessionId, expectedBuildId, signal);
    if (!sandbox) return;

    const state = parseDaytonaSandboxState(sandbox.state);
    if (state === "destroyed") return;
    if (state !== "destroying") {
      try {
        await this.client.deleteSandbox(providerSessionId, signal);
      } catch (error) {
        if (!(error instanceof DaytonaNotFoundError)) throw error;
        return;
      }
    }
    if (await this.pollSandboxAbsent(providerSessionId, CLEANUP_POLL_TIMEOUT_MS, signal)) return;
    throw new SandboxProviderError("Daytona build sandbox is still being destroyed", "transient");
  }

  /**
   * Delete one captured snapshot by its immutable id, confirming it is gone.
   *
   * Refuses the configured base snapshot outright: an artifact reference that
   * somehow names the base image would otherwise take the deployment's
   * ability to start any sandbox with it.
   */
  async deleteProviderImage(providerImageId: string, signal?: AbortSignal): Promise<void> {
    const baseSnapshot = this.client.config.baseSnapshot;
    if (baseSnapshot && providerImageId === baseSnapshot) {
      throw new SandboxProviderError(
        "Refusing to delete the configured Daytona base snapshot",
        "permanent"
      );
    }

    const snapshot = await this.getBuildSnapshot(providerImageId, signal);
    if (!snapshot) return;
    if (baseSnapshot && snapshot.name === baseSnapshot) {
      throw new SandboxProviderError(
        "Refusing to delete the configured Daytona base snapshot",
        "permanent"
      );
    }
    // Already being reclaimed: acceptance is not reclamation, so the
    // obligation stays until a lookup says it is gone.
    if (parseDaytonaSnapshotState(snapshot.state) !== "removing") {
      try {
        await this.client.deleteSnapshot(snapshot.id, signal);
      } catch (error) {
        if (error instanceof DaytonaNotFoundError) return;
        throw error;
      }
    }
    if (await this.pollSnapshotAbsent(snapshot.id, CLEANUP_POLL_TIMEOUT_MS, signal)) return;
    throw new SandboxProviderError("Daytona snapshot is still being removed", "transient");
  }

  // -----------------------------------------------------------------------
  // Build lifecycle internals
  // -----------------------------------------------------------------------

  private cloneIdentity(): ScmCloneIdentity {
    return scmCloneIdentity(this.providerConfig.scmProvider);
  }

  private async deleteBuildSandboxBestEffort(
    providerSessionId: string,
    buildId: string
  ): Promise<void> {
    // Bounded well under the request that runs it: whether or not this
    // confirms the deletion, the build's cleanup obligation is already
    // recorded, and maintenance owns whatever is left.
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), BUILD_COMPENSATION_DELETE_MS);
    try {
      await this.deleteBuildSandbox(providerSessionId, buildId, controller.signal);
    } catch (error) {
      log.warn("daytona.build_cleanup_delete_failed", {
        build_id: buildId,
        sandbox_id: providerSessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /** Wait for one expected state, failing fast on a terminal one. */
  private async awaitSandboxState(
    providerSessionId: string,
    expected: DaytonaSandboxState,
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<DaytonaSandboxResponse> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const sandbox = await this.client.getSandbox(providerSessionId, signal);
      const state = parseDaytonaSandboxState(sandbox.state);
      if (state === expected) return sandbox;
      if (TERMINAL_SANDBOX_STATES.has(state)) {
        throw new SandboxProviderError(
          `Daytona sandbox entered ${state} while waiting for ${expected}`,
          "permanent"
        );
      }
      if (Date.now() >= deadline) {
        throw new SandboxProviderError(
          `Daytona sandbox did not reach ${expected} in time (last state ${state})`,
          "transient"
        );
      }
      await delayUnlessCancelled(LIFECYCLE_POLL_INTERVAL_MS, signal);
    }
  }

  /** Whether the sandbox reached `expected` within the budget. */
  private async pollSandboxState(
    providerSessionId: string,
    expected: DaytonaSandboxState,
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const sandbox = await this.client.getSandbox(providerSessionId, signal);
      const state = parseDaytonaSandboxState(sandbox.state);
      if (state === expected) return true;
      if (TERMINAL_SANDBOX_STATES.has(state)) {
        throw new SandboxProviderError(
          `Daytona sandbox entered ${state} while waiting for ${expected}`,
          "permanent"
        );
      }
      if (Date.now() >= deadline) return false;
      await delayUnlessCancelled(LIFECYCLE_POLL_INTERVAL_MS, signal);
    }
  }

  private async pollSandboxAbsent(
    providerSessionId: string,
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        const sandbox = await this.client.getSandbox(providerSessionId, signal);
        if (parseDaytonaSandboxState(sandbox.state) === "destroyed") return true;
      } catch (error) {
        if (error instanceof DaytonaNotFoundError) return true;
        throw error;
      }
      if (Date.now() >= deadline) return false;
      await delayUnlessCancelled(LIFECYCLE_POLL_INTERVAL_MS, signal);
    }
  }

  private async pollSnapshotAbsent(
    snapshotId: string,
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (!(await this.getBuildSnapshot(snapshotId, signal))) return true;
      if (Date.now() >= deadline) return false;
      await delayUnlessCancelled(LIFECYCLE_POLL_INTERVAL_MS, signal);
    }
  }

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
   * waited for. An activation that outlasts the budget is reported as pending
   * so the session falls back to base WITHOUT retiring the image — unlike a
   * missing or terminal snapshot, which must be failed so the next
   * reconciliation rebuilds it.
   */
  private async ensurePrebuiltImageUsable(prebuiltImageId: string): Promise<void> {
    const deadline = Date.now() + PREBUILT_ACTIVATION_TIMEOUT_MS;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), PREBUILT_ACTIVATION_TIMEOUT_MS);
    const signal = controller.signal;
    try {
      const snapshot = await this.getBuildSnapshot(prebuiltImageId, signal);
      if (!snapshot) {
        throw new SandboxProviderError("Daytona prebuilt snapshot no longer exists", "permanent");
      }
      const state = parseDaytonaSnapshotState(snapshot.state);
      if (state === "active") return;
      if (state === "error" || state === "build_failed" || state === "removing") {
        throw new SandboxProviderError(
          `Daytona prebuilt snapshot is ${state} and cannot be used`,
          "permanent"
        );
      }

      if (state === "inactive") {
        await this.activateBuildSnapshot(snapshot.id, signal);
      }
      for (;;) {
        const current = await this.getBuildSnapshot(snapshot.id, signal);
        // A snapshot that is gone, or on its way out, is gone for the same
        // reason the pre-activation read gives: waiting it out would spend
        // the budget and then report an artifact worth keeping.
        if (!current) {
          throw new SandboxProviderError("Daytona prebuilt snapshot no longer exists", "permanent");
        }
        const currentState = parseDaytonaSnapshotState(current.state);
        if (currentState === "active") return;
        if (
          currentState === "error" ||
          currentState === "build_failed" ||
          currentState === "removing"
        ) {
          throw new SandboxProviderError(
            `Daytona prebuilt snapshot is ${currentState} and cannot be used`,
            "permanent"
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
      // the spawn falls back to base and the image stays in rotation. An
      // auth or request error still fails hard: it says the call was wrong,
      // and softening it would hide a broken deployment behind slow spawns.
      if (error instanceof SandboxProviderError) throw error;
      if (signal.aborted) {
        throw new PrebuiltImageActivationPendingError(
          "Daytona prebuilt snapshot did not become usable within the activation budget",
          error instanceof Error ? error : undefined
        );
      }
      if (error instanceof DaytonaNotFoundError) {
        throw new SandboxProviderError(
          "Daytona prebuilt snapshot no longer exists",
          "permanent",
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

  // -----------------------------------------------------------------------
  // Error classification
  // -----------------------------------------------------------------------

  private classifyError(message: string, error: unknown): SandboxProviderError {
    if (error instanceof DaytonaCancelledError) {
      // The budget ran out, not the provider: the obligation stays pending.
      return new SandboxProviderError(`${message}: ${error.message}`, "transient", error);
    }
    if (error instanceof DaytonaApiError) {
      return SandboxProviderError.fromFetchError(
        `${message}: ${error.message}`,
        error,
        error.status
      );
    }
    return SandboxProviderError.fromFetchError(message, error);
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

/**
 * The Daytona-issued id is persisted as the build's provider session and
 * addressed in toolbox paths — reject anything empty or outside the charset
 * before either use.
 */
function assertSafeProviderSessionId(providerSessionId: string): void {
  if (!/^[A-Za-z0-9_-]+$/.test(providerSessionId)) {
    throw new SandboxProviderError("Unsafe Daytona sandbox id for an image build", "permanent");
  }
}

/**
 * Whether a sandbox found under a build's reserved name is that build's.
 *
 * A name is not ownership: it can be reused, and a resource recovered by name
 * is only ever acted on destructively when its labels say this framework and
 * this build id created it.
 */
function ownsBuildSource(sandbox: DaytonaSandboxResponse, buildId: string): boolean {
  const labels = sandbox.labels ?? undefined;
  return (
    labels?.openinspect_framework === "open-inspect" &&
    labels.openinspect_kind === "environment-image-build" &&
    labels.openinspect_build_id === buildId
  );
}

/**
 * The one line written to the build launcher's stdin: everything the build
 * needs, and nothing the provider's container configuration will ever see.
 */
function buildLaunchContextLine(
  config: ImageBuildProviderTriggerConfig,
  providerSessionId: string,
  sandboxId: string,
  scmIdentity: ScmCloneIdentity
): string {
  const context = {
    version: IMAGE_BUILD_CONTEXT_VERSION,
    build_id: config.buildId,
    provider_session_id: providerSessionId,
    sandbox_id: sandboxId,
    callback_url: config.callbackUrl,
    failure_callback_url: config.failureCallbackUrl,
    callback_token: config.callbackToken,
    execution_timeout_seconds: config.buildExecutionTimeoutSeconds,
    repositories: config.repositories.map((repository) => ({
      repo_owner: repository.repoOwner,
      repo_name: repository.repoName,
      branch: repository.baseBranch,
    })),
    // Host and username travel even when no token could be brokered, so the
    // credential helper still targets the configured SCM.
    clone: {
      host: scmIdentity.host,
      username: scmIdentity.cloneUsername,
      ...(config.cloneToken ? { token: config.cloneToken } : {}),
    },
    env: config.userEnvVars ?? {},
  };
  return `${JSON.stringify(context)}\n`;
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
