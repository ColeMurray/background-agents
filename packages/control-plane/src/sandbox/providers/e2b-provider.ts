/**
 * E2B sandbox provider — calls the E2B REST API directly.
 *
 * Stop is a resumable pause (like Daytona's stop), so the shared lifecycle
 * manager's persistent-resume path drives idle-pause and resume with no
 * E2B-specific plumbing. Sandboxes are created with auto-pause (a lapsed TTL pauses
 * recoverably rather than killing) and secure envd access; provider-side auto-resume is
 * disabled so resume stays control-plane-driven (connectSandbox) and stray traffic can't
 * wake a paused box.
 *
 * One boot path, the same shape as every other provider: the per-sandbox env
 * (secrets included) rides `POST /sandboxes` `envVars` — envd applies it to
 * every process it starts — and the control plane then execs the runtime
 * entrypoint, detached, via envd (startEntrypoint). No secret may ride the
 * exec command or per-command envs instead: E2B platform-logs Process/Start
 * requests with their command line and env values. Readiness is the uniform
 * contract — the sandbox bridge phones home, and the connecting timeout fails
 * the session otherwise; there is no spawn-time liveness handshake.
 *
 * Prebuilt images (snapshots): the image-build workflow runs `.openinspect/setup.sh`
 * once in a build sandbox (triggerImageBuild), then bakes its filesystem into a
 * reusable snapshot template (takePrebuiltImageSnapshot →
 * `POST /sandboxes/{id}/snapshots`). The snapshot id doubles as a `templateID`, so a
 * prebuilt spawn is a create with that id in place of the base template. The image's
 * contract is its filesystem; nothing captured in memory is relied on, mirroring how
 * Modal repo images reboot their entrypoint on each spawn.
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
  REPO_IMAGE_CALLBACK_ENV,
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
 * Runtime version reported by E2B sandboxes (sessions and image builds), so
 * spawn-time selection can gate on the compatibility floor
 * (MIN_COMPATIBLE_RUNTIME_VERSION). E2B does not propagate the Dockerfile's
 * SANDBOX_VERSION to the runtime process, so it is injected via the sandbox env
 * instead.
 *
 * Derived from the manifest rather than pinned, exactly as VERCEL_SANDBOX_VERSION
 * is: a literal here silently drifts below the floor when the manifest bumps, and
 * every image built under it is then rejected as runtime_below_floor.
 */
export const E2B_SANDBOX_VERSION = SANDBOX_RUNTIME_VERSION;

/**
 * TTL for the brief quiet resume between the sanitizing pause and createSnapshot
 * during an image build. Only needs to outlive the snapshot call; the build
 * sandbox is killed immediately afterwards.
 */
const SNAPSHOT_CONNECT_TIMEOUT_SECONDS = 300;

/**
 * The supervisor's stdout/stderr, the single in-sandbox forensics file. E2B's
 * platform never captures process output (envd ships byte counts only), so
 * this file is what an operator tails to debug a boot.
 */
const E2B_SUPERVISOR_LOG_PATH = "/tmp/oi-supervisor.log";
/**
 * The one start command, run by the control plane on every boot — base
 * template, prebuilt image, and image build alike. Detached (nohup + `&`) so
 * the supervisor outlives the envd RPC; the shell's clean exit is asserted by
 * the client's Connect-stream check, and whether the detached python survives
 * is the connecting timeout's job, exactly as on Modal. Env arrives via
 * create-time envVars (applied by envd, inherited through nohup) — never on
 * this command line, which E2B platform-logs.
 */
const E2B_ENTRYPOINT_COMMAND = `nohup python -m sandbox_runtime.entrypoint >${E2B_SUPERVISOR_LOG_PATH} 2>&1 &`;

/**
 * Env the provider pins on every E2B sandbox (sessions and image builds),
 * applied over user env so a repo secret with one of these names cannot
 * clobber a key the boot depends on.
 */
const E2B_SANDBOX_ENV: Record<string, string> = {
  // E2B runs the runtime as non-root `user`; the Dockerfile's HOME=/root would
  // EACCES everything under ~.
  HOME: "/home/user",
  // The staged runtime and the global node modules — E2B propagates neither.
  PYTHONPATH: "/app",
  NODE_PATH: "/usr/lib/node_modules",
  // /run is a root-owned tmpfs, so the git credential helper cannot create its
  // default cache dir (/run/oi) and would fail before brokering a token.
  OI_SCM_CRED_CACHE_DIR: "/tmp/oi",
  // So the runtime reports a version (spawn-time image selection gates on it).
  SANDBOX_VERSION: E2B_SANDBOX_VERSION,
};

