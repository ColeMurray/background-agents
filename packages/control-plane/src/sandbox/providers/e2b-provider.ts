/**
 * E2B sandbox provider — calls the E2B REST API directly.
 *
 * Stop is a resumable pause (like Daytona's stop), so the shared lifecycle
 * manager's persistent-resume path drives idle-pause and resume with no
 * E2B-specific plumbing. Sandboxes are created with auto-pause (a lapsed TTL pauses
 * recoverably rather than killing) and secure envd access; provider-side auto-resume is
 * disabled so resume stays control-plane-driven (connectSandbox) and stray traffic can't
 * wake a paused box. Per-session env is delivered via an envd file write because the
 * template's start command runs at build time.
 *
 * Prebuilt images (snapshots): the image-build workflow runs `.openinspect/setup.sh`
 * once in a build sandbox (triggerImageBuild), then bakes its filesystem into a
 * reusable snapshot template (takePrebuiltImageSnapshot →
 * `POST /sandboxes/{id}/snapshots`). The snapshot id doubles as a `templateID`, so a
 * prebuilt spawn is just a create with that id in place of the base template. The
 * snapshot resumes oi-launch in its env wait loop, where it reads the freshly written
 * per-session env — so prebuilt boots reuse the baked filesystem while still getting
 * fresh session config.
 */

import type { SandboxSettings } from "@open-inspect/shared/types/integrations";
import { createLogger } from "../../logger";
import {
  buildImageBuildCallbackEnv,
  buildImageBuildEnvVars,
  IMAGE_BUILD_EXECUTION_TIMEOUT_ENV_KEY,
  buildSandboxEnvVars,
  deriveCodeServerPassword,
  deriveVncPassword,
  imageBuildSandboxIdentity,
  scmCloneIdentity,
} from "../sandbox-env";
import { SANDBOX_RUNTIME_VERSION } from "../runtime-manifest";
import { resolveServicePorts, resolveTunnelPorts } from "./port-resolution";
import type { SourceControlProviderName } from "../../source-control";
import type { E2BRestClient, E2BSandboxCreated, E2BSandboxDetail } from "../e2b-rest-client";
import { E2BApiError, E2BConflictError, E2BNotFoundError } from "../e2b-rest-client";
import {
  DEFAULT_SANDBOX_TIMEOUT_SECONDS,
  SandboxProviderError,
  createVncAccess,
  type CreateSandboxConfig,
  type CreateSandboxResult,
  type ImageBuildProviderTriggerConfig,
  type ResumeConfig,
  type ResumeResult,
  type SandboxProvider,
  type SandboxProviderCapabilities,
  type SnapshotConfig,
  type SnapshotResult,
  type StopConfig,
  type StopResult,
} from "../provider";

const log = createLogger("e2b-provider");

/** Sandbox TTL default. Hobby plans (~1h cap) should lower this via config. */
export const DEFAULT_E2B_SANDBOX_TIMEOUT_SECONDS = DEFAULT_SANDBOX_TIMEOUT_SECONDS;
/** Default to a recoverable stop: pause on TTL (not kill), so it stays resumable. */
export const DEFAULT_E2B_AUTO_PAUSE = true;

/**
 * Runtime version reported by E2B build sandboxes, so spawn-time selection can
 * gate on the compatibility floor (MIN_COMPATIBLE_RUNTIME_VERSION). E2B does not
 * propagate the Dockerfile's SANDBOX_VERSION to the runtime process, so builds
 * get it from the session env instead.
 *
 * Derived from the manifest rather than pinned, exactly as VERCEL_SANDBOX_VERSION
 * is: a literal here silently drifts below the floor when the manifest bumps, and
 * every image built under it is then rejected as runtime_below_floor.
 */
export const E2B_SANDBOX_VERSION = SANDBOX_RUNTIME_VERSION;

/**
 * TTL for the brief cold-boot between the sanitizing pause and createSnapshot
 * during an image build. Only needs to outlive the snapshot call; the build
 * sandbox is killed immediately afterwards.
 */
const SNAPSHOT_CONNECT_TIMEOUT_SECONDS = 300;

