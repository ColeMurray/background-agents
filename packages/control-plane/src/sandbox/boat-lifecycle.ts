/**
 * How a Boat sandbox is brought up, driven and brought down, shared by the
 * session provider (providers/boat-provider.ts) and the image-build resources
 * (image-builds/boat-build-resources.ts): the idempotent create, the wait for
 * a running machine, privacy, the detached launch of the baked launcher, the
 * archive that stops a sandbox with its disk saved, and the
 * classification of a failed call. What a sandbox is for — a session's env
 * and ports, a build's callback contract — stays with each caller.
 */

import { bytesToHex } from "@open-inspect/shared/auth";
import type { SandboxSettings } from "@open-inspect/shared/types/integrations";
import { createLogger } from "../logger";
import {
  BoatApiError,
  BoatCancelledError,
  BoatConflictError,
  BoatNotFoundError,
  delayUnlessCancelled,
  type BoatCreateSandboxParams,
  type BoatCreatedSandbox,
  type BoatMachineType,
  type BoatRestClient,
  type BoatSandbox,
} from "./boat-rest-client";
import {
  DEFAULT_SANDBOX_TIMEOUT_SECONDS,
  SandboxProviderError,
  signalUntilDeadline,
} from "./provider";
import { SANDBOX_RUNTIME_VERSION } from "./runtime-manifest";
import { REPO_IMAGE_CALLBACK_ENV } from "./sandbox-env";

const log = createLogger("boat-lifecycle");

/**
 * Runtime version reported by Boat sandboxes, so spawn-time selection can gate
 * on the compatibility floor. Derived from the manifest rather than pinned,
 * exactly as E2B_SANDBOX_VERSION is.
 */
export const BOAT_SANDBOX_VERSION = SANDBOX_RUNTIME_VERSION;