/**
 * The image-build path interpolates the E2B-issued sandbox id into a shell
 * command and persists it as the build's provider-session binding — reject
 * anything empty or shell-hostile before either use.
 */
function assertSafeProviderSessionId(providerSessionId: string): void {
  if (!/^[A-Za-z0-9_-]+$/.test(providerSessionId)) {
    throw new Error("unsafe E2B sandbox id for exec command");
  }
}

/**
 * Render the entrypoint command, optionally prefixed with the one value
 * allowed on a command line E2B platform-logs: the sandbox's own id — needed
 * by the image-build callback yet unknowable before create returns, and
 * public (every envd hostname carries it). Everything else must ride
 * create-time envVars; the assert keeps the interpolation shell-inert and
 * rejects an empty id (the runtime aborts on a present-but-empty value).
 */
function entrypointCommand(providerSessionId?: string): string {
  if (providerSessionId === undefined) return E2B_ENTRYPOINT_COMMAND;
  assertSafeProviderSessionId(providerSessionId);
  return `${REPO_IMAGE_CALLBACK_ENV.providerSessionId}='${providerSessionId}' ${E2B_ENTRYPOINT_COMMAND}`;
}

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
        envVars,
        metadata: this.buildMetadata(config),
        timeoutSeconds,
        autoPause: this.providerConfig.autoPause,
        // Require secure envd access: the entrypoint exec must not be possible
        // anonymously over the public sandbox host, so envd must reject calls
        // lacking the returned access token.
        secure: true,
        // Deliberately NOT auto-resume: resume is control-plane-driven (resumeSandbox →
        // connectSandbox). Provider-side auto-resume would wake a paused sandbox from
        // stray inbound traffic, outside the DO state machine.
        autoResume: false,
      });

      try {
        await this.startEntrypoint(sandbox);
      } catch (error) {
        // The sandbox exists but can never boot — kill it rather than leak it
        // until its TTL, then let the create fail loudly.
        await this.cleanupSandbox(sandbox.sandboxID, "e2b.cleanup_kill_failed");
        throw error;
      }

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
   * Bake an image-build sandbox into a reusable snapshot template whose only
   * contract is its filesystem.
   *
   * An E2B snapshot (`POST /sandboxes/{id}/snapshots`) always captures live
   * memory: it requires a running sandbox (404 on a paused one) and has no
   * filesystem-only variant. Snapshotting the build sandbox directly would bake
   * the build supervisor and its secret env (clone token, build callback
   * credentials) into every image and resume them on every spawn. So the bake
   * first `pause(memory:false)` — dropping all process memory AND the build's
   * create-time envVars, keeping the disk — then `connect`s and snapshots the
   * resumed, quiet sandbox: kernel and envd up, no userland processes, no
   * build credentials anywhere.
   *
   * The pause cannot sanitize the DISK, though: the build supervisor's log
   * (E2B_SUPERVISOR_LOG_PATH) survives it, and user-authored setup hooks
   * inherit the build's secret env and can print it there — so the bake
   * deletes the log from the resumed sandbox before snapshotting, using the
   * fresh envd token the connect response returns.
   *
   * Nothing captured in memory is relied on. Sandboxes spawned from the image
   * resume quiet, and createSandbox starts the entrypoint itself
   * (startEntrypoint) — the same lifecycle as Modal repo images, whose
   * entrypoint reboots on every spawn from a filesystem snapshot.
   *
   * This is the only snapshot path E2B exposes; there is no generic
   * `takeSnapshot` (see `capabilities.supportsSnapshots`).
   */
  async takePrebuiltImageSnapshot(config: SnapshotConfig): Promise<SnapshotResult> {
    try {
      await this.client.pauseSandbox(config.providerObjectId, { memory: false }, config.signal);
      const resumed = await this.client.connectSandbox(
        config.providerObjectId,
        SNAPSHOT_CONNECT_TIMEOUT_SECONDS,
        config.signal
      );
      const envdAccessToken = resumed.envdAccessToken;
      if (!envdAccessToken) {
        // Fail closed, like the create-time guard: baking without the log
        // scrub would silently ship whatever build output — possibly printed
        // secrets — the log holds, into a durable image.
        throw new SandboxProviderError(
          "E2B connect did not return an envd access token (secure access required)",
          "permanent"
        );
      }
      await this.client.startProcess(config.providerObjectId, `rm -f ${E2B_SUPERVISOR_LOG_PATH}`, {
        domain: resumed.domain,
        envdAccessToken,
        signal: config.signal,
      });
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

  /**
   * Boot the runtime: exec the supervisor entrypoint via envd, detached, in a
   * freshly created sandbox. The template start command runs once at template
   * build and never re-runs on snapshot resume, so without this nothing inside
   * ever starts and the session dies on the connecting timeout with no runtime
   * logs to explain it.
   *
   * The missing-token guard lives here, after create, so a tokenless create is
   * caught while the caller still holds the sandbox for cleanup: it is
   * systemic (secure unsupported / API change), not intermittent, and
   * classified permanent so it trips the circuit breaker instead of looping
   * create→kill.
   *
   * Callers own cleanup: any failure here leaves a sandbox that can never
   * boot, and the caller must kill it rather than leak it until its TTL.
   */
  private async startEntrypoint(
    sandbox: E2BSandboxCreated,
    providerSessionId?: string
  ): Promise<void> {
    const envdAccessToken = sandbox.envdAccessToken;
    if (!envdAccessToken) {
      throw new SandboxProviderError(
        "E2B create did not return an envd access token (secure access required)",
        "permanent"
      );
    }
    await this.client.startProcess(sandbox.sandboxID, entrypointCommand(providerSessionId), {
      domain: sandbox.domain,
      envdAccessToken,
    });
    log.info("e2b.entrypoint_started", { sandbox_id: sandbox.sandboxID });
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
   * repo-image callback, then idles awaiting takePrebuiltImageSnapshot.
   * The build sandbox does not auto-pause: its filesystem is snapshotted in place.
   */
  async triggerImageBuild(config: ImageBuildProviderTriggerConfig): Promise<void> {
    const identity = imageBuildSandboxIdentity(config, Date.now());

    let sandboxId: string | undefined;
    try {
      const envVars = buildImageBuildEnvVars({
        sandboxId: identity.sandboxId,
        repositories: config.repositories,
        scmIdentity: scmCloneIdentity(this.providerConfig.scmProvider),
        cloneToken: config.cloneToken,
        baseEnvVars: config.userEnvVars,
      });
      Object.assign(
        envVars,
        { [IMAGE_BUILD_EXECUTION_TIMEOUT_ENV_KEY]: String(config.buildExecutionTimeoutSeconds) },
        // No providerSessionId: the sandbox does not exist yet at create time;
        // it is delivered on the entrypoint exec below instead.
        buildImageBuildCallbackEnv({
          buildId: config.buildId,
          callbackUrl: config.callbackUrl,
          failureCallbackUrl: config.failureCallbackUrl,
          token: config.callbackToken,
        }),
        E2B_SANDBOX_ENV
      );

      const sandbox = await this.client.createSandbox({
        templateID: this.client.config.templateId,
        envVars,
        metadata: identity.labels,
        timeoutSeconds: config.providerSessionTimeoutSeconds,
        // The build sandbox must stay alive so takePrebuiltImageSnapshot can
        // bake its filesystem; never auto-pause/resume it.
        autoPause: false,
        secure: true,
        autoResume: false,
      });
      sandboxId = sandbox.sandboxID;
      // Reject a hostile/empty id BEFORE binding it: the bind persists the id
      // as the build's provider session, and a value the exec step would
      // refuse must never be recorded as a live binding.
      assertSafeProviderSessionId(sandbox.sandboxID);

      // Register the build sandbox before starting the entrypoint, so the
      // workflow has bound the provider session before the supervisor can run
      // setup and fire the build-complete callback (which is rejected until
      // the session is bound).
      await config.onProviderSessionCreated(sandbox.sandboxID);

      // The runtime's callback reporter requires the provider session id,
      // which cannot ride the create-time envVars (the id does not exist until
      // create returns) — so it rides the exec command (see entrypointCommand).
      await this.startEntrypoint(sandbox, sandbox.sandboxID);

      log.info("e2b.image_build_triggered", {
        build_id: config.buildId,
        scope_kind: config.scopeKind,
        scope_id: config.scopeId,
        sandbox_id: sandbox.sandboxID,
        request_id: config.correlation.request_id,
        trace_id: config.correlation.trace_id,
      });
    } catch (error) {
      // Any failure after create — bind or entrypoint exec — leaves a running
      // sandbox that can never boot; kill it rather than leak it until its TTL.
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

  /** Assemble the session env (and the derived service passwords) for a create. */
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
    Object.assign(envVars, extraEnv, E2B_SANDBOX_ENV);
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