export interface E2BProviderConfig {
  scmProvider: SourceControlProviderName;
  /** Secret used for domain-separated sandbox access password derivation. */
  sandboxAccessPasswordSecret: string;
  sandboxTimeoutSeconds: number;
  /**
   * Pause (not kill) when the sandbox TTL expires, so it stays resumable. Resume is
   * control-plane-driven (connectSandbox); provider-side auto-resume is not used.
   */
  autoPause: boolean;
}

type E2BOperation = "create" | "resume" | "stop" | "snapshot" | "delete";

export class E2BSandboxProvider implements SandboxProvider {
  readonly name = "e2b";

  /**
   * Stop reasons after which the provider object cannot be resumed, including
   * replacement by a newly-created sandbox.
   */
  private static readonly TERMINAL_STOP_REASONS = new Set(["connecting_timeout", "respawn"]);

  /**
   * Session continuity on E2B is provider-managed: stop pauses the sandbox and
   * resume reconnects to it, so there is no session snapshot/restore pair here.
   *
   * Adding one would be a second, losing mechanism. `evaluateSpawnDecision`
   * consults `supportsPersistentResume` before `snapshotImageId`, so a
   * stopped/stale E2B sandbox always resumes; and when resume gives up
   * (`shouldSpawnFresh`) the manager spawns fresh rather than consulting a
   * snapshot. On top of that, every E2B snapshot is a durable template in the
   * team account with no TTL — unlike Vercel's expiring snapshots — so a
   * per-execution `takeSnapshot` would leak one template per turn.
   *
   * Prebuilt images are unaffected: they spawn through createSandbox with the
   * image id as the templateID, and are baked by takePrebuiltImageSnapshot.
   */
  readonly capabilities: SandboxProviderCapabilities = {
    supportsSandboxTimeout: true,
    supportsSnapshots: false,
    supportsRestore: false,
    // Stop is a resumable pause; the manager treats it as provider-managed state.
    supportsPersistentResume: true,
    supportsExplicitStop: true,
  };

  constructor(
    private readonly client: E2BRestClient,
    private readonly providerConfig: E2BProviderConfig
  ) {}

  async createSandbox(config: CreateSandboxConfig): Promise<CreateSandboxResult> {
    try {
      // A prebuilt image id is an E2B snapshot template id — spawn from it instead
      // of the base template and mark the boot so the runtime skips setup.sh (it
      // ran at build time). Otherwise fall back to the base template.
      const extraEnv: Record<string, string> = {};
      if (config.prebuiltImageId) {
        extraEnv.FROM_REPO_IMAGE = "true";
        extraEnv.REPO_IMAGE_SHA = config.prebuiltImageSha ?? "";
      }

      const timeoutSeconds = config.timeoutSeconds ?? this.providerConfig.sandboxTimeoutSeconds;
      const { envVars, codeServerPassword, vncPassword } = await this.buildRuntimeEnv(
        config,
        extraEnv
      );

      const sandbox = await this.client.createSandbox({
        templateID: config.prebuiltImageId || this.client.config.templateId,
        metadata: this.buildMetadata(config),
        timeoutSeconds,
        autoPause: this.providerConfig.autoPause,
        // Require secure envd access: the per-session env we upload carries
        // SANDBOX_AUTH_TOKEN + user secrets, so envd must reject writes lacking the
        // returned access token (otherwise the upload is anonymous over the public host).
        secure: true,
        // Deliberately NOT auto-resume: resume is control-plane-driven (resumeSandbox →
        // connectSandbox). Provider-side auto-resume would wake a paused sandbox from
        // stray inbound traffic, outside the DO state machine.
        autoResume: false,
      });

      await this.deliverSessionEnv(sandbox, envVars);

      const { codeServerUrl, vncUrl, tunnelUrls } = this.buildTunnelUrls(
        sandbox.sandboxID,
        config.codeServerEnabled,
        config.vncEnabled,
        config.sandboxSettings,
        sandbox.domain
      );

      return {
        sandboxId: config.sandboxId,
        providerObjectId: sandbox.sandboxID,
        status: "running",
        createdAt: Date.now(),
        codeServerUrl,
        codeServerPassword,
        vncAccess: createVncAccess(vncUrl, vncPassword),
        tunnelUrls,
      };
    } catch (error) {
      throw this.classifyError("Failed to create E2B sandbox", error, "create");
    }
  }

