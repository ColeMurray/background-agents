/**
 * Boat sandbox provider — calls the Boat REST API directly.
 *
 * A Boat sandbox is a full Ubuntu VM deployed from a named snapshot the
 * `boat-infra` build saved (the sandbox image with the runtime baked in). The
 * per-sandbox env (secrets included) rides `POST /sandboxes` `env`, which Boat
 * applies to every process the sandbox starts; the control plane then starts
 * the baked launcher, detached, which execs the runtime entrypoint. Readiness
 * is the uniform contract: the sandbox bridge phones home, and the connecting
 * timeout fails the session otherwise.
 *
 * Stop is a resumable archive (Boat snapshots the disk and releases the
 * machine), so the shared lifecycle manager's persistent-resume path drives
 * idle-stop and resume, as it does for Daytona and E2B. A resume lands on a
 * machine whose disk is restored from the snapshot: the launcher finds the
 * marker the runtime wrote when an earlier boot completed and starts the
 * runtime in `RESTORED_FROM_SNAPSHOT` mode, so the checkout is kept and
 * `setup.sh` does not run again. There is no session snapshot/restore pair
 * here: `evaluateSpawnDecision` consults `supportsPersistentResume` before
 * any snapshot id, so a stopped sandbox always resumes in place.
 *
 * Prebuilt images are named snapshots too. The image-build workflow runs
 * `.openinspect/setup.sh` once in a build sandbox deployed from the base
 * snapshot (triggerImageBuild); finalization archives that sandbox and saves
 * its disk under the build's image name (stopImageBuildSource,
 * saveImageSnapshot). A prebuilt spawn is a create with that name in place of
 * the base snapshot and `FROM_REPO_IMAGE` set, so the runtime syncs the
 * checkout and skips setup.sh. The image's contract is its filesystem: a
 * session deployed from it gets its own env and boots the launcher like any
 * other.
 *
 * A sandbox an organization pays for starts `shared` unless the organization's
 * default says otherwise, and every member of a shared sandbox can run
 * commands in it. The session env holds the sandbox auth token and user
 * secrets, so a sandbox that reports itself shared is made private before
 * anything else happens to it, and the create fails closed if that cannot be
 * done.
 */

import {
  supportsConfigurableSandboxTimeout,
  type SandboxSettings,
} from "@open-inspect/shared/types/integrations";
import { bytesToHex } from "@open-inspect/shared/auth";
import { createLogger } from "../../logger";
import type { SourceControlProviderName } from "../../source-control";
import {
  BoatApiError,
  BoatCancelledError,
  BoatConflictError,
  BoatNotFoundError,
  delayUnlessCancelled,
  type BoatMachineType,
  type BoatNamedSnapshot,
  type BoatRestClient,
  type BoatSandbox,
} from "../boat-rest-client";
import {
  buildImageBuildCallbackEnv,
  buildImageBuildEnvVars,
  buildSandboxEnvVars,
  DEFERRED_START_ENV_VAR,
  deriveCodeServerPassword,
  deriveVncPassword,
  IMAGE_BUILD_EXECUTION_TIMEOUT_ENV_KEY,
  IMAGE_BUILD_MODE_ENV_VAR,
  imageBuildSandboxIdentity,
  REPO_IMAGE_CALLBACK_ENV,
  scmCloneIdentity,
} from "../sandbox-env";
import { SANDBOX_RUNTIME_VERSION } from "../runtime-manifest";
import { resolveSandboxPortPlan, type SandboxPortPlan } from "./port-resolution";
import {
  createVncAccess,
  DEFAULT_SANDBOX_TIMEOUT_SECONDS,
  PrebuiltImageUnavailableError,
  SandboxProviderError,
  signalUntilDeadline,
  type CreateSandboxConfig,
  type CreateSandboxResult,
  type ImageBuildProviderTriggerConfig,
  type ResumeConfig,
  type ResumeResult,
  type SandboxLifetime,
  type SandboxProvider,
  type SandboxProviderCapabilities,
  type StopConfig,
  type StopResult,
  type VncAccess,
} from "../provider";

const log = createLogger("boat-provider");

/**
 * Runtime version reported by Boat sandboxes, so spawn-time selection can gate
 * on the compatibility floor. Derived from the manifest rather than pinned,
 * exactly as E2B_SANDBOX_VERSION is.
 */
export const BOAT_SANDBOX_VERSION = SANDBOX_RUNTIME_VERSION;

/**
 * Ports Boat's own services hold on every machine (SSH, the desktop stream,
 * the agent server and the streaming range). A session service or tunnel on
 * one of them would never be reachable.
 */
export const BOAT_RESERVED_PORTS: ReadonlySet<number> = new Set([
  22,
  6080,
  8090,
  8911,
  ...Array.from({ length: 48010 - 47984 + 1 }, (_, index) => 47984 + index),
]);

/** noVNC's shared default (6080) is a Boat port, so Boat sandboxes default to the next one. */
export const BOAT_DEFAULT_VNC_PORT = 6081;

/** Env names Boat refuses in a per-sandbox env (`invalid_env`); they are Boat's own. */
export const BOAT_RESERVED_ENV_KEYS: readonly string[] = [
  "ASCII_TOKEN",
  "ASCII_API_URL",
  "AGENT_ID",
  "PRODUCT_MODE",
  "ENVIRONMENT_ID",
  "BOAT_ID",
  "SERVICE_PREVIEW_TOKEN",
  "BOAT_CLI_TOKEN",
];

/** Per-sandbox env limits Boat enforces on create. */
const BOAT_ENV_MAX_VARIABLES = 100;
const BOAT_ENV_MAX_BYTES = 64 * 1024;
const BOAT_ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

/** Boat's auto-stop bounds: one second to thirty days. */
const BOAT_MIN_TTL_SECONDS = 1;
const BOAT_MAX_TTL_SECONDS = 30 * 24 * 60 * 60;

/** Longest a sandbox display name may be. */
const BOAT_MAX_NAME_CHARS = 120;

