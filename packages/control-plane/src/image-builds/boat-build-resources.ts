/**
 * The Boat resources one image build owns: the build sandbox its setup hooks
 * run in, and the saved snapshot of that sandbox's disk.
 *
 * Boat applies a sandbox's create-time env to every process it starts, and a
 * saved snapshot deploys with its source's env by default, so nothing the
 * build needs rides the create request: the sandbox is created with the boot
 * markers alone, made private, bound to the build, and only then handed its
 * env — the repository set, the clone token, the scope's secrets, the
 * callback contract — as a file under /tmp, which the launcher reads once
 * and removes and which no Boat snapshot ever saves. The sandbox's own id,
 * which the callback needs and which does not exist before create returns,
 * rides the launch command as a variable prefix.
 *
 * Creating a build needs the deployment's base snapshot; finalizing one, and
 * reclaiming what an earlier configuration left behind, needs only the API
 * credentials, so a deployment that switched providers can still finish.
 */

import { bytesToHex } from "@open-inspect/shared/auth";
import type { SandboxResources } from "@open-inspect/shared/types/integrations";
import { createLogger } from "../logger";
import type { SourceControlProviderName } from "../source-control";
import {
  assertBoatEnvWithinLimits,
  assertSafeBoatSandboxId,
  BOAT_SANDBOX_VERSION,
  BoatSandboxLifecycle,
  boatIdempotencyKey,
  boatSandboxName,
  classifyBoatError,
  dropBoatReservedEnv,
  isUsableBoatArchive,
  resolveBoatMachineType,
  resolveBoatTtlSeconds,
  type BoatLifecycleTimings,
} from "../sandbox/boat-lifecycle";
import {
  BoatNotFoundError,
  type BoatMachineType,
  type BoatSavedSnapshot,
  type BoatRestClient,
  type BoatSandbox,
} from "../sandbox/boat-rest-client";
import { SandboxProviderError, type ImageBuildProviderTriggerConfig } from "../sandbox/provider";
import {
  buildImageBuildCallbackEnv,
  buildImageBuildEnvVars,
  DEFERRED_START_ENV_VAR,
  IMAGE_BUILD_EXECUTION_TIMEOUT_ENV_KEY,
  IMAGE_BUILD_MODE_ENV_VAR,
  imageBuildSandboxIdentity,
  scmCloneIdentity,
} from "../sandbox/sandbox-env";

const log = createLogger("image-builds:boat");

/**
 * Where a build sandbox receives its env. The launcher sources the file in
 * image-build mode and removes it; `/tmp` is outside every Boat snapshot, so
 * the file is never part of the image nor of the automatic snapshot a stop
 * takes.
 */
export const BOAT_IMAGE_BUILD_ENV_FILE_PATH = "/tmp/openinspect-image-build.env";

/**
 * Prefix of the saved snapshot an image build is saved under; the rest is a
 * legible slug of the build id and a digest (see boatImageSnapshotName).
 */
const BOAT_IMAGE_SNAPSHOT_NAME_PREFIX = "oi-img-";
const BOAT_IMAGE_SNAPSHOT_SLUG_MAX_CHARS = 28;

export interface BoatImageBuildResourcesConfig {
  scmProvider: SourceControlProviderName;
  /** Labels sandboxes, keys idempotent creates and names images; distinct per deployment. */
  deploymentName: string;
  /** Machine size when the scope requests no CPU or memory. */
  defaultMachineType: BoatMachineType;
  /** Saved snapshot a build sandbox deploys from. Needed to start a build, not to finish or reclaim one. */
  baseSnapshot?: string;
}

/** A build trigger with the scope's resource request, which sizes the build machine. */
export interface BoatImageBuildTriggerConfig extends ImageBuildProviderTriggerConfig {
  resources?: SandboxResources;
}

/** What became of a build source asked to stop for its save. */
export type BoatBuildSourceStop = "stopped" | "stopping" | "missing";

export class BoatImageBuildResources {
  private readonly lifecycle: BoatSandboxLifecycle;

  constructor(
    private readonly client: BoatRestClient,
    private readonly config: BoatImageBuildResourcesConfig,
    timings: Partial<BoatLifecycleTimings> = {}
  ) {
    this.lifecycle = new BoatSandboxLifecycle(client, timings);
  }

