/**
 * The Daytona resources one environment image build owns: the temporary
 * source sandbox its setup hook runs in, and the snapshot captured from it.
 *
 * Daytona's container capture preserves the container's configuration —
 * environment included — so nothing the build needs may ride the source's
 * create request. The source is created dormant instead, its id is bound, and
 * only then is the build launched over the toolbox's stdin channel.
 *
 * Every read a destructive call depends on verifies ownership from the build's
 * labels first: a provider-side name can be reused, and a resource recovered
 * by name is only ever acted on when its labels name this framework and this
 * build.
 */

import { createLogger } from "../logger";
import type { SourceControlProviderName } from "../source-control";
import {
  classifyDaytonaError,
  getDaytonaSnapshot,
  LIFECYCLE_POLL_INTERVAL_MS,
} from "../sandbox/daytona-lifecycle";
import type {
  DaytonaCreateSandboxParams,
  DaytonaRestClient,
  DaytonaSandboxResponse,
  DaytonaSandboxState,
  DaytonaSnapshotResponse,
  DaytonaToolboxTarget,
} from "../sandbox/daytona-rest-client";
import {
  DaytonaApiError,
  DaytonaNotFoundError,
  daytonaBuildResourceName,
  delayUnlessCancelled,
  parseDaytonaSandboxState,
  parseDaytonaSnapshotState,
} from "../sandbox/daytona-rest-client";
import {
  DEFERRED_START_ENV_VAR,
  IMAGE_BUILD_CONTEXT_START_ARGUMENT,
  imageBuildSandboxIdentity,
  scmCloneIdentity,
  type ScmCloneIdentity,
} from "../sandbox/sandbox-env";
import { SandboxProviderError, type ImageBuildProviderTriggerConfig } from "../sandbox/provider";

const log = createLogger("image-builds:daytona");

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SECONDS_PER_MINUTE = 60;
const MS_PER_MINUTE = 60_000;

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
export const BUILD_EXPIRES_AT_LABEL = "openinspect_expires_at";

/** Daytona reads 0 as "the maximum interval", which is what a build source wants. */
const MAX_AUTO_ARCHIVE_INTERVAL = 0;

const BUILD_START_TIMEOUT_MS = 120_000;
/** Long enough for the launcher to reject an unusable context and exit. */
const BUILD_LAUNCH_SETTLE_MS = 3_000;
const BUILD_STOP_TIMEOUT_MS = 60_000;
/** Deletion is asynchronous; this is how long one cleanup attempt watches it. */
const CLEANUP_POLL_TIMEOUT_MS = 30_000;

/** States a sandbox never leaves for a state anything can be done from. */
const TERMINAL_SANDBOX_STATES = new Set<DaytonaSandboxState>([
  "destroyed",
  "destroying",
  "error",
  "build_failed",
]);

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface DaytonaImageBuildResourcesConfig {
  scmProvider: SourceControlProviderName;
}

// ---------------------------------------------------------------------------
// Resources
// ---------------------------------------------------------------------------

export class DaytonaImageBuildResources {
  constructor(
    private readonly client: DaytonaRestClient,
    private readonly providerConfig: DaytonaImageBuildResourcesConfig
  ) {}

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
      // The workflow must arbitrate trigger failure against callback acceptance
      // before deleting the source. A fast build may already be finalizing when
      // this probe fails, or when a delivered stdin request loses its response.
      // Unbound creates remain recoverable through the durable create intent.
      if (error instanceof SandboxProviderError) throw error;
      throw classifyDaytonaError("Failed to trigger Daytona image build", error);
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
    return await getDaytonaSnapshot(this.client, nameOrId, signal);
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
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