  /**
   * Bake an image-build sandbox into a reusable snapshot template, sanitized so
   * the image is a clean, quiescent cold boot rather than a frozen build process.
   *
   * A reusable E2B snapshot (`POST /sandboxes/{id}/snapshots`) captures live
   * process memory, so snapshotting the running build sandbox directly would (a)
   * bake the build supervisor and its secret env into every image and (b) resume
   * that stale process on spawn instead of a fresh launcher. To avoid both, we
   * first `pause(keepMemory:false)` — which drops all memory and persists only
   * the filesystem — then `connect`, which cold-boots the sandbox from disk,
   * re-running the launcher fresh in its env-wait state. The snapshot then
   * captures that clean state, so sandboxes spawned from it start a fresh
   * supervisor with their own per-session env (and never inherit build secrets in
   * memory).
   *
   * This is the only snapshot path E2B exposes; there is no generic
   * `takeSnapshot` (see `capabilities.supportsSnapshots`).
   */
  async takePrebuiltImageSnapshot(config: SnapshotConfig): Promise<SnapshotResult> {
    try {
      await this.client.pauseSandbox(config.providerObjectId, { memory: false }, config.signal);
      // Cold-boot from disk; connect returns once the template ready-check passes,
      // i.e. once the launcher is back up and waiting — no readiness guesswork.
      await this.client.connectSandbox(
        config.providerObjectId,
        SNAPSHOT_CONNECT_TIMEOUT_SECONDS,
        config.signal
      );
      // No name: each build gets a distinct snapshot template. Superseded images
      // are reclaimed by the reaper via deleteProviderImage, so reusing a name
      // (which would reassign builds to one template) buys nothing.
      const snapshot = await this.client.createSnapshot(config.providerObjectId, {
        signal: config.signal,
      });
      if (!snapshot.snapshotID) {
        return { success: false, error: "E2B snapshot did not return a snapshot id" };
      }
      return { success: true, imageId: snapshot.snapshotID };
    } catch (error) {
      throw this.classifyError("Failed to bake E2B image snapshot", error, "snapshot");
    }
  }

  async resumeSandbox(config: ResumeConfig): Promise<ResumeResult> {
    try {
      let sandbox: E2BSandboxDetail;
      try {
        sandbox = await this.client.getSandbox(config.providerObjectId);
      } catch (error) {
        if (error instanceof E2BNotFoundError) {
          return {
            success: false,
            error: "Sandbox no longer exists in E2B",
            shouldSpawnFresh: true,
          };
        }
        throw error;
      }

      const timeoutSeconds = config.timeoutSeconds ?? this.providerConfig.sandboxTimeoutSeconds;
      try {
        if (sandbox.state === "paused") {
          await this.client.connectSandbox(config.providerObjectId, timeoutSeconds);
        } else if (sandbox.state === "running") {
          await this.client.setSandboxTimeout(config.providerObjectId, timeoutSeconds);
        } else {
          return {
            success: false,
            error: `Sandbox in non-resumable state: ${sandbox.state}`,
            shouldSpawnFresh: true,
          };
        }
      } catch (error) {
        // The sandbox can disappear between the GET above and this call — treat a
        // late 404 the same as an initial one so the manager spawns fresh.
        if (error instanceof E2BNotFoundError) {
          return {
            success: false,
            error: "Sandbox no longer exists in E2B",
            shouldSpawnFresh: true,
          };
        }
        throw error;
      }

      const codeServerPassword = config.codeServerEnabled
        ? await deriveCodeServerPassword(
            config.sandboxId,
            this.providerConfig.sandboxAccessPasswordSecret
          )
        : undefined;
      const vncPassword = config.vncEnabled
        ? await deriveVncPassword(config.sandboxId, this.providerConfig.sandboxAccessPasswordSecret)
        : undefined;
      const { codeServerUrl, vncUrl, tunnelUrls } = this.buildTunnelUrls(
        config.providerObjectId,
        config.codeServerEnabled,
        config.vncEnabled,
        config.sandboxSettings,
        sandbox.domain
      );

      return {
        success: true,
        providerObjectId: sandbox.sandboxID,
        codeServerUrl,
        codeServerPassword,
        vncAccess: createVncAccess(vncUrl, vncPassword),
        tunnelUrls,
      };
    } catch (error) {
      throw this.classifyError("Failed to resume E2B sandbox", error, "resume");
    }
  }