  /**
   * Start an image build: deploy the build sandbox from the base snapshot on
   * the machine the scope asked for, make it private, bind it to the build,
   * deliver its env, and boot the launcher in image-build mode. The runtime
   * clones every repository, runs each `.openinspect/setup.sh`, reports
   * completion over the callback and idles until finalization archives the
   * sandbox and saves its disk.
   *
   * Ordering is the contract: nothing of the build reaches the sandbox before
   * it is private, and nothing in it runs before the bind, so a build that
   * reports completion is always a build whose row names the sandbox that
   * reported it. Until the bind the sandbox is this call's alone and a failed
   * step deletes it here; from the bind on it is the workflow's, which weighs
   * a failed trigger against a callback that may already have been accepted
   * before it decides on cleanup.
   */
  async triggerImageBuild(config: BoatImageBuildTriggerConfig): Promise<void> {
    const identity = imageBuildSandboxIdentity(config, Date.now());
    const envVars = this.buildEnv(config, identity.sandboxId);
    let created: BoatSandbox | undefined;
    let handedOff = false;
    try {
      ({ sandbox: created } = await this.lifecycle.createSandbox({
        type: resolveBoatMachineType(config.resources, this.config.defaultMachineType),
        ttlSeconds: resolveBoatTtlSeconds(config.providerSessionTimeoutSeconds),
        // The boot markers alone: the env itself follows once the sandbox is
        // private, and a saved snapshot inherits only this from its source.
        env: bootMarkers(),
        from: this.requireBaseSnapshot(),
        idempotencyKey: await boatIdempotencyKey(
          this.config.deploymentName,
          config.buildId,
          identity.sandboxId
        ),
        monitoring: false,
        // Named and private from the create on: Boat sets the visibility
        // before the sandbox has a machine.
        name: boatSandboxName(this.config.deploymentName, identity.sandboxName),
        visibility: "private",
      }));
      // Refused before it is bound: the bind persists the id as the build's
      // provider session, and the launch interpolates it into a command.
      assertSafeBoatSandboxId(created.id);
      await this.lifecycle.ensurePrivate(created);
      handedOff = true;
      await config.onProviderSessionCreated(created.id);
      await this.lifecycle.waitForReady(created.id);
      await this.client.writeFile(created.id, {
        path: BOAT_IMAGE_BUILD_ENV_FILE_PATH,
        content: shellEnvFile(envVars),
      });
      await this.lifecycle.launchRuntime(created.id, { providerSessionId: created.id });
      log.info("boat.image_build_triggered", {
        build_id: config.buildId,
        scope_kind: config.scopeKind,
        scope_id: config.scopeId,
        sandbox_id: created.id,
        request_id: config.correlation.request_id,
        trace_id: config.correlation.trace_id,
      });
    } catch (error) {
      if (created && !handedOff) {
        await this.lifecycle.deleteQuietly(created.id, "boat.build_cleanup_failed");
      }
      throw classifyBoatError("Failed to trigger Boat image build", error);
    }
  }

  /**
   * Bring a build's source sandbox to a stop so its disk can be saved: a live
   * one is archived, an archived one is already there. `stopping` means the
   * archive outlasted this call's budget and is still Boat's to finish;
   * `missing` means Boat no longer has the sandbox. A sandbox Boat finished
   * without a usable disk can never be saved, and says so.
   */
  async stopBuildSandboxForSave(
    providerSessionId: string,
    signal?: AbortSignal
  ): Promise<BoatBuildSourceStop> {
    let sandbox: BoatSandbox;
    try {
      sandbox = await this.client.getSandbox(providerSessionId, signal);
    } catch (error) {
      if (error instanceof BoatNotFoundError) return "missing";
      throw error;
    }
    // Already there only if the archive is one a save can use; an archived
    // sandbox whose stop failed its capture goes through `archive`, which
    // names what is wrong with it.
    if (isUsableBoatArchive(sandbox)) return "stopped";
    const outcome = await this.lifecycle.archive(providerSessionId, { signal });
    switch (outcome.type) {
      case "archived":
        return "stopped";
      case "timed_out":
        return "stopping";
      case "missing":
        return "missing";
      case "unusable":
        throw new SandboxProviderError(
          `Boat build sandbox could not be stopped for its image: ${outcome.detail}`,
          "permanent"
        );
    }
  }

  /** The name a build's image is saved under in this deployment. */
  imageSnapshotName(buildId: string): Promise<string> {
    return boatImageSnapshotName(this.config.deploymentName, buildId);
  }

  /**
   * Save the source's disk under its image name. Boat answers at once with
   * the snapshot in `saving`; a source that is still running is captured
   * first, an archived one is saved from its last automatic snapshot.
   */
  saveImageSnapshot(
    providerSessionId: string,
    name: string,
    signal?: AbortSignal
  ): Promise<BoatSavedSnapshot> {
    return this.client.saveSavedSnapshot(providerSessionId, name, signal);
  }

  /** The saved snapshot under `name`, or null when Boat has none. */
  async getImageSnapshot(name: string, signal?: AbortSignal): Promise<BoatSavedSnapshot | null> {
    try {
      return await this.client.getSavedSnapshot(name, signal);
    } catch (error) {
      if (error instanceof BoatNotFoundError) return null;
      throw error;
    }
  }