/**
 * The launcher the image build bakes into the snapshot. It recreates the
 * boot-time filesystem links, holds a lock so a second start exits with
 * LAUNCHER_ALREADY_RUNNING_EXIT_CODE, decides the boot mode from the marker
 * the runtime writes once a boot has completed, and execs the runtime
 * entrypoint with its output in the launcher log. It takes no arguments; the
 * one value that ever rides its command line is an image build's own sandbox
 * id, as a variable prefix (see launchRuntime).
 */
export const BOAT_LAUNCHER_PATH = "/home/user/openinspect/launcher.sh";
const LAUNCHER_ALREADY_RUNNING_EXIT_CODE = 75;

/**
 * Prefix of the named snapshot an image build is saved under; the rest is a
 * legible slug of the build id and a digest (see boatImageSnapshotName).
 */
const BOAT_IMAGE_SNAPSHOT_NAME_PREFIX = "oi-img-";
const BOAT_IMAGE_SNAPSHOT_SLUG_MAX_CHARS = 28;

/**
 * A Boat sandbox id is interpolated into one command line (a build's launch)
 * and persisted as a build's provider session; an id outside this alphabet
 * is refused before either use.
 */
const BOAT_SANDBOX_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

/**
 * Where the tunnel env file is written. Boat's file API only writes under
 * `/home/user`; the runtime reads `/workspace/.tunnels.env`, and the image
 * links `/workspace` to `/home/user/workspace`.
 */
export const BOAT_TUNNEL_ENV_FILE_PATH = "/home/user/workspace/.tunnels.env";
// Mirrors TUNNEL_ENV_SANDBOX_ID_KEY in sandbox_runtime/constants.py: tags the
// tunnel env file with the sandbox it was written for, so the supervisor's
// stale-file cleanup keeps a fresh write instead of deleting it.
const TUNNEL_ENV_SANDBOX_ID_KEY = "TUNNEL_SANDBOX_ID";
const EXPECTED_TUNNEL_PORTS_ENV_VAR = "EXPECTED_TUNNEL_PORTS";

/** Idempotent create attempts after a lost response. */
const CREATE_ATTEMPTS = 3;

/** How long the provider waits, and how often it looks, at each step of a sandbox's life. */
export interface BoatProviderTimings {
  /** How often a flow waiting on a Boat sandbox re-reads its state. */
  pollIntervalMs: number;
  /** Budget for a created or resumed sandbox to report `ready`. */
  readyTimeoutMs: number;
  /** Budget for an archive when the caller set no deadline of its own. */
  stopTimeoutMs: number;
  /**
   * How long the launcher is watched after a start for an early exit. The
   * launcher execs into the long-lived runtime, so a process that is still
   * running after this window has booted far enough for the bridge to take
   * over readiness reporting.
   */
  launchSettleMs: number;
  launchPollIntervalMs: number;
  /** Pause before the first repeat of a create whose response was lost; later ones back off. */
  createRetryDelayMs: number;
}

export const DEFAULT_BOAT_PROVIDER_TIMINGS: BoatProviderTimings = {
  pollIntervalMs: 2_000,
  readyTimeoutMs: 150_000,
  stopTimeoutMs: 120_000,
  launchSettleMs: 5_000,
  launchPollIntervalMs: 1_000,
  createRetryDelayMs: 2_000,
};

const BOAT_LIVE_STATES: ReadonlySet<string> = new Set(["ready", "idle", "running"]);
const BOAT_STARTING_STATES: ReadonlySet<string> = new Set([
  "init",
  "provisioning",
  "provisioned",
  "cloning",
]);

/**
 * Boat's machine sizes, smallest first. A resource request selects the
 * smallest size that satisfies both the CPU and the memory it names.
 */
const BOAT_MACHINE_TYPE_RESOURCES: ReadonlyArray<{
  type: BoatMachineType;
  cpuCores: number;
  memoryMib: number;
}> = [
  { type: "small", cpuCores: 2, memoryMib: 4096 },
  { type: "default", cpuCores: 4, memoryMib: 8192 },
  { type: "large", cpuCores: 8, memoryMib: 16384 },
  { type: "xlarge", cpuCores: 16, memoryMib: 32768 },
];

export interface BoatProviderConfig {
  scmProvider: SourceControlProviderName;
  /** Secret used for domain-separated sandbox access password derivation. */
  sandboxAccessPasswordSecret: string;
  /** Named snapshot every fresh sandbox deploys from (built by boat-infra). */
  baseSnapshot: string;
  /** Machine size when the session requests no CPU or memory. */
  defaultMachineType: BoatMachineType;
  /** Labels sandboxes and keys idempotent creates; distinct per deployment. */
  deploymentName: string;
}

interface BoatAccess {
  codeServerUrl?: string;
  codeServerPassword?: string;
  ttydUrl?: string;
  vncAccess?: VncAccess;
  tunnelUrls?: Record<string, string>;
}

/** Machine size for a session's resource request: the smallest one that fits. */
export function resolveBoatMachineType(
  settings: Pick<SandboxSettings, "cpuCores" | "memoryMib"> | undefined,
  fallback: BoatMachineType
): BoatMachineType {
  const cpuCores = settings?.cpuCores ?? null;
  const memoryMib = settings?.memoryMib ?? null;
  if (cpuCores === null && memoryMib === null) return fallback;
  for (const size of BOAT_MACHINE_TYPE_RESOURCES) {
    if (
      (cpuCores === null || size.cpuCores >= cpuCores) &&
      (memoryMib === null || size.memoryMib >= memoryMib)
    ) {
      return size.type;
    }
  }
  throw new SandboxProviderError(
    `Requested sandbox resources (cpuCores=${cpuCores ?? "default"}, memoryMib=${
      memoryMib ?? "default"
    }) exceed the largest Boat machine type`,
    "permanent"
  );
}

/** Boat's auto-stop window for a requested lifetime. */
export function resolveBoatTtlSeconds(timeoutSeconds: number | undefined): number {
  const requested = Math.round(timeoutSeconds ?? DEFAULT_SANDBOX_TIMEOUT_SECONDS);
  return Math.min(BOAT_MAX_TTL_SECONDS, Math.max(BOAT_MIN_TTL_SECONDS, requested));
}