  /**
   * Idle/heartbeat stops are a resumable PAUSE (the manager routes them here via
   * supportsPersistentResume, and resumeSandbox brings the sandbox back).
   * Terminal stops (a sandbox that never connected) instead KILL: the manager
   * marks that session `failed` and won't resume it, so pausing would orphan a
   * sandbox E2B retains indefinitely.
   */
  async stopSandbox(config: StopConfig): Promise<StopResult> {
    const terminal = E2BSandboxProvider.TERMINAL_STOP_REASONS.has(config.reason);
    try {
      try {
        if (terminal) {
          await this.client.killSandbox(
            config.providerObjectId,
            ...(config.signal ? [config.signal] : [])
          );
        } else {
          await this.client.pauseSandbox(config.providerObjectId);
        }
      } catch (error) {
        // Already gone or already paused — nothing to do.
        if (error instanceof E2BNotFoundError || error instanceof E2BConflictError) {
          return { success: true };
        }
        throw error;
      }
      return { success: true };
    } catch (error) {
      throw this.classifyError(
        `Failed to stop (${terminal ? "kill" : "pause"}) E2B sandbox`,
        error,
        "stop"
      );
    }
  }

  /**
   * Permanently kill a sandbox. Used to tear down the ephemeral image-build
   * sandbox once its filesystem has been snapshotted: stopSandbox only pauses
   * (correct for idle sessions) and would leak the single-use build sandbox
   * until its TTL. Idempotent — a missing sandbox is treated as already gone.
   */
  async deleteSandbox(providerObjectId: string, signal?: AbortSignal): Promise<void> {
    try {
      await this.client.killSandbox(providerObjectId, signal);
    } catch (error) {
      if (error instanceof E2BNotFoundError) return;
      throw this.classifyError("Failed to delete E2B sandbox", error, "stop");
    }
  }

  /**
   * Trigger an E2B environment-image build. A build sandbox boots from the base
   * template, clones every repository and runs `.openinspect/setup.sh` once (the
   * SESSION_CONFIG carries the repository list), reports completion via the
   * repo-image callback, then idles awaiting the snapshot taken by takeSnapshot.
   * The build sandbox does not auto-pause: its filesystem is snapshotted in place.
   */
  async triggerImageBuild(config: ImageBuildProviderTriggerConfig): Promise<void> {
    const identity = imageBuildSandboxIdentity(config, Date.now());

    let sandboxId: string | undefined;
    try {
      const sandbox = await this.client.createSandbox({
        templateID: this.client.config.templateId,
        metadata: identity.labels,
        timeoutSeconds: config.providerSessionTimeoutSeconds,
        // The build sandbox must stay alive so takeSnapshot can bake its
        // filesystem; never auto-pause/resume it.
        autoPause: false,
        secure: true,
        autoResume: false,
      });
      sandboxId = sandbox.sandboxID;

      // Register the build sandbox before delivering env, so the workflow has
      // bound the provider session before the supervisor can run setup and fire
      // the build-complete callback (which is rejected until the session is bound).
      await config.onProviderSessionCreated(sandbox.sandboxID);

      // E2B has no per-create entrypoint launch, so the whole build env — including
      // the callback contract — is delivered in the single session-env file
      // oi-launch reads, rather than baked at create time.
      const envVars = buildImageBuildEnvVars({
        sandboxId: identity.sandboxId,
        repositories: config.repositories,
        scmIdentity: scmCloneIdentity(this.providerConfig.scmProvider),
        cloneToken: config.cloneToken,
        baseEnvVars: config.userEnvVars,
      });
      Object.assign(
        envVars,
        {
          SANDBOX_VERSION: E2B_SANDBOX_VERSION,
          // See the createSandbox path: /run is a root-owned tmpfs in E2B, so the
          // git credential helper needs a user-writable cache dir.
          OI_SCM_CRED_CACHE_DIR: "/tmp/oi",
          [IMAGE_BUILD_EXECUTION_TIMEOUT_ENV_KEY]: String(config.buildExecutionTimeoutSeconds),
        },
        buildImageBuildCallbackEnv({
          buildId: config.buildId,
          callbackUrl: config.callbackUrl,
          failureCallbackUrl: config.failureCallbackUrl,
          token: config.callbackToken,
          providerSessionId: sandbox.sandboxID,
        })
      );
      await this.deliverSessionEnv(sandbox, envVars);

      log.info("e2b.image_build_triggered", {
        build_id: config.buildId,
        scope_kind: config.scopeKind,
        scope_id: config.scopeId,
        sandbox_id: sandbox.sandboxID,
        request_id: config.correlation.request_id,
        trace_id: config.correlation.trace_id,
      });
    } catch (error) {
      // deliverSessionEnv kills on write failure; this covers a create-time or
      // onProviderSessionCreated failure that leaves the sandbox running.
      if (sandboxId) {
        await this.cleanupSandbox(sandboxId, "e2b.build_cleanup_kill_failed");
      }
      if (error instanceof SandboxProviderError) throw error;
      throw this.classifyError("Failed to trigger E2B image build", error, "create");
    }
  }