  /**
   * Delete a prebuilt image's saved snapshot; one already gone counts as
   * deleted. Refuses the deployment's base snapshot outright: an image
   * reference that somehow named it would otherwise take the deployment's
   * ability to start any sandbox with it.
   */
  async deleteProviderImage(providerImageId: string, signal?: AbortSignal): Promise<void> {
    if (this.config.baseSnapshot && providerImageId === this.config.baseSnapshot) {
      throw new SandboxProviderError(
        "Refusing to delete the configured Boat base snapshot",
        "permanent"
      );
    }
    try {
      await this.client.deleteSavedSnapshot(providerImageId, signal);
    } catch (error) {
      if (error instanceof BoatNotFoundError) return;
      throw error;
    }
  }

  /**
   * Delete a build's source sandbox for good: once its image is saved, or
   * once the build has failed. One already gone counts as deleted.
   */
  async deleteBuildSandbox(providerSessionId: string, signal?: AbortSignal): Promise<void> {
    try {
      await this.client.deleteSandbox(providerSessionId, signal);
    } catch (error) {
      if (error instanceof BoatNotFoundError) return;
      throw error;
    }
  }

  private requireBaseSnapshot(): string {
    if (!this.config.baseSnapshot) {
      throw new SandboxProviderError(
        "BOAT_BASE_SNAPSHOT is required to start a Boat image build",
        "permanent"
      );
    }
    return this.config.baseSnapshot;
  }

  /** The env a build runs with, delivered to the sandbox once it is private. */
  private buildEnv(
    config: ImageBuildProviderTriggerConfig,
    sandboxId: string
  ): Record<string, string> {
    const envVars = buildImageBuildEnvVars({
      sandboxId,
      repositories: config.repositories,
      scmIdentity: scmCloneIdentity(this.config.scmProvider),
      cloneToken: config.cloneToken,
      baseEnvVars: config.userEnvVars,
    });
    dropBoatReservedEnv(envVars, sandboxId);
    Object.assign(envVars, {
      [IMAGE_BUILD_EXECUTION_TIMEOUT_ENV_KEY]: String(config.buildExecutionTimeoutSeconds),
      // No provider session id: the sandbox does not exist before create
      // returns, so the id rides the launch command instead.
      ...buildImageBuildCallbackEnv({
        buildId: config.buildId,
        callbackUrl: config.callbackUrl,
        failureCallbackUrl: config.failureCallbackUrl,
        token: config.callbackToken,
      }),
      // The boot markers are stated last, so a scope secret can neither hold
      // the build dormant nor reshape it.
      ...bootMarkers(),
    });
    // Boat's env rules keep every name a shell identifier, which the env file
    // relies on; the session path applies the same limits.
    assertBoatEnvWithinLimits(envVars);
    return envVars;
  }
}

/**
 * The saved snapshot a build's image is saved under. Fixed by the deployment
 * and the build id: a save repeated under it replaces the artifact rather
 * than adding one, so the name doubles as the save's idempotency key, and two
 * deployments sharing a Boat account cannot collide. The build id's own text
 * leads so Boat's dashboard shows which scope an image belongs to.
 */
export async function boatImageSnapshotName(
  deploymentName: string,
  buildId: string
): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${deploymentName}:${buildId}`)
  );
  const slug = buildId
    .toLowerCase()
    .replace(/^imgb-/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, BOAT_IMAGE_SNAPSHOT_SLUG_MAX_CHARS)
    .replace(/^-+|-+$/g, "");
  const digestHex = bytesToHex(new Uint8Array(digest)).slice(0, 16);
  return `${BOAT_IMAGE_SNAPSHOT_NAME_PREFIX}${slug ? `${slug}-` : ""}${digestHex}`;
}

/**
 * The boot controls a build sandbox is created with, every one stated: the
 * launcher reads IMAGE_BUILD_MODE from the sandbox env before the env file
 * exists, and a session deployed from the image restates each of them.
 */
function bootMarkers(): Record<string, string> {
  return {
    [IMAGE_BUILD_MODE_ENV_VAR]: "true",
    [DEFERRED_START_ENV_VAR]: "false",
    RESTORED_FROM_SNAPSHOT: "false",
    FROM_REPO_IMAGE: "false",
    SANDBOX_VERSION: BOAT_SANDBOX_VERSION,
  };
}

/**
 * The env file the launcher sources: one `export` per variable, the value in
 * single quotes so any content (newlines, `$`, backticks) stays literal. Keys
 * are shell identifiers by Boat's own env rules (assertBoatEnvWithinLimits).
 */
export function shellEnvFile(envVars: Record<string, string>): string {
  return (
    Object.entries(envVars)
      .map(([key, value]) => `export ${key}='${value.replace(/'/g, `'\\''`)}'`)
      .join("\n") + "\n"
  );
}
