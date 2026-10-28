/**
 * Boat sandbox provider — calls the Boat REST API directly.
 *
 * A Boat sandbox is a full Ubuntu VM deployed from a saved snapshot the
 * `boat-infra` build saved (the sandbox image with the runtime baked in). The
 * per-sandbox env (secrets included) rides `POST /sandboxes` `env`, which Boat
 * applies to every process the sandbox starts, and the baked launcher rides
 * the same request as Boat's setup script, so Boat starts it the moment the
 * machine is up and this side has released the launch (a resume starts it
 * again with a detached command). The same request names the sandbox, makes
 * it private and routes its ports. The launcher execs the runtime entrypoint. Readiness is the uniform contract:
 * the sandbox bridge phones home, and the connecting timeout fails the
 * session otherwise.
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
 * Prebuilt images are saved snapshots too, saved by the image-build resources
 * (image-builds/boat-build-resources.ts) from a build sandbox that deployed
 * from the base snapshot. A prebuilt spawn is a create with that name in place
 * of the base snapshot and `FROM_REPO_IMAGE` set, so the runtime syncs the
 * checkout and skips setup.sh. The image's contract is its filesystem: a
 * session deployed from it gets its own env and boots the launcher like any
 * other. The steps a session shares with a build — the idempotent create, the
 * wait for a running machine, privacy, the launch, the archive — are
 * boat-lifecycle.ts.
 *
 * A sandbox an organization pays for starts `shared` under an organization
 * default that says so, and every member of a shared sandbox can run commands
 * in it. The session env holds the sandbox auth token and user secrets, so the
 * create asks for a private sandbox, which Boat sets before the sandbox has a
 * machine. One that still reports itself shared is made private before it is
 * used, and the create fails closed if that cannot be done.
 */