  async deleteProviderImage(providerImageId: string, signal?: AbortSignal): Promise<void> {
    try {
      await this.client.deleteTemplate(providerImageId, signal);
    } catch (error) {
      if (error instanceof E2BNotFoundError) return;
      throw this.classifyError("Failed to delete E2B snapshot", error, "delete");
    }
  }

  /**
   * Assemble the per-session env (and the derived service passwords) shared by
   * the create and restore paths.
   */
  private async buildRuntimeEnv(
    config: CreateSandboxConfig,
    extraEnv: Record<string, string>
  ): Promise<{
    envVars: Record<string, string>;
    codeServerPassword?: string;
    vncPassword?: string;
  }> {
    const codeServerPassword = config.codeServerEnabled
      ? await deriveCodeServerPassword(
          config.sandboxId,
          this.providerConfig.sandboxAccessPasswordSecret
        )
      : undefined;
    const vncPassword = config.vncEnabled
      ? await deriveVncPassword(config.sandboxId, this.providerConfig.sandboxAccessPasswordSecret)
      : undefined;
    const timeoutSeconds = config.timeoutSeconds ?? this.providerConfig.sandboxTimeoutSeconds;
    const envVars = buildSandboxEnvVars(
      { ...config, timeoutSeconds },
      {
        scmIdentity: scmCloneIdentity(this.providerConfig.scmProvider),
        codeServerPassword,
        vncPassword,
      }
    );
    // E2B sandboxes run as a non-root user and /run is a root-owned tmpfs, so
    // the git credential helper can't create its default cache dir (/run/oi)
    // and fails before brokering a token. Point it at a user-writable path.
    envVars.OI_SCM_CRED_CACHE_DIR = "/tmp/oi";
    Object.assign(envVars, extraEnv);
    return { envVars, codeServerPassword, vncPassword };
  }