/** Env names Boat refuses in a per-sandbox env (`invalid_env`); they are Boat's own. */
const BOAT_RESERVED_ENV_KEYS: readonly string[] = [
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
 * The file whose presence lets a create-time launch proceed. The control
 * plane writes it (see {@link BoatSandboxLifecycle.releaseLaunch}) only once
 * the sandbox is known private and its tunnel env file is in the workspace,
 * so the runtime can outrun neither. Under `/tmp`, which no Boat snapshot
 * keeps, so no image or restored disk can carry one.
 */
export const BOAT_LAUNCH_MARKER_PATH = "/tmp/openinspect-launch";
/**
 * Where the runtime reads its tunnel URLs: `/workspace/.tunnels.env`, through
 * the `/workspace` link the launcher keeps into the home directory. Boat's
 * file API writes under `/home/user` and `/tmp`, and a write to a sandbox that
 * is still starting waits until it is ready, so even a create's write lands on
 * the disk the sandbox keeps.
 */
export const BOAT_TUNNEL_ENV_FILE_PATH = "/home/user/workspace/.tunnels.env";
/**
 * What a session create hands Boat as its `setupScript`. Boat runs it through
 * bash as the sandbox user, with the create-time env applied, the moment the
 * machine is up, so the runtime starts with the machine instead of after the
 * control plane has noticed it: the way Modal and Daytona start the runtime
 * as the container's command. It waits for the launch marker first, for as
 * long as the create takes to release it, retries included: a deadline of its
 * own could only expire while this side is still completing the create, and a
 * sandbox whose create fails is deleted, its script with it. Then it `exec`s
 * the launcher, which execs into the runtime in turn, so the script never
 * returns and Boat reports it `running` for the sandbox's life; a launcher
 * that exits at once shows as `failed`, with the exit code and stderr in
 * `setupError`. A resume cannot use it (it is create-time only) and starts
 * the launcher with {@link BoatSandboxLifecycle.launchRuntime} instead.
 */
export const BOAT_SETUP_SCRIPT = [
  "#!/bin/bash",
  "# Started by Boat the moment the machine is up. The control plane writes the",
  "# launch marker once the sandbox is known private and its tunnel env file is",
  "# in the workspace, so the runtime can outrun neither.",
  `until [ -f ${BOAT_LAUNCH_MARKER_PATH} ]; do sleep 0.2; done`,
  `exec ${BOAT_LAUNCHER_PATH}`,
  "",
].join("\n");

/**
 * A Boat sandbox id is interpolated into one command line (a build's launch)
 * and persisted as a build's provider session; an id outside this alphabet
 * is refused before either use.
 */
const BOAT_SANDBOX_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

/** Boat's web dashboard; a sandbox's page is a query on it (buildBoatSandboxDashboardUrl). */
const BOAT_DASHBOARD_URL = "https://boat.dev/dashboard";

/** Idempotent create attempts after a lost response. */
const CREATE_ATTEMPTS = 3;
/** Tries for the launch-marker write before a create gives up. */
const LAUNCH_RELEASE_ATTEMPTS = 3;

/** How long a flow waits, and how often it looks, at each step of a sandbox's life. */
export interface BoatLifecycleTimings {
  /** How often a flow waiting on an archive re-reads the sandbox's state. */
  pollIntervalMs: number;
  /**
   * Pause between reads while a created or resumed sandbox is still starting.
   * Every read is a round trip to Boat's API, so this is a floor under the
   * cadence rather than the cadence: the next read goes out as soon as the
   * previous one has answered and this pause has passed.
   */
  readyPollIntervalMs: number;
  /** Budget for a created or resumed sandbox to report `ready`. */
  readyTimeoutMs: number;
  /** Budget for an archive when the caller set no deadline of its own. */
  stopTimeoutMs: number;
  /**
   * How long the launcher is watched after a start for an early exit. The
   * window only has to catch a launcher that fails at once (bad arguments, a
   * lock another runtime holds); a process still running when it closes is
   * the bridge's to report on, through its phone-home and the connecting
   * timeout, as on every provider.
   */
  launchSettleMs: number;
  launchPollIntervalMs: number;
  /** Pause before the first repeat of a create whose response was lost; later ones back off. */
  createRetryDelayMs: number;
}

const DEFAULT_BOAT_LIFECYCLE_TIMINGS: BoatLifecycleTimings = {
  pollIntervalMs: 2_000,
  readyPollIntervalMs: 250,
  readyTimeoutMs: 150_000,
  stopTimeoutMs: 120_000,
  launchSettleMs: 1_000,
  launchPollIntervalMs: 1_000,
  createRetryDelayMs: 2_000,
};

/** States in which a sandbox has a machine and accepts commands. */
export const BOAT_LIVE_STATES: ReadonlySet<string> = new Set(["ready", "idle", "running"]);
/** States on the way to a machine. */
export const BOAT_STARTING_STATES: ReadonlySet<string> = new Set([
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

/**
 * How an archive ended. `archived` is the one outcome with a usable saved
 * disk; `timed_out` means the budget (the deadline, or the caller's own
 * cancellation) ran out before Boat confirmed one, so the archive may well
 * still be Boat's to finish; `missing` means Boat no longer has the sandbox;
 * `unusable` means Boat finished without a disk anything can resume from.
 */
export type BoatArchiveOutcome =
  | { type: "archived" }
  | { type: "timed_out" }
  | { type: "missing" }
  | { type: "unusable"; detail: string };

/**
 * Whether an archived sandbox has a disk anything can resume from or save:
 * a snapshot exists, and the stop that archived it (if one was requested)
 * completed. `snapshotAvailable` alone is not enough: it also reports an
 * earlier automatic snapshot, which a stop that failed its final capture
 * leaves behind without the writes since.
 */
export function isUsableBoatArchive(sandbox: BoatSandbox): boolean {
  const stopStatus = sandbox.stop?.status;
  return (
    sandbox.state === "archived" &&
    sandbox.snapshotAvailable === true &&
    (stopStatus === undefined || stopStatus === "completed")
  );
}

/** Machine size for a resource request: the smallest one that fits. */
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
 * Boat rejects its own names in a per-sandbox env, so a user secret under
 * one of them can never be delivered; drop it rather than fail every spawn.
 */
export function dropBoatReservedEnv(envVars: Record<string, string>, sandboxId: string): void {
  const dropped = BOAT_RESERVED_ENV_KEYS.filter((key) => key in envVars);
  for (const key of dropped) delete envVars[key];
  if (dropped.length > 0) {
    log.warn("boat.reserved_env_dropped", { sandbox_id: sandboxId, keys: dropped });
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

/** The display name a sandbox carries in Boat's dashboard: the deployment and the logical id. */
export function boatSandboxName(deploymentName: string, sandboxId: string): string {
  return `openinspect-${deploymentName}-${sandboxId}`.slice(0, BOAT_MAX_NAME_CHARS);
}

/**
 * A sandbox's detail page on Boat's dashboard: the Sandboxes tab with the
 * sandbox selected by id, the link the dashboard itself pushes when a row is
 * opened. The dashboard scopes the list to the organization selected in it, so
 * an organization-billed sandbox opens once that organization is selected.
 */
export function buildBoatSandboxDashboardUrl(
  providerObjectId: string | null | undefined
): string | null {
  if (!providerObjectId) return null;
  return `${BOAT_DASHBOARD_URL}?tab=sandboxes&sandbox=${encodeURIComponent(providerObjectId)}`;
}

/** Refuse a Boat sandbox id before it is persisted or interpolated anywhere. */
export function assertSafeBoatSandboxId(boatSandboxId: string): void {
  if (!BOAT_SANDBOX_ID_PATTERN.test(boatSandboxId)) {
    throw new SandboxProviderError(
      "Boat returned a sandbox id outside the expected alphabet",
      "permanent"
    );
  }
}

/** Whether a failed create may be repeated under the same idempotency key. */
function isRetryableCreateFailure(error: unknown): boolean {
  if (error instanceof BoatConflictError) return error.code === "idempotency_in_progress";
  if (error instanceof BoatApiError) return error.status >= 500;
  if (error instanceof BoatCancelledError) return false;
  return SandboxProviderError.isTransientNetworkError(error);
}

/**
 * The control-plane classification of a failed Boat call, by status and
 * code only. Rate limits and server errors are the provider's moment, not a
 * broken deployment, so they stay off the circuit breaker; every other API
 * answer says the request was wrong.
 */
export function classifyBoatError(message: string, error: unknown): SandboxProviderError {
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

/** The steps every Boat sandbox goes through, over one client and one set of budgets. */
export class BoatSandboxLifecycle {
  readonly timings: BoatLifecycleTimings;

  constructor(
    private readonly client: BoatRestClient,
    timings: Partial<BoatLifecycleTimings> = {}
  ) {
    this.timings = { ...DEFAULT_BOAT_LIFECYCLE_TIMINGS, ...timings };
  }

  /**
   * Create under an idempotency key, repeating the same request after a lost
   * response. Boat answers a repeat with the same key and body with the first
   * sandbox, and with the routes of the ports it hosted, so a retry never
   * starts a second machine or spends a second start.
   */
  async createSandbox(params: BoatCreateSandboxParams): Promise<BoatCreatedSandbox> {
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
  async waitForReady(boatSandboxId: string): Promise<BoatSandbox> {
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
      await delayUnlessCancelled(this.timings.readyPollIntervalMs);
    }
  }

  /**
   * Make sure a sandbox an organization pays for is private before it is
   * used: a shared sandbox lets every member run commands in it, which would
   * hand them whatever the sandbox holds. A create asks Boat for a private
   * sandbox, which Boat sets before the sandbox has a machine, so a fresh one
   * passes without a call, as does a personal sandbox (no visibility). One
   * that still reports `shared`, because Boat did not honor the request or
   * someone has shared it since, is unshared here. Failing closed is the
   * point: a sandbox that cannot be made private never gets its launch
   * marker, so its runtime never starts, and a create deletes it.
   */
  async ensurePrivate(sandbox: BoatSandbox): Promise<void> {
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
   * Start the baked launcher, detached, and watch it briefly: an exit within
   * the settle window means it never reached the runtime (or found one already
   * running, which is the one exit that counts as success). Readiness beyond
   * that is the bridge's phone-home and the connecting timeout, as everywhere.
   *
   * An image build's launch carries the sandbox's own id as a variable prefix
   * (the callback contract's provider session id); it cannot be in the
   * create-time env because it does not exist until create returns.
   */
  async launchRuntime(
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
   * Let a create-time launch proceed: write the marker the setup script waits
   * for. Called once the sandbox is known private and its tunnel env file is
   * in the workspace. Boat holds a write to a sandbox that is still starting
   * until it is ready, so the marker lands about when the machine comes up. A
   * write that fails after a few tries fails the create, so the runtime never
   * starts without it.
   */
  async releaseLaunch(boatSandboxId: string): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      try {
        await this.client.writeFile(boatSandboxId, {
          path: BOAT_LAUNCH_MARKER_PATH,
          content: "released\n",
        });
        return;
      } catch (error) {
        if (attempt >= LAUNCH_RELEASE_ATTEMPTS) throw error;
        log.warn("boat.launch_release_retry", {
          sandbox_id: boatSandboxId,
          attempt,
          error: error instanceof Error ? error.message : String(error),
        });
        await delayUnlessCancelled(this.timings.createRetryDelayMs);
      }
    }
  }

  /**
   * Watch Boat's create-time launch briefly for an early exit, as the
   * detached start did: from the moment the launcher can have started (the
   * later of machine-up and the marker write) until the settle window closes,
   * any exit is a failed launch and `setupError` says how. `running` is the
   * normal steady state, since the launcher never returns; readiness beyond
   * the window is the bridge's phone-home and the connecting timeout, as on
   * every provider. Create-time only: a resumed sandbox still carries its
   * create's status, which says nothing about the machine the resume brought
   * up.
   */
  async confirmLaunch(boatSandboxId: string, launchedAtMs: number): Promise<void> {
    const settleUntilMs = launchedAtMs + this.timings.launchSettleMs;
    for (;;) {
      const sandbox = await this.client.getSandbox(boatSandboxId);
      if (sandbox.setupStatus === "failed" || sandbox.setupStatus === "done") {
        const detail = (sandbox.setupError ?? "").trim().slice(-400);
        throw new SandboxProviderError(
          `Boat runtime launcher exited${detail ? `: ${detail}` : ""}`,
          "permanent"
        );
      }
      if (Date.now() >= settleUntilMs) {
        log.info("boat.runtime_started", {
          sandbox_id: boatSandboxId,
          setup_status: sandbox.setupStatus ?? null,
        });
        return;
      }
      await delayUnlessCancelled(this.timings.launchPollIntervalMs);
    }
  }

  /**
   * Stop a sandbox with its disk saved: Boat snapshots the disk, then
   * releases the machine, and the sandbox is `archived`. Never forced, so
   * nothing written since the last automatic snapshot is lost. A sandbox
   * Boat had already archived is read rather than stopped again, and the
   * read decides whether that archive is a usable one.
   *
   * Answers with what actually happened rather than throwing on a budget
   * that ran out: an archive Boat is still finishing is an outcome the
   * caller must keep waiting on, not a failure. A call Boat refused or that
   * never reached it is thrown as is, for the caller to classify.
   */
  async archive(
    boatSandboxId: string,
    options: { signal?: AbortSignal; deadlineAtMs?: number } = {}
  ): Promise<BoatArchiveOutcome> {
    const deadlineAtMs = options.deadlineAtMs ?? Date.now() + this.timings.stopTimeoutMs;
    const signal = signalUntilDeadline(deadlineAtMs, options.signal);
    try {
      try {
        await this.client.stopSandbox(boatSandboxId, signal);
      } catch (error) {
        if (error instanceof BoatNotFoundError) return { type: "missing" };
        // Boat refuses to stop a sandbox that is already archived; the read
        // below decides whether that archive is a usable one.
        if (!(error instanceof BoatApiError && error.status === 400)) throw error;
      }

      for (;;) {
        let current: BoatSandbox;
        try {
          current = await this.client.getSandbox(boatSandboxId, signal);
        } catch (error) {
          if (error instanceof BoatNotFoundError) return { type: "missing" };
          throw error;
        }
        if (current.state === "archived") {
          if (isUsableBoatArchive(current)) return { type: "archived" };
          return {
            type: "unusable",
            detail: `Boat archived the sandbox without a usable snapshot (stop ${
              current.stop?.status ?? "unknown"
            }${current.stop?.error ? `: ${current.stop.error}` : ""})`,
          };
        }
        if (current.state === "error" || current.state === "cancelled") {
          return {
            type: "unusable",
            detail: `Sandbox state was ${current.state} after stop${
              current.error ? `: ${current.error}` : ""
            }`,
          };
        }
        if (BOAT_LIVE_STATES.has(current.state) && !current.stop) {
          return { type: "unusable", detail: `Sandbox state was ${current.state} after stop` };
        }
        await delayUnlessCancelled(this.timings.pollIntervalMs, signal);
      }
    } catch (error) {
      if (error instanceof BoatCancelledError || signal?.aborted) return { type: "timed_out" };
      throw error;
    }
  }

  /** Best-effort delete for a sandbox we are abandoning; never masks the original error. */
  async deleteQuietly(boatSandboxId: string, event: string): Promise<void> {
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
}