/**
 * Reject an env Boat would refuse, by the rules it publishes: key format,
 * variable count and total size. Names and counts travel in the error; values
 * never do.
 */
export function assertBoatEnvWithinLimits(envVars: Record<string, string>): void {
  const keys = Object.keys(envVars);
  const invalid = keys.filter((key) => !BOAT_ENV_KEY_PATTERN.test(key));
  if (invalid.length > 0) {
    throw new SandboxProviderError(
      `Sandbox env has ${invalid.length} name(s) Boat rejects (${invalid.slice(0, 5).join(", ")})`,
      "permanent"
    );
  }
  if (keys.length > BOAT_ENV_MAX_VARIABLES) {
    throw new SandboxProviderError(
      `Sandbox env has ${keys.length} variables; Boat allows ${BOAT_ENV_MAX_VARIABLES}`,
      "permanent"
    );
  }
  const encoder = new TextEncoder();
  let bytes = 0;
  for (const key of keys) {
    bytes += encoder.encode(key).length + encoder.encode(envVars[key]).length + 2;
  }
  if (bytes > BOAT_ENV_MAX_BYTES) {
    throw new SandboxProviderError(
      `Sandbox env is ${bytes} bytes; Boat allows ${BOAT_ENV_MAX_BYTES}`,
      "permanent"
    );
  }
}

/**
 * Deterministic create key: a retry of the same launch reuses the same
 * sandbox. The session is part of the identity because a logical sandbox id
 * is not unique on its own (a repository-backed id is the repository plus a
 * timestamp), and Boat answers a reused key carrying a different body with
 * `idempotency_key_reused`.
 */