  /** Best-effort kill for a sandbox we are abandoning; never masks the original error. */
  private async cleanupSandbox(sandboxId: string, event: string): Promise<void> {
    try {
      await this.client.killSandbox(sandboxId);
    } catch (error) {
      if (error instanceof E2BNotFoundError) return;
      log.warn(event, {
        sandbox_id: sandboxId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Deliver the per-session env to the supervisor via envd. E2B's template start
   * command runs once at build and never sees create-time env vars, so the
   * launcher (oi-launch.py) waits for this file and starts the supervisor with it.
   * On failure the sandbox exists but will never get its env — kill it rather
   * than leak a running launcher-only sandbox until its TTL.
   */
  private async deliverSessionEnv(
    sandbox: E2BSandboxCreated,
    envVars: Record<string, string>
  ): Promise<void> {
    try {
      const envdAccessToken = sandbox.envdAccessToken;
      if (!envdAccessToken) {
        // secure:true always returns a token, so a missing one is systemic (secure
        // unsupported / API change), not intermittent — classify permanent to trip the
        // circuit breaker rather than looping create→kill. Fail closed: the env write
        // (SANDBOX_AUTH_TOKEN + secrets) never happens; the catch below kills the sandbox.
        throw new SandboxProviderError(
          "E2B create did not return an envd access token (secure access required)",
          "permanent"
        );
      }
      await this.client.writeSessionEnv(sandbox.sandboxID, envVars, {
        domain: sandbox.domain,
        envdAccessToken,
      });
    } catch (error) {
      try {
        await this.client.killSandbox(sandbox.sandboxID);
      } catch (killError) {
        log.warn("e2b.cleanup_kill_failed", {
          sandbox_id: sandbox.sandboxID,
          error: killError instanceof Error ? killError.message : String(killError),
        });
      }
      throw error;
    }
  }

  private buildMetadata(config: CreateSandboxConfig): Record<string, string> {
    const metadata: Record<string, string> = {
      openinspect_framework: "open-inspect",
      openinspect_session_id: config.sessionId,
      openinspect_expected_sandbox_id: config.sandboxId,
    };
    // Repo-less (environment/multi-repo) sessions have no single repo to label.
    if (config.repoOwner && config.repoName) {
      metadata.openinspect_repo = `${config.repoOwner}/${config.repoName}`;
    }
    return metadata;
  }

  private buildTunnelUrls(
    e2bSandboxId: string,
    codeServerEnabled: boolean | undefined,
    vncEnabled: boolean | undefined,
    sandboxSettings: SandboxSettings | undefined,
    domain?: string | null
  ) {
    let tunnelPorts = resolveTunnelPorts(sandboxSettings?.tunnelPorts);
    let codeServerUrl: string | undefined;
    let vncUrl: string | undefined;

    if (codeServerEnabled) {
      const { codeServerPort } = resolveServicePorts(sandboxSettings);
      codeServerUrl = this.client.getHostnameForPort(e2bSandboxId, codeServerPort, domain);
      tunnelPorts = tunnelPorts.filter((p) => p !== codeServerPort);
    }

    if (vncEnabled) {
      const { vncPort } = resolveServicePorts(sandboxSettings);
      vncUrl = this.client.getHostnameForPort(e2bSandboxId, vncPort, domain);
      tunnelPorts = tunnelPorts.filter((p) => p !== vncPort);
    }

    const tunnelUrls =
      tunnelPorts.length > 0
        ? Object.fromEntries(
            tunnelPorts.map((p) => [
              String(p),
              this.client.getHostnameForPort(e2bSandboxId, p, domain),
            ])
          )
        : undefined;

    return { codeServerUrl, vncUrl, tunnelUrls };
  }

  private classifyError(
    message: string,
    error: unknown,
    operation: E2BOperation
  ): SandboxProviderError {
    // Already classified (e.g. the secure-access guard) — don't double-wrap and lose its message.
    if (error instanceof SandboxProviderError) return error;
    if (error instanceof E2BApiError) {
      if (error.status === 429) {
        // Rate limiting is temporary — classify transient so it isn't counted
        // toward the sandbox circuit breaker (a permanent error would open the
        // breaker and block later spawns for minutes).
        return new SandboxProviderError(
          `${message} (rate-limited during ${operation})`,
          "transient",
          error
        );
      }
      return SandboxProviderError.fromFetchError(
        `${message}: ${error.message}`,
        error,
        error.status
      );
    }
    return SandboxProviderError.fromFetchError(message, error);
  }
}

export function createE2BProvider(
  client: E2BRestClient,
  providerConfig: E2BProviderConfig
): E2BSandboxProvider {
  return new E2BSandboxProvider(client, providerConfig);
}