import {
  supportsConfigurableSandboxTimeout,
  type SandboxSettings,
} from "@open-inspect/shared/types/integrations";
import { createLogger } from "../../logger";
import type { SourceControlProviderName } from "../../source-control";
import {
  BoatConflictError,
  BoatNotFoundError,
  type BoatCreatedSandbox,
  type BoatCreateHostedPort,
  type BoatHostPortRequest,
  type BoatMachineType,
  type BoatRestClient,
  type BoatSandbox,
} from "../boat-rest-client";
import {
  BOAT_SETUP_SCRIPT,
  assertBoatEnvWithinLimits,
  BOAT_LIVE_STATES,
  BOAT_SANDBOX_VERSION,
  BOAT_STARTING_STATES,
  BoatSandboxLifecycle,
  boatIdempotencyKey,
  boatSandboxName,
  classifyBoatError,
  dropBoatReservedEnv,
  resolveBoatMachineType,
  resolveBoatTtlSeconds,
  type BoatArchiveOutcome,
  type BoatLifecycleTimings,
  BOAT_TUNNEL_ENV_FILE_PATH,
} from "../boat-lifecycle";
import {
  buildSandboxEnvVars,
  DEFERRED_START_ENV_VAR,
  deriveCodeServerPassword,
  deriveVncPassword,
  IMAGE_BUILD_MODE_ENV_VAR,
  scmCloneIdentity,
} from "../sandbox-env";
import { resolveSandboxPortPlan, type SandboxPortPlan } from "./port-resolution";
import {
  createVncAccess,
  PrebuiltImageUnavailableError,
  SandboxProviderError,
  signalUntilDeadline,
  type CreateSandboxConfig,
  type CreateSandboxResult,
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

export { BOAT_TUNNEL_ENV_FILE_PATH } from "../boat-lifecycle";
// Mirrors TUNNEL_ENV_SANDBOX_ID_KEY in sandbox_runtime/constants.py: tags the
// tunnel env file with the sandbox it was written for, so the supervisor's
// stale-file cleanup keeps a fresh write instead of deleting it.
const TUNNEL_ENV_SANDBOX_ID_KEY = "TUNNEL_SANDBOX_ID";
const EXPECTED_TUNNEL_PORTS_ENV_VAR = "EXPECTED_TUNNEL_PORTS";

/** One port a session routes, and what it is for. */
interface BoatPortRequest extends BoatHostPortRequest {
  kind: "codeServer" | "terminal" | "vnc" | "tunnel";
  title: string;
}

export interface BoatProviderConfig {
  scmProvider: SourceControlProviderName;
  /** Secret used for domain-separated sandbox access password derivation. */
  sandboxAccessPasswordSecret: string;
  /** Saved snapshot every fresh sandbox deploys from (built by boat-infra). */
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

function lifetimeFromSandbox(sandbox: BoatSandbox): SandboxLifetime {
  const observedAtMs = Date.now();
  if (sandbox.archiveAfter === null) return { kind: "none", observedAtMs };
  const expiresAtMs = sandbox.archiveAfter ? Date.parse(sandbox.archiveAfter) : Number.NaN;
  return Number.isFinite(expiresAtMs)
    ? { kind: "finite", expiresAtMs, observedAtMs, source: "provider" }
    : { kind: "unknown", observedAtMs, reason: "Boat sandbox omitted a valid archiveAfter" };
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

  private readonly lifecycle: BoatSandboxLifecycle;

  constructor(
    private readonly client: BoatRestClient,
    private readonly providerConfig: BoatProviderConfig,
    timings: Partial<BoatLifecycleTimings> = {}
  ) {
    this.lifecycle = new BoatSandboxLifecycle(client, timings);
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

      const portRequests = this.portRequests(portPlan);
      let created: BoatCreatedSandbox;
      try {
        created = await this.lifecycle.createSandbox({
          type: machineType,
          ttlSeconds,
          env: envVars,
          // A prebuilt image is a saved snapshot too: the session deploys
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
          // Boat runs this the moment the machine is up, with the env above
          // applied, so the boot never waits for this side to notice readiness.
          // The script execs the launcher once the launch marker below lands.
          setupScript: BOAT_SETUP_SCRIPT,
          // Named, private and routed by the create itself: Boat sets the
          // visibility before the sandbox has a machine, and answers the
          // routes once it has one.
          name: boatSandboxName(this.providerConfig.deploymentName, config.sandboxId),
          visibility: "private",
          hostedPorts: portRequests.map(({ port, public: isPublic, title }) => ({
            port,
            public: isPublic,
            title,
          })),
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
      boatSandboxId = created.sandbox.id;
      await this.lifecycle.ensurePrivate(created.sandbox);

      // A port the create could not host is hosted on its own, and the tunnel
      // env file goes straight into the workspace: Boat holds a write to a
      // starting sandbox until it is ready, so it lands on the disk the
      // sandbox keeps.
      const access = await this.exposeAccess(
        boatSandboxId,
        config.sandboxId,
        portRequests,
        { codeServerPassword, vncPassword },
        created.hostedPorts
      );
      // Known private, and the tunnel env file in place: the setup script Boat
      // started at machine-up may now exec the launcher.
      await this.lifecycle.releaseLaunch(boatSandboxId);
      const releasedAtMs = Date.now();

      const ready = await this.lifecycle.waitForReady(boatSandboxId);
      // The launcher started when the machine came up or when the launch was
      // released, whichever was later; watch it briefly from there for an
      // early exit, as the detached start did.
      await this.lifecycle.confirmLaunch(boatSandboxId, Math.max(releasedAtMs, Date.now()));

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
        await this.lifecycle.deleteQuietly(boatSandboxId, "boat.create_cleanup_failed");
      }
      throw classifyBoatError("Failed to create Boat sandbox", error);
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
        await this.lifecycle.ensurePrivate(sandbox);
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

        const ready = await this.lifecycle.waitForReady(config.providerObjectId);
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
        // A resume cannot route ports with the request that brings the
        // sandbox back, so each one is hosted again, which answers the URLs it
        // had; the machine is up, and the tunnel env file goes into place.
        const access = await this.exposeAccess(
          config.providerObjectId,
          config.sandboxId,
          this.portRequests(portPlan),
          { codeServerPassword, vncPassword }
        );
        // The create's setup script does not run again. The launcher is
        // started here: on a new machine it finds the completed-boot marker
        // and boots the runtime in restored mode, and on the parked machine of
        // a quick resume it finds the runtime still running and leaves it be.
        await this.lifecycle.launchRuntime(config.providerObjectId);

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
      throw classifyBoatError("Failed to resume Boat sandbox", error);
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
    if (config.intent === "destroy") {
      const deadlineAtMs = config.deadlineAtMs ?? Date.now() + this.lifecycle.timings.stopTimeoutMs;
      const signal = signalUntilDeadline(deadlineAtMs, config.signal);
      try {
        await this.client.deleteSandbox(config.providerObjectId, signal);
      } catch (error) {
        if (error instanceof BoatNotFoundError) return { success: true };
        throw classifyBoatError("Failed to delete Boat sandbox", error);
      }
      return { success: true };
    }

    let outcome: BoatArchiveOutcome;
    try {
      outcome = await this.lifecycle.archive(config.providerObjectId, {
        signal: config.signal,
        deadlineAtMs: config.deadlineAtMs,
      });
    } catch (error) {
      throw classifyBoatError("Failed to stop Boat sandbox", error);
    }
    switch (outcome.type) {
      case "archived":
        return { success: true };
      case "timed_out":
        return {
          success: false,
          error: "Timed out before Boat confirmed the sandbox was archived with a snapshot",
        };
      case "missing":
        return {
          success: false,
          error: "Sandbox disappeared before graceful shutdown was verified",
        };
      case "unusable":
        return { success: false, error: outcome.detail };
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

    dropBoatReservedEnv(envVars, config.sandboxId);

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

  /**
   * The ports a session routes, and what each is for: the enabled services,
   * on public URLs because their own logins guard them, then the user's tunnel
   * ports, which keep Boat's `_token`.
   */
  private portRequests(portPlan: SandboxPortPlan): BoatPortRequest[] {
    const requests: BoatPortRequest[] = [];
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
    return requests;
  }

  /**
   * Route every requested port, assemble the access the session gets, and
   * write the tunnel env file into the workspace. A port the create routed is
   * taken from its answer; any other, including one the create could not
   * host, is hosted with its own call, as Boat prescribes for that case. A
   * port that still fails is logged and left out: the session runs without
   * that link rather than not at all.
   */
  private async exposeAccess(
    boatSandboxId: string,
    logicalSandboxId: string,
    requests: BoatPortRequest[],
    passwords: { codeServerPassword?: string; vncPassword?: string },
    hostedByCreate: BoatCreateHostedPort[] = []
  ): Promise<BoatAccess> {
    const routedByCreate = new Map<number, string>();
    for (const hosted of hostedByCreate) {
      if (hosted.url) {
        routedByCreate.set(hosted.port, hosted.url);
        continue;
      }
      log.warn("boat.create_host_port_failed", {
        sandbox_id: logicalSandboxId,
        port: hosted.port,
        error: hosted.error ?? null,
        detail: hosted.message ?? null,
      });
    }

    const routes = await Promise.allSettled(
      requests.map(async (request) => {
        const routed = routedByCreate.get(request.port);
        if (routed !== undefined) return routed;
        const hosted = await this.client.hostPort(boatSandboxId, {
          port: request.port,
          public: request.public,
          title: request.title,
        });
        return hosted.url;
      })
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
      const url = route.value;
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
}

export function createBoatProvider(
  client: BoatRestClient,
  providerConfig: BoatProviderConfig
): BoatSandboxProvider {
  return new BoatSandboxProvider(client, providerConfig);
}