export async function boatIdempotencyKey(
  deploymentName: string,
  sessionId: string,
  sandboxId: string
): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${deploymentName}:${sessionId}:${sandboxId}`)
  );
  return `openinspect-${bytesToHex(new Uint8Array(digest))}`;
}

function boatSandboxName(deploymentName: string, sandboxId: string): string {
  return `openinspect-${deploymentName}-${sandboxId}`.slice(0, BOAT_MAX_NAME_CHARS);
}

/**
 * The named snapshot a build's image is saved under. Fixed by the deployment
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

function assertSafeBoatSandboxId(boatSandboxId: string): void {
  if (!BOAT_SANDBOX_ID_PATTERN.test(boatSandboxId)) {
    throw new SandboxProviderError(
      "Boat returned a sandbox id outside the expected alphabet",
      "permanent"
    );
  }
}

function lifetimeFromSandbox(sandbox: BoatSandbox): SandboxLifetime {
  const observedAtMs = Date.now();
  if (sandbox.archiveAfter === null) return { kind: "none", observedAtMs };
  const expiresAtMs = sandbox.archiveAfter ? Date.parse(sandbox.archiveAfter) : Number.NaN;
  return Number.isFinite(expiresAtMs)
    ? { kind: "finite", expiresAtMs, observedAtMs, source: "provider" }
    : { kind: "unknown", observedAtMs, reason: "Boat sandbox omitted a valid archiveAfter" };
}

/** Whether a failed create may be repeated under the same idempotency key. */
function isRetryableCreateFailure(error: unknown): boolean {
  if (error instanceof BoatConflictError) return error.code === "idempotency_in_progress";
  if (error instanceof BoatApiError) return error.status >= 500;
  if (error instanceof BoatCancelledError) return false;
  return SandboxProviderError.isTransientNetworkError(error);
}

export class BoatSandboxProvider implements SandboxProvider {
  readonly name = "boat";

  readonly capabilities: SandboxProviderCapabilities = {
    supportsSandboxTimeout: supportsConfigurableSandboxTimeout(this.name),
    supportsSnapshots: false,
    supportsRestore: false,
    // Stop archives the disk and resume restores it onto a new machine; the
    // manager treats the archived sandbox as provider-managed state.
    supportsPersistentResume: true,
    supportsExplicitStop: true,
  };

  private readonly timings: BoatProviderTimings;

  constructor(
    private readonly client: BoatRestClient,
    private readonly providerConfig: BoatProviderConfig,
    timings: Partial<BoatProviderTimings> = {}
  ) {
    this.timings = { ...DEFAULT_BOAT_PROVIDER_TIMINGS, ...timings };
  }

  async createSandbox(config: CreateSandboxConfig): Promise<CreateSandboxResult> {
    let boatSandboxId: string | undefined;
    try {
      const portPlan = this.resolvePortPlan(config);
      const ttlSeconds = resolveBoatTtlSeconds(config.timeoutSeconds);
      const machineType = resolveBoatMachineType(
        config.sandboxSettings,
        this.providerConfig.defaultMachineType
      );
      const { envVars, codeServerPassword, vncPassword } = await this.buildRuntimeEnv(
        config,
        portPlan,
        ttlSeconds
      );

      let created: BoatSandbox;
      try {
        created = await this.createWithIdempotency({
          type: machineType,
          ttlSeconds,
          env: envVars,
          // A prebuilt image is a named snapshot too: the session deploys
          // from it exactly as from the base snapshot, with its own env.
          from: config.prebuiltImageId || this.providerConfig.baseSnapshot,
          idempotencyKey: await boatIdempotencyKey(
            this.providerConfig.deploymentName,
            config.sessionId,
            config.sandboxId
          ),
          // Session output stays inside the sandbox: Boat keeps no command or
          // process output for it.
          monitoring: false,
        });
      } catch (error) {
        // Boat answers a `from` that names no snapshot with 404
        // (`snapshot_not_found`): the image is gone, so the manager retires
        // it and retries from the base snapshot.
        if (config.prebuiltImageId && error instanceof BoatNotFoundError) {
          throw new PrebuiltImageUnavailableError(
            "Boat prebuilt image snapshot is unavailable",
            error
          );
        }
        throw error;
      }
      boatSandboxId = created.id;
      await this.ensurePrivate(created);

      const ready = await this.waitForReady(boatSandboxId);
      await this.nameSandbox(boatSandboxId, config.sandboxId);
      const access = await this.exposeAccess(boatSandboxId, config.sandboxId, portPlan, {
        codeServerPassword,
        vncPassword,
      });
      await this.launchRuntime(boatSandboxId);

      return {
        sandboxId: config.sandboxId,
        providerObjectId: boatSandboxId,
        createdAt: Date.now(),
        lifetime: lifetimeFromSandbox(ready),
        ...access,
      };
    } catch (error) {
      // A sandbox that exists but could not be brought up would otherwise run
      // until its TTL; delete it, then let the create fail loudly.
      if (boatSandboxId) {
        await this.cleanupSandbox(boatSandboxId, "boat.create_cleanup_failed");
      }
      throw this.classifyError("Failed to create Boat sandbox", error);
    }
  }

  async resumeSandbox(config: ResumeConfig): Promise<ResumeResult> {
    try {
      const portPlan = this.resolvePortPlan(config);
      const ttlSeconds = resolveBoatTtlSeconds(config.timeoutSeconds);
      const spawnFresh = (error: string): ResumeResult => ({
        success: false,
        error,
        shouldSpawnFresh: true,
      });

      let sandbox: BoatSandbox;
      try {
        sandbox = await this.client.getSandbox(config.providerObjectId);
      } catch (error) {
        if (error instanceof BoatNotFoundError) {
          return spawnFresh("Sandbox no longer exists in Boat");
        }
        throw error;
      }

      if (sandbox.state === "cancelled") {
        return spawnFresh("Boat cancelled the sandbox; it has no machine or snapshot");
      }
      if (sandbox.dataExpiredAt) {
        return spawnFresh("Boat deleted the stopped sandbox's snapshot data (14-day retention)");
      }

      // Boat can remove the sandbox at any point from here on (a resume that
      // finds no machine ends in `cancelled`, which answers 404 once); every
      // such disappearance takes the fresh-spawn path, as the first 404 does.
      try {
        await this.ensurePrivate(sandbox);
        if (BOAT_LIVE_STATES.has(sandbox.state)) {
          // Already on a machine (a stale heartbeat, or a stop that never
          // happened): give it a fresh deadline and make sure the runtime runs.
          await this.client.updateSandbox(config.providerObjectId, { ttlSeconds });
        } else if (!BOAT_STARTING_STATES.has(sandbox.state)) {
          // archived, archiving or error: ask for a machine. A resume during
          // archiving supersedes the stop and takes the same machine back.
          try {
            await this.client.resumeSandbox(config.providerObjectId, { ttlSeconds });
          } catch (error) {
            if (error instanceof BoatConflictError && error.code === "snapshot_data_expired") {
              return spawnFresh(
                "Boat deleted the stopped sandbox's snapshot data (14-day retention)"
              );
            }
            throw error;
          }
        }

        const ready = await this.waitForReady(config.providerObjectId);
        const codeServerPassword = config.codeServerEnabled
          ? await deriveCodeServerPassword(
              config.sandboxId,
              this.providerConfig.sandboxAccessPasswordSecret
            )
          : undefined;
        const vncPassword = config.vncEnabled
          ? await deriveVncPassword(
              config.sandboxId,
              this.providerConfig.sandboxAccessPasswordSecret
            )
          : undefined;
        const access = await this.exposeAccess(
          config.providerObjectId,
          config.sandboxId,
          portPlan,
          { codeServerPassword, vncPassword }
        );
        // A resumed machine runs nothing: the launcher starts the runtime
        // again and, finding the completed-boot marker, boots it in restored
        // mode.
        await this.launchRuntime(config.providerObjectId);

        return {
          success: true,
          providerObjectId: config.providerObjectId,
          lifetime: lifetimeFromSandbox(ready),
          ...access,
        };
      } catch (error) {
        if (error instanceof BoatNotFoundError) {
          return spawnFresh("Sandbox no longer exists in Boat");
        }
        throw error;
      }
    } catch (error) {
      throw this.classifyError("Failed to resume Boat sandbox", error);
    }
  }

  /**
   * Idle and heartbeat stops ARCHIVE (the manager routes them here via
   * supportsPersistentResume, and resumeSandbox brings the sandbox back on a
   * new machine). An archive is confirmed only once Boat reports the sandbox
   * `archived` with a snapshot available and its stop operation completed.
   * Terminal stops DELETE: nothing will resume the sandbox, so its snapshot
   * must not linger for Boat's retention period.
   */
  async stopSandbox(config: StopConfig): Promise<StopResult> {
    const deadlineAtMs = config.deadlineAtMs ?? Date.now() + this.timings.stopTimeoutMs;
    const signal = signalUntilDeadline(deadlineAtMs, config.signal);
    const destroy = config.intent === "destroy";
    try {
      if (destroy) {
        try {
          await this.client.deleteSandbox(config.providerObjectId, signal);
        } catch (error) {
          if (error instanceof BoatNotFoundError) return { success: true };
          throw error;
        }
        return { success: true };
      }

      try {
        await this.client.stopSandbox(config.providerObjectId, signal);
      } catch (error) {
        if (error instanceof BoatNotFoundError) {
          return {
            success: false,
            error: "Sandbox disappeared before graceful shutdown was verified",
          };
        }
        // Boat refuses to stop a sandbox that is already archived; the read
        // below decides whether that archive is a usable one.
        if (!(error instanceof BoatApiError && error.status === 400)) throw error;
      }

      for (;;) {
        let current: BoatSandbox;
        try {
          current = await this.client.getSandbox(config.providerObjectId, signal);
        } catch (error) {
          if (error instanceof BoatNotFoundError) {
            return {
              success: false,
              error: "Sandbox disappeared before graceful shutdown was verified",
            };
          }
          throw error;
        }
        if (current.state === "archived") {
          const stopStatus = current.stop?.status;
          if (
            current.snapshotAvailable &&
            (stopStatus === undefined || stopStatus === "completed")
          ) {
            return { success: true };
          }
          return {
            success: false,
            error: `Boat archived the sandbox without a usable snapshot (stop ${
              stopStatus ?? "unknown"
            }${current.stop?.error ? `: ${current.stop.error}` : ""})`,
          };
        }
        if (current.state === "error" || current.state === "cancelled") {
          return {
            success: false,
            error: `Sandbox state was ${current.state} after stop${
              current.error ? `: ${current.error}` : ""
            }`,
          };
        }
        if (BOAT_LIVE_STATES.has(current.state) && !current.stop) {
          return { success: false, error: `Sandbox state was ${current.state} after stop` };
        }
        await delayUnlessCancelled(this.timings.pollIntervalMs, signal);
      }
    } catch (error) {
      if (!destroy && (error instanceof BoatCancelledError || signal?.aborted)) {
        return {
          success: false,
          error: "Timed out before Boat confirmed the sandbox was archived with a snapshot",
        };
      }
      throw this.classifyError(`Failed to ${destroy ? "delete" : "stop"} Boat sandbox`, error);
    }
  }

  /**
   * Start an image build. A build sandbox deploys from the base snapshot with
   * the build env (the repository set, the clone token, the scope's secrets
   * and the callback contract), is bound to the build before anything in it
   * runs, and boots the launcher in image-build mode: the runtime clones every
   * repository, runs each `.openinspect/setup.sh`, reports completion over the
   * callback and idles until finalization archives the sandbox and saves its
   * disk (stopImageBuildSource, saveImageSnapshot).
   *
   * The build sandbox's own id is the one value that rides the launch command
   * line: the callback needs it, it does not exist before create returns, and
   * it is no secret. Everything else is in the create-time env. The launcher
   * keeps a build's lock, log and runtime state under /tmp, which a snapshot
   * never saves, so the image carries the workspace and nothing of the build
   * that produced it.
   */
  async triggerImageBuild(config: ImageBuildProviderTriggerConfig): Promise<void> {
    const identity = imageBuildSandboxIdentity(config, Date.now());
    let boatSandboxId: string | undefined;
    try {
      const envVars = this.buildImageBuildEnv(config, identity.sandboxId);
      const created = await this.createWithIdempotency({
        type: this.providerConfig.defaultMachineType,
        ttlSeconds: resolveBoatTtlSeconds(config.providerSessionTimeoutSeconds),
        env: envVars,
        from: this.providerConfig.baseSnapshot,
        idempotencyKey: await boatIdempotencyKey(
          this.providerConfig.deploymentName,
          config.buildId,
          identity.sandboxId
        ),
        monitoring: false,
      });
      boatSandboxId = created.id;
      // Refused before it is bound: the bind persists the id as the build's
      // provider session, and the launch interpolates it into a command.
      assertSafeBoatSandboxId(created.id);
      await this.ensurePrivate(created);
      // Bound before the runtime can run: the build-complete callback is
      // rejected until the build names its sandbox, and the bound id is the
      // workflow's handle for cleanup should anything below fail.
      await config.onProviderSessionCreated(created.id);
      await this.waitForReady(created.id);
      await this.nameSandbox(created.id, identity.sandboxName);
      await this.launchRuntime(created.id, { providerSessionId: created.id });
      log.info("boat.image_build_triggered", {
        build_id: config.buildId,
        scope_kind: config.scopeKind,
        scope_id: config.scopeId,
        sandbox_id: created.id,
        request_id: config.correlation.request_id,
        trace_id: config.correlation.trace_id,
      });
    } catch (error) {
      // Any failure after create leaves a sandbox that will never build;
      // delete it rather than leave it running until its TTL.
      if (boatSandboxId) {
        await this.cleanupSandbox(boatSandboxId, "boat.build_cleanup_failed");
      }
      throw this.classifyError("Failed to trigger Boat image build", error);
    }
  }

  /**
   * Bring a build's source sandbox to a stop so its disk can be saved: a live
   * one is archived (Boat snapshots the disk and releases the machine), an
   * archived one is already there. `stopping` means the archive outlasted
   * this call's budget and is still Boat's to finish; `missing` means Boat no
   * longer has the sandbox.
   */
  async stopImageBuildSource(
    boatSandboxId: string,
    buildId: string,
    signal?: AbortSignal
  ): Promise<"stopped" | "stopping" | "missing"> {
    let sandbox: BoatSandbox;
    try {
      sandbox = await this.client.getSandbox(boatSandboxId, signal);
    } catch (error) {
      if (error instanceof BoatNotFoundError) return "missing";
      throw this.classifyError("Failed to read Boat build sandbox", error);
    }
    if (sandbox.state === "archived" && sandbox.snapshotAvailable) return "stopped";
    const deadlineAtMs = Date.now() + this.timings.stopTimeoutMs;
    const result = await this.stopSandbox({
      providerObjectId: boatSandboxId,
      sessionId: buildId,
      reason: "image_build_finalization",
      intent: "preserve",
      signal,
      deadlineAtMs,
    });
    if (result.success) return "stopped";
    if (Date.now() >= deadlineAtMs || signal?.aborted) return "stopping";
    throw new SandboxProviderError(
      `Boat build sandbox could not be stopped for its image: ${result.error ?? "unknown error"}`,
      "permanent"
    );
  }

  /** The name a build's image is saved under in this deployment. */
  imageSnapshotName(buildId: string): Promise<string> {
    return boatImageSnapshotName(this.providerConfig.deploymentName, buildId);
  }

  /**
   * Save the build's disk under its image name. Boat answers at once with the
   * snapshot in `saving`; a source that is still running is captured first,
   * an archived one is saved from its last automatic snapshot.
   */
  async saveImageSnapshot(
    boatSandboxId: string,
    name: string,
    signal?: AbortSignal
  ): Promise<BoatNamedSnapshot> {
    try {
      return await this.client.saveNamedSnapshot(boatSandboxId, name, signal);
    } catch (error) {
      throw this.classifyError("Failed to save Boat image snapshot", error);
    }
  }

  /** The named snapshot under `name`, or null when Boat has none. */
  async getImageSnapshot(name: string, signal?: AbortSignal): Promise<BoatNamedSnapshot | null> {
    try {
      return await this.client.getNamedSnapshot(name, signal);
    } catch (error) {
      if (error instanceof BoatNotFoundError) return null;
      throw this.classifyError("Failed to read Boat image snapshot", error);
    }
  }

  /** Delete a prebuilt image's named snapshot; one already gone counts as deleted. */
  async deleteProviderImage(providerImageId: string, signal?: AbortSignal): Promise<void> {
    try {
      await this.client.deleteNamedSnapshot(providerImageId, signal);
    } catch (error) {
      if (error instanceof BoatNotFoundError) return;
      throw this.classifyError("Failed to delete Boat image snapshot", error);
    }
  }

  /**
   * Delete a sandbox for good: a build's source once its image is saved, or a
   * failed build's. One already gone counts as deleted.
   */
  async deleteSandbox(boatSandboxId: string, signal?: AbortSignal): Promise<void> {
    try {
      await this.client.deleteSandbox(boatSandboxId, signal);
    } catch (error) {
      if (error instanceof BoatNotFoundError) return;
      throw this.classifyError("Failed to delete Boat sandbox", error);
    }
  }

  /**
   * Effective ports for a sandbox. noVNC defaults to BOAT_DEFAULT_VNC_PORT
   * because the shared default is one of Boat's own ports, and any port Boat
   * holds is rejected outright: a service bound there is unreachable.
   */
  private resolvePortPlan(
    config: Pick<CreateSandboxConfig, "codeServerEnabled" | "vncEnabled" | "sandboxSettings">
  ): SandboxPortPlan {
    const settings: SandboxSettings = {
      ...config.sandboxSettings,
      vncPort: config.sandboxSettings?.vncPort ?? BOAT_DEFAULT_VNC_PORT,
    };
    const plan = resolveSandboxPortPlan(
      {
        codeServer: config.codeServerEnabled === true,
        terminal: settings.terminalEnabled === true,
        vnc: config.vncEnabled === true,
      },
      settings
    );
    const reserved = plan.allExposedPorts.filter((port) => BOAT_RESERVED_PORTS.has(port));
    if (reserved.length > 0) {
      throw new SandboxProviderError(
        `Sandbox port(s) ${reserved.join(", ")} are reserved by Boat (22, 6080, 8090, 8911, 47984-48010)`,
        "permanent"
      );
    }
    return plan;
  }

  /** Assemble the session env (and the derived service passwords) for a create. */
  private async buildRuntimeEnv(
    config: CreateSandboxConfig,
    portPlan: SandboxPortPlan,
    ttlSeconds: number
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
    const envVars = buildSandboxEnvVars(
      { ...config, timeoutSeconds: ttlSeconds },
      {
        scmIdentity: scmCloneIdentity(this.providerConfig.scmProvider),
        codeServerPassword,
        vncPassword,
        portPlan,
      }
    );

    this.dropBoatReservedEnv(envVars, config.sandboxId);

    // Every boot marker is stated, never merely omitted, so a repo secret of
    // the same name cannot decide how the runtime boots. The launcher raises
    // RESTORED_FROM_SNAPSHOT itself on every boot after the first, and the
    // runtime consults it before FROM_REPO_IMAGE, so a resumed prebuilt
    // session keeps its checkout rather than syncing it again.
    Object.assign(envVars, {
      [DEFERRED_START_ENV_VAR]: "false",
      [IMAGE_BUILD_MODE_ENV_VAR]: "false",
      RESTORED_FROM_SNAPSHOT: "false",
      // A prebuilt image already ran setup.sh; the runtime syncs and skips it.
      FROM_REPO_IMAGE: config.prebuiltImageId ? "true" : "false",
      // So the runtime reports a version (spawn-time selection gates on it).
      SANDBOX_VERSION: BOAT_SANDBOX_VERSION,
    });
    if (config.prebuiltImageId) {
      envVars.REPO_IMAGE_SHA = config.prebuiltImageSha ?? "";
    }
    if (portPlan.extraTunnelPorts.length > 0) {
      envVars[EXPECTED_TUNNEL_PORTS_ENV_VAR] = portPlan.extraTunnelPorts.join(",");
    }
    assertBoatEnvWithinLimits(envVars);
    return { envVars, codeServerPassword, vncPassword };
  }

  /** Assemble the env an image-build sandbox is created with. */
  private buildImageBuildEnv(
    config: ImageBuildProviderTriggerConfig,
    sandboxId: string
  ): Record<string, string> {
    const envVars = buildImageBuildEnvVars({
      sandboxId,
      repositories: config.repositories,
      scmIdentity: scmCloneIdentity(this.providerConfig.scmProvider),
      cloneToken: config.cloneToken,
      baseEnvVars: config.userEnvVars,
    });
    this.dropBoatReservedEnv(envVars, sandboxId);
    Object.assign(envVars, {
      [IMAGE_BUILD_EXECUTION_TIMEOUT_ENV_KEY]: String(config.buildExecutionTimeoutSeconds),
      // No provider session id: the sandbox does not exist before create
      // returns, so the id rides the launch command instead (launchRuntime).
      ...buildImageBuildCallbackEnv({
        buildId: config.buildId,
        callbackUrl: config.callbackUrl,
        failureCallbackUrl: config.failureCallbackUrl,
        token: config.callbackToken,
      }),
      // The other boot controls are stated too (IMAGE_BUILD_MODE already is),
      // so a scope secret can neither hold the build dormant nor reshape it.
      [DEFERRED_START_ENV_VAR]: "false",
      RESTORED_FROM_SNAPSHOT: "false",
      FROM_REPO_IMAGE: "false",
      SANDBOX_VERSION: BOAT_SANDBOX_VERSION,
    });
    assertBoatEnvWithinLimits(envVars);
    return envVars;
  }

  /**
   * Boat rejects its own names in a per-sandbox env, so a user secret under
   * one of them can never be delivered; drop it rather than fail every spawn.
   */
  private dropBoatReservedEnv(envVars: Record<string, string>, sandboxId: string): void {
    const dropped = BOAT_RESERVED_ENV_KEYS.filter((key) => key in envVars);
    for (const key of dropped) delete envVars[key];
    if (dropped.length > 0) {
      log.warn("boat.reserved_env_dropped", { sandbox_id: sandboxId, keys: dropped });
    }
  }

  /**
   * Create under an idempotency key, repeating the same request after a lost
   * response. Boat answers a repeat with the same key and body with the first
   * sandbox, so a retry never starts a second machine or spends a second start.
   */
  private async createWithIdempotency(
    params: Parameters<BoatRestClient["createSandbox"]>[0]
  ): Promise<BoatSandbox> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.client.createSandbox(params);
      } catch (error) {
        if (attempt >= CREATE_ATTEMPTS || !isRetryableCreateFailure(error)) throw error;
        log.warn("boat.create_retry", {
          attempt,
          error: error instanceof Error ? error.message : String(error),
        });
        await delayUnlessCancelled(this.timings.createRetryDelayMs * attempt);
      }
    }
  }

  /**
   * Poll until the sandbox accepts commands. A sandbox that ends in `error` or
   * `cancelled` on the way is a failed launch; one that is merely slow fails
   * transiently when the budget runs out.
   */
  private async waitForReady(boatSandboxId: string): Promise<BoatSandbox> {
    const deadlineAtMs = Date.now() + this.timings.readyTimeoutMs;
    for (;;) {
      const sandbox = await this.client.getSandbox(boatSandboxId);
      if (BOAT_LIVE_STATES.has(sandbox.state)) return sandbox;
      if (sandbox.state === "cancelled") {
        // Boat removed a sandbox it could not place; the next read answers 404.
        throw new BoatNotFoundError(
          `Boat cancelled sandbox ${boatSandboxId}${sandbox.error ? `: ${sandbox.error}` : ""}`,
          "sandbox_cancelled"
        );
      }
      if (sandbox.state === "error") {
        throw new SandboxProviderError(
          `Boat sandbox entered error${sandbox.error ? `: ${sandbox.error}` : ""}`,
          "permanent"
        );
      }
      if (!BOAT_STARTING_STATES.has(sandbox.state)) {
        throw new SandboxProviderError(
          `Boat sandbox is ${sandbox.state} while a running machine was expected`,
          "permanent"
        );
      }
      if (Date.now() >= deadlineAtMs) {
        throw new SandboxProviderError(
          `Boat sandbox did not become ready within ${this.timings.readyTimeoutMs}ms (state ${sandbox.state})`,
          "transient"
        );
      }
      await delayUnlessCancelled(this.timings.pollIntervalMs);
    }
  }

  /**
   * Route the enabled service ports and the configured tunnel ports to public
   * URLs, and tell the runtime where its tunnels are.
   *
   * The three services carry their own authentication (code-server password,
   * terminal token, VNC password) and the web app embeds the terminal in an
   * iframe, where Boat's token cookie would be a blocked third-party cookie;
   * their routes are public. A user tunnel runs whatever the agent started and
   * stays behind Boat's token: its URL carries `_token`, which a browser
   * exchanges for a cookie on the first visit.
   *
   * Access URLs are user-facing extras, not how a session runs: each route is
   * resolved independently so one failure cannot hide the live sandbox.
   */
  private async exposeAccess(
    boatSandboxId: string,
    logicalSandboxId: string,
    portPlan: SandboxPortPlan,
    passwords: { codeServerPassword?: string; vncPassword?: string }
  ): Promise<BoatAccess> {
    const requests: Array<{
      kind: "codeServer" | "terminal" | "vnc" | "tunnel";
      port: number;
      public: boolean;
      title: string;
    }> = [];
    if (portPlan.codeServerPort !== undefined) {
      requests.push({
        kind: "codeServer",
        port: portPlan.codeServerPort,
        public: true,
        title: "code-server",
      });
    }
    if (portPlan.terminalPort !== undefined) {
      requests.push({
        kind: "terminal",
        port: portPlan.terminalPort,
        public: true,
        title: "terminal",
      });
    }
    if (portPlan.vncPort !== undefined) {
      requests.push({ kind: "vnc", port: portPlan.vncPort, public: true, title: "noVNC" });
    }
    for (const port of portPlan.extraTunnelPorts) {
      requests.push({ kind: "tunnel", port, public: false, title: `tunnel ${port}` });
    }

    const routes = await Promise.allSettled(
      requests.map((request) =>
        this.client.hostPort(boatSandboxId, {
          port: request.port,
          public: request.public,
          title: request.title,
        })
      )
    );

    const access: BoatAccess = {};
    const tunnelUrls: Record<string, string> = {};
    for (const [index, route] of routes.entries()) {
      const request = requests[index];
      if (route.status === "rejected") {
        log.warn("boat.host_port_failed", {
          sandbox_id: logicalSandboxId,
          access_kind: request.kind,
          port: request.port,
          error: route.reason instanceof Error ? route.reason.message : String(route.reason),
        });
        continue;
      }
      const url = route.value.url;
      if (request.kind === "codeServer") {
        access.codeServerUrl = url;
        access.codeServerPassword = passwords.codeServerPassword;
      } else if (request.kind === "terminal") {
        access.ttydUrl = url;
      } else if (request.kind === "vnc") {
        access.vncAccess = createVncAccess(url, passwords.vncPassword);
      } else {
        tunnelUrls[String(request.port)] = url;
      }
    }
    if (Object.keys(tunnelUrls).length > 0) {
      access.tunnelUrls = tunnelUrls;
      await this.writeTunnelEnvFile(boatSandboxId, logicalSandboxId, tunnelUrls);
    }
    return access;
  }

  private async writeTunnelEnvFile(
    boatSandboxId: string,
    logicalSandboxId: string,
    tunnelUrls: Record<string, string>
  ): Promise<void> {
    const lines = [
      `${TUNNEL_ENV_SANDBOX_ID_KEY}=${logicalSandboxId}`,
      ...Object.entries(tunnelUrls)
        .sort(([a], [b]) => Number(a) - Number(b))
        .map(([port, url]) => `TUNNEL_${port}=${url}`),
    ];
    await this.client.writeFile(boatSandboxId, {
      path: BOAT_TUNNEL_ENV_FILE_PATH,
      content: lines.join("\n") + "\n",
    });
  }

  /**
   * Start the baked launcher, detached, and watch it briefly: an exit within
   * the settle window means it never reached the runtime (or found one already
   * running, which is the one exit that counts as success). Readiness beyond
   * that is the bridge's phone-home and the connecting timeout, as everywhere.
   *
   * An image build's launch carries the sandbox's own id as a variable prefix
   * (the callback contract's provider session id); it cannot be in the
   * create-time env because it does not exist until create returns.
   */
  private async launchRuntime(
    boatSandboxId: string,
    options: { providerSessionId?: string } = {}
  ): Promise<void> {
    let command = BOAT_LAUNCHER_PATH;
    if (options.providerSessionId !== undefined) {
      assertSafeBoatSandboxId(options.providerSessionId);
      command = `${REPO_IMAGE_CALLBACK_ENV.providerSessionId}=${options.providerSessionId} ${BOAT_LAUNCHER_PATH}`;
    }
    const { processId } = await this.client.startDetachedCommand(boatSandboxId, command);
    const settleUntilMs = Date.now() + this.timings.launchSettleMs;
    for (;;) {
      await delayUnlessCancelled(this.timings.launchPollIntervalMs);
      const status = await this.client.getCommandStatus(boatSandboxId, processId);
      if (status.status === "exited") {
        if (status.exitCode === LAUNCHER_ALREADY_RUNNING_EXIT_CODE) {
          log.info("boat.runtime_already_running", { sandbox_id: boatSandboxId });
          return;
        }
        const detail = (status.stderr || status.stdout || "").trim().slice(-400);
        throw new SandboxProviderError(
          `Boat runtime launcher exited with code ${status.exitCode ?? "unknown"}${
            detail ? `: ${detail}` : ""
          }`,
          "permanent"
        );
      }
      if (status.status === "lost") {
        // Boat's agent restarted and forgot the process; the process itself
        // runs on under the user's systemd manager, and `running` is only a
        // best-effort probe from here. This is no verdict on the launcher:
        // readiness stays with the bridge's phone-home and the connecting
        // timeout, exactly as when the launcher is still running.
        log.warn("boat.runtime_launcher_lost", {
          sandbox_id: boatSandboxId,
          process_id: processId,
          running: status.running,
        });
        return;
      }
      if (Date.now() >= settleUntilMs) {
        log.info("boat.runtime_started", { sandbox_id: boatSandboxId, process_id: processId });
        return;
      }
    }
  }

  /**
   * Make a sandbox an organization pays for private before it is used. Boat
   * starts such sandboxes `shared` unless the organization's default is
   * private, and a shared sandbox lets every member run commands in it, which
   * would hand them the session env. A personal sandbox (no visibility) needs
   * nothing. Failing closed is the point: a sandbox that cannot be made
   * private must not boot the session.
   */
  private async ensurePrivate(sandbox: BoatSandbox): Promise<void> {
    if (sandbox.visibility !== "shared") return;
    const updated = await this.client.unshareSandbox(sandbox.id);
    if (updated.visibility !== "private") {
      throw new SandboxProviderError(
        `Boat sandbox ${sandbox.id} stayed ${updated.visibility ?? "unknown"} after unshare; set the organization's new-sandbox visibility to private`,
        "permanent"
      );
    }
    log.info("boat.sandbox_made_private", { sandbox_id: sandbox.id });
  }

  /**
   * Label the sandbox in Boat's dashboard with the deployment and the logical
   * sandbox id. Create assigns a display name of its own, so this is a second
   * call, and a cosmetic one: a failure is logged, never fatal.
   */
  private async nameSandbox(boatSandboxId: string, logicalSandboxId: string): Promise<void> {
    try {
      await this.client.updateSandbox(boatSandboxId, {
        name: boatSandboxName(this.providerConfig.deploymentName, logicalSandboxId),
      });
    } catch (error) {
      log.warn("boat.name_sandbox_failed", {
        sandbox_id: boatSandboxId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** Best-effort delete for a sandbox we are abandoning; never masks the original error. */
  private async cleanupSandbox(boatSandboxId: string, event: string): Promise<void> {
    try {
      await this.client.deleteSandbox(boatSandboxId);
    } catch (error) {
      if (error instanceof BoatNotFoundError) return;
      log.warn(event, {
        sandbox_id: boatSandboxId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * The control-plane classification of a failed Boat call, by status and
   * code only. Rate limits and server errors are the provider's moment, not a
   * broken deployment, so they stay off the circuit breaker; every other API
   * answer says the request was wrong.
   */
  private classifyError(message: string, error: unknown): SandboxProviderError {
    if (error instanceof SandboxProviderError) return error;
    if (error instanceof BoatCancelledError) {
      // The budget ran out, not the provider: the obligation stays pending.
      return new SandboxProviderError(`${message}: ${error.message}`, "transient", error);
    }
    if (error instanceof BoatApiError) {
      const transient = error.status === 429 || error.status >= 500;
      return new SandboxProviderError(
        `${message}: ${error.message}`,
        transient ? "transient" : "permanent",
        error
      );
    }
    // Anything else (a transport failure, a callback the workflow rejected)
    // keeps its own words: they are what the build row and the logs show.
    const detail = error instanceof Error && error.message ? `: ${error.message}` : "";
    return SandboxProviderError.fromFetchError(`${message}${detail}`, error);
  }
}

export function createBoatProvider(
  client: BoatRestClient,
  providerConfig: BoatProviderConfig
): BoatSandboxProvider {
  return new BoatSandboxProvider(client, providerConfig);
}
