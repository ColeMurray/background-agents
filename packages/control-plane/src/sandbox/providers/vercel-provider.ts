/**
 * Vercel Sandbox provider implementation.
 */

import { computeHmacHex, MAX_TUNNEL_PORTS, type SandboxSettings } from "@open-inspect/shared";
import { createLogger } from "../../logger";
import type { CorrelationContext } from "../../logger";
import type { SourceControlProviderName } from "../../source-control";
import {
  DEFAULT_SANDBOX_TIMEOUT_SECONDS,
  SandboxProviderError,
  type CreateSandboxConfig,
  type CreateSandboxResult,
  type RestoreConfig,
  type RestoreResult,
  type SandboxProvider,
  type SandboxProviderCapabilities,
  type SnapshotConfig,
  type SnapshotResult,
  type StopConfig,
  type StopResult,
} from "../provider";
import type {
  VercelCreateSandboxResponse,
  VercelSandboxClient,
  VercelSandboxRoute,
} from "../vercel-client";
import { VercelSandboxApiError } from "../vercel-client";
import { DEFAULT_VERCEL_RUNTIME, VERCEL_PYTHON_BIN } from "../vercel-bootstrap";

const log = createLogger("vercel-provider");

const CODE_SERVER_PORT = 8080;
const TTYD_PROXY_PORT = 7680;
const TUNNEL_ENV_FILE_PATH = "/workspace/.tunnels.env";
const EXPECTED_TUNNEL_PORTS_ENV_VAR = "EXPECTED_TUNNEL_PORTS";
const DEFAULT_SNAPSHOT_EXPIRATION_MS = 0;
const BUILD_TIMEOUT_SECONDS = 1800;
const VERCEL_TUNNEL_ENV_WRITE_TIMEOUT_MS = 30_000;

export interface VercelProviderConfig {
  scmProvider: SourceControlProviderName;
  baseSnapshotId?: string;
  baseSnapshotName?: string;
  runtime?: string;
  snapshotExpirationMs?: number;
  codeServerPasswordSecret: string;
  internalCallbackSecret?: string;
  apiBaseUrl?: string;
  token: string;
  teamId?: string;
}

export interface TriggerVercelRepoImageBuildConfig {
  buildId: string;
  repoOwner: string;
  repoName: string;
  defaultBranch: string;
  callbackUrl: string;
  userEnvVars?: Record<string, string>;
  cloneToken?: string;
  correlation?: CorrelationContext;
}

export interface TriggerVercelRepoImageBuildResult {
  buildId: string;
  status: string;
}

export class VercelSandboxProvider implements SandboxProvider {
  readonly name = "vercel";
  private baseSnapshotIdPromise?: Promise<string>;

  readonly capabilities: SandboxProviderCapabilities = {
    supportsSnapshots: true,
    supportsRestore: true,
    supportsWarm: true,
    supportsPersistentResume: false,
    supportsExplicitStop: true,
  };

  constructor(
    private readonly client: VercelSandboxClient,
    private readonly providerConfig: VercelProviderConfig
  ) {}

  async createSandbox(config: CreateSandboxConfig): Promise<CreateSandboxResult> {
    try {
      const env = await this.buildEnvVars(config, {
        fromRepoImage: !!config.repoImageId,
        repoImageSha: config.repoImageSha ?? undefined,
      });
      const ports = collectExposedPorts(
        config.codeServerEnabled,
        config.sandboxSettings
      ).allExposedPorts;
      const sourceSnapshotId =
        config.repoImageId || (await this.resolveBaseSnapshotId(config.correlation));
      if (!sourceSnapshotId) {
        throw new Error(
          "VERCEL_BASE_SNAPSHOT_ID or VERCEL_BASE_SNAPSHOT_NAME is required for fresh Vercel sandboxes when no repo image snapshot is available"
        );
      }

      const created = await this.client.createSandbox(
        {
          name: config.sandboxId,
          runtime: this.providerConfig.runtime || DEFAULT_VERCEL_RUNTIME,
          timeoutMs: (config.timeoutSeconds ?? DEFAULT_SANDBOX_TIMEOUT_SECONDS) * 1000,
          ports,
          env,
          tags: this.buildTags(config),
          sourceSnapshotId,
        },
        config.correlation
      );

      const access = await this.prepareSandboxAccess(
        created,
        config.sandboxId,
        config.codeServerEnabled,
        config.sandboxSettings,
        config.correlation
      );

      await this.launchEntrypoint(created.session.id, {}, config.correlation);

      return {
        sandboxId: config.sandboxId,
        providerObjectId: created.session.id,
        status: "warming",
        createdAt: created.session.createdAt || Date.now(),
        codeServerUrl: access.codeServerUrl,
        codeServerPassword: access.codeServerPassword,
        ttydUrl: access.ttydUrl,
        tunnelUrls: access.tunnelUrls,
      };
    } catch (error) {
      throw this.classifyError("Failed to create Vercel sandbox", error);
    }
  }

  async restoreFromSnapshot(config: RestoreConfig): Promise<RestoreResult> {
    try {
      const env = await this.buildEnvVars(config, { restoredFromSnapshot: true });
      const ports = collectExposedPorts(
        config.codeServerEnabled,
        config.sandboxSettings
      ).allExposedPorts;

      const created = await this.client.createSandbox(
        {
          name: config.sandboxId,
          runtime: this.providerConfig.runtime || DEFAULT_VERCEL_RUNTIME,
          timeoutMs: (config.timeoutSeconds ?? DEFAULT_SANDBOX_TIMEOUT_SECONDS) * 1000,
          ports,
          env,
          tags: this.buildTags(config),
          sourceSnapshotId: config.snapshotImageId,
        },
        config.correlation
      );

      const access = await this.prepareSandboxAccess(
        created,
        config.sandboxId,
        config.codeServerEnabled,
        config.sandboxSettings,
        config.correlation
      );

      await this.launchEntrypoint(created.session.id, {}, config.correlation);

      return {
        success: true,
        sandboxId: config.sandboxId,
        providerObjectId: created.session.id,
        codeServerUrl: access.codeServerUrl,
        codeServerPassword: access.codeServerPassword,
        ttydUrl: access.ttydUrl,
        tunnelUrls: access.tunnelUrls,
      };
    } catch (error) {
      if (error instanceof SandboxProviderError) throw error;
      throw this.classifyError("Failed to restore Vercel sandbox from snapshot", error);
    }
  }

  async takeSnapshot(config: SnapshotConfig): Promise<SnapshotResult> {
    try {
      const snapshot = await this.client.snapshotSession(
        config.providerObjectId,
        {
          expirationMs: this.providerConfig.snapshotExpirationMs ?? DEFAULT_SNAPSHOT_EXPIRATION_MS,
        },
        config.correlation
      );

      if (snapshot.snapshot.status !== "created") {
        return {
          success: false,
          error: `Snapshot status was ${snapshot.snapshot.status}`,
        };
      }

      return { success: true, imageId: snapshot.snapshot.id };
    } catch (error) {
      if (error instanceof SandboxProviderError) throw error;
      throw this.classifyError("Failed to snapshot Vercel sandbox", error);
    }
  }

  async stopSandbox(config: StopConfig): Promise<StopResult> {
    try {
      await this.client.stopSession(config.providerObjectId, config.correlation);
      return { success: true };
    } catch (error) {
      if (error instanceof VercelSandboxApiError && error.status === 404) {
        return { success: true };
      }
      if (error instanceof SandboxProviderError) throw error;
      throw this.classifyError("Failed to stop Vercel sandbox", error);
    }
  }

  async triggerRepoImageBuild(
    config: TriggerVercelRepoImageBuildConfig
  ): Promise<TriggerVercelRepoImageBuildResult> {
    if (!this.providerConfig.internalCallbackSecret) {
      throw new SandboxProviderError(
        "INTERNAL_CALLBACK_SECRET is required for Vercel repo image builds",
        "permanent"
      );
    }

    try {
      const baseSnapshotId = await this.resolveBaseSnapshotId(config.correlation);
      if (!baseSnapshotId) {
        throw new Error(
          "VERCEL_BASE_SNAPSHOT_ID or VERCEL_BASE_SNAPSHOT_NAME is required to build Vercel repo image snapshots"
        );
      }

      const sandboxName = `build-${config.repoOwner}-${config.repoName}-${Date.now()}`;
      const env = await this.buildBuildEnvVars(config);
      const created = await this.client.createSandbox(
        {
          name: sandboxName,
          runtime: this.providerConfig.runtime || DEFAULT_VERCEL_RUNTIME,
          timeoutMs: BUILD_TIMEOUT_SECONDS * 1000,
          env,
          tags: {
            openinspect_framework: "open-inspect",
            openinspect_kind: "repo-image-build",
            openinspect_build_id: config.buildId,
            openinspect_repo: `${config.repoOwner}/${config.repoName}`,
          },
          sourceSnapshotId: baseSnapshotId,
        },
        config.correlation
      );

      await this.launchBuildCoordinator(
        created.session.id,
        this.buildCoordinatorEnv(config, created.session.id)
      );

      log.info("vercel.repo_image_build_triggered", {
        build_id: config.buildId,
        repo_owner: config.repoOwner,
        repo_name: config.repoName,
        session_id: created.session.id,
        sandbox_name: sandboxName,
      });

      return { buildId: config.buildId, status: "building" };
    } catch (error) {
      if (error instanceof SandboxProviderError) throw error;
      throw this.classifyError("Failed to trigger Vercel repo image build", error);
    }
  }

  async deleteProviderImage(providerImageId: string): Promise<void> {
    try {
      await this.client.deleteSnapshot(providerImageId);
    } catch (error) {
      throw this.classifyError("Failed to delete Vercel snapshot", error);
    }
  }

  private async buildEnvVars(
    config: CreateSandboxConfig | RestoreConfig,
    mode: {
      restoredFromSnapshot?: boolean;
      fromRepoImage?: boolean;
      repoImageSha?: string;
    }
  ): Promise<Record<string, string>> {
    const envVars: Record<string, string> = { ...(config.userEnvVars ?? {}) };
    const sessionConfig: Record<string, unknown> = {
      session_id: config.sessionId,
      repo_owner: config.repoOwner,
      repo_name: config.repoName,
      provider: config.provider,
      model: config.model,
      mcp_servers: config.mcpServers,
    };
    if (config.branch) sessionConfig.branch = config.branch;

    Object.assign(envVars, {
      HOME: "/root",
      NODE_ENV: "development",
      PATH: buildVercelRuntimePath(this.providerConfig.runtime),
      PYTHONPATH: "/app",
      PYTHONUNBUFFERED: "1",
      NODE_PATH: "/usr/lib/node_modules:/usr/local/lib/node_modules",
      SANDBOX_ID: config.sandboxId,
      CONTROL_PLANE_URL: config.controlPlaneUrl,
      SANDBOX_AUTH_TOKEN: config.sandboxAuthToken,
      REPO_OWNER: config.repoOwner,
      REPO_NAME: config.repoName,
      SESSION_CONFIG: JSON.stringify(sessionConfig),
    });

    this.injectScmEnvVars(envVars);

    if (mode.restoredFromSnapshot) envVars.RESTORED_FROM_SNAPSHOT = "true";
    if (mode.fromRepoImage) {
      envVars.FROM_REPO_IMAGE = "true";
      envVars.REPO_IMAGE_SHA = mode.repoImageSha ?? "";
    }
    if (config.codeServerEnabled) {
      envVars.CODE_SERVER_PASSWORD = await this.deriveCodeServerPassword(config.sandboxId);
    }
    if (config.sandboxSettings?.terminalEnabled) {
      envVars.TERMINAL_ENABLED = "true";
    }
    if (config.agentSlackNotifyEnabled) {
      envVars.AGENT_SLACK_NOTIFY_ENABLED = "true";
    }

    const tunnelPorts = collectExposedPorts(
      config.codeServerEnabled,
      config.sandboxSettings
    ).extraTunnelPorts;
    if (tunnelPorts.length > 0) {
      envVars[EXPECTED_TUNNEL_PORTS_ENV_VAR] = tunnelPorts.join(",");
    }

    return envVars;
  }

  private async buildBuildEnvVars(
    config: TriggerVercelRepoImageBuildConfig
  ): Promise<Record<string, string>> {
    const envVars: Record<string, string> = { ...(config.userEnvVars ?? {}) };
    Object.assign(envVars, {
      HOME: "/root",
      NODE_ENV: "development",
      PATH: buildVercelRuntimePath(this.providerConfig.runtime),
      PYTHONPATH: "/app",
      PYTHONUNBUFFERED: "1",
      NODE_PATH: "/usr/lib/node_modules:/usr/local/lib/node_modules",
      SANDBOX_ID: `build-${config.repoOwner}-${config.repoName}`,
      REPO_OWNER: config.repoOwner,
      REPO_NAME: config.repoName,
      IMAGE_BUILD_MODE: "true",
      SESSION_CONFIG: JSON.stringify({ branch: config.defaultBranch }),
    });

    this.injectScmEnvVars(envVars, config.cloneToken);
    return envVars;
  }

  private injectScmEnvVars(envVars: Record<string, string>, cloneToken?: string): void {
    if (this.providerConfig.scmProvider === "gitlab") {
      envVars.VCS_HOST = "gitlab.com";
      envVars.VCS_CLONE_USERNAME = "oauth2";
    } else if (this.providerConfig.scmProvider === "bitbucket") {
      envVars.VCS_HOST = "bitbucket.org";
      envVars.VCS_CLONE_USERNAME = "x-token-auth";
    } else {
      envVars.VCS_HOST = "github.com";
      envVars.VCS_CLONE_USERNAME = "x-access-token";
    }

    if (cloneToken) {
      envVars.VCS_CLONE_TOKEN = cloneToken;
      if (this.providerConfig.scmProvider === "github") {
        const hasUserGithubCliToken = Boolean(
          envVars.GH_TOKEN || envVars.GITHUB_TOKEN || envVars.GITHUB_APP_TOKEN
        );
        if (!hasUserGithubCliToken) {
          envVars.GITHUB_TOKEN = cloneToken;
          envVars.GITHUB_APP_TOKEN = cloneToken;
          envVars.OI_GITHUB_TOKEN_IS_FALLBACK = "1";
        }
      }
    }
  }

  private buildTags(config: CreateSandboxConfig | RestoreConfig): Record<string, string> {
    return {
      openinspect_framework: "open-inspect",
      openinspect_session_id: config.sessionId,
      openinspect_repo: `${config.repoOwner}/${config.repoName}`,
      openinspect_expected_sandbox_id: config.sandboxId,
    };
  }

  private async prepareSandboxAccess(
    created: VercelCreateSandboxResponse,
    logicalSandboxId: string,
    codeServerEnabled: boolean | undefined,
    sandboxSettings: SandboxSettings | undefined,
    correlation?: CreateSandboxConfig["correlation"]
  ): Promise<{
    codeServerUrl?: string;
    codeServerPassword?: string;
    ttydUrl?: string;
    tunnelUrls?: Record<string, string>;
  }> {
    const routeByPort = new Map(created.routes.map((route) => [route.port, route]));
    const { extraTunnelPorts } = collectExposedPorts(codeServerEnabled, sandboxSettings);
    const tunnelUrls: Record<string, string> = {};

    for (const port of extraTunnelPorts) {
      const url = routeToUrl(routeByPort.get(port));
      if (url) tunnelUrls[String(port)] = url;
    }

    if (Object.keys(tunnelUrls).length > 0) {
      await this.writeTunnelEnvFile(created.session.id, tunnelUrls, correlation);
    }

    const codeServerUrl = codeServerEnabled
      ? routeToUrl(routeByPort.get(CODE_SERVER_PORT))
      : undefined;
    const ttydUrl = sandboxSettings?.terminalEnabled
      ? routeToUrl(routeByPort.get(TTYD_PROXY_PORT))
      : undefined;

    return {
      codeServerUrl,
      codeServerPassword: codeServerEnabled
        ? await this.deriveCodeServerPassword(logicalSandboxId)
        : undefined,
      ttydUrl,
      tunnelUrls: Object.keys(tunnelUrls).length > 0 ? tunnelUrls : undefined,
    };
  }

  private async writeTunnelEnvFile(
    sessionId: string,
    tunnelUrls: Record<string, string>,
    correlation?: CreateSandboxConfig["correlation"]
  ): Promise<void> {
    const content =
      Object.entries(tunnelUrls)
        .sort(([a], [b]) => Number(a) - Number(b))
        .map(([port, url]) => `TUNNEL_${port}=${url}`)
        .join("\n") + "\n";

    const script = [
      "from pathlib import Path",
      `Path(${JSON.stringify(TUNNEL_ENV_FILE_PATH)}).write_text(${JSON.stringify(content)})`,
    ].join("\n");

    const result = await this.client.runCommandAndWait(
      {
        sessionId,
        command: "sudo",
        args: ["-E", VERCEL_PYTHON_BIN, "-c", script],
        timeoutMs: VERCEL_TUNNEL_ENV_WRITE_TIMEOUT_MS,
      },
      correlation
    );
    if (result.exitCode !== 0) {
      throw new Error(`Failed to write Vercel tunnel env file (exit_code=${result.exitCode})`);
    }
  }

  private async resolveBaseSnapshotId(
    correlation?: CreateSandboxConfig["correlation"]
  ): Promise<string | undefined> {
    if (this.providerConfig.baseSnapshotId) {
      return this.providerConfig.baseSnapshotId;
    }

    const snapshotName = this.providerConfig.baseSnapshotName;
    if (!snapshotName) {
      return undefined;
    }

    this.baseSnapshotIdPromise ||= this.lookupBaseSnapshotIdByName(snapshotName, correlation);
    try {
      return await this.baseSnapshotIdPromise;
    } catch (error) {
      this.baseSnapshotIdPromise = undefined;
      throw error;
    }
  }

  private async lookupBaseSnapshotIdByName(
    snapshotName: string,
    correlation?: CreateSandboxConfig["correlation"]
  ): Promise<string> {
    const result = await this.client.listSnapshots(
      {
        name: snapshotName,
        limit: 20,
        sortOrder: "desc",
      },
      correlation
    );
    const snapshot = result.snapshots.find((candidate) => candidate.status === "created");
    if (!snapshot) {
      throw new Error(`No created Vercel base snapshot found for sandbox name ${snapshotName}`);
    }

    log.info("vercel.base_snapshot_resolved", {
      snapshot_name: snapshotName,
      snapshot_id: snapshot.id,
      created_at: snapshot.createdAt,
    });
    return snapshot.id;
  }

  private async launchEntrypoint(
    sessionId: string,
    env: Record<string, string>,
    correlation?: CreateSandboxConfig["correlation"]
  ): Promise<void> {
    await this.client.startCommand(
      {
        sessionId,
        command: "sudo",
        args: ["-E", VERCEL_PYTHON_BIN, "-m", "sandbox_runtime.entrypoint"],
        cwd: "/workspace",
        env,
      },
      correlation
    );
  }

  private async launchBuildCoordinator(
    sessionId: string,
    env: Record<string, string>
  ): Promise<void> {
    await this.client.startCommand({
      sessionId,
      command: VERCEL_PYTHON_BIN,
      args: ["-c", buildCoordinatorScript()],
      cwd: "/workspace",
      env,
    });
  }

  private buildCoordinatorEnv(
    config: TriggerVercelRepoImageBuildConfig,
    sessionId: string
  ): Record<string, string> {
    return {
      OI_VERCEL_SESSION_ID: sessionId,
      OI_VERCEL_BUILD_ID: config.buildId,
      OI_VERCEL_CALLBACK_URL: config.callbackUrl,
      OI_INTERNAL_CALLBACK_SECRET: this.providerConfig.internalCallbackSecret ?? "",
      OI_VERCEL_TOKEN: this.providerConfig.token,
      OI_VERCEL_TEAM_ID: this.providerConfig.teamId ?? "",
      OI_VERCEL_API_BASE_URL: this.providerConfig.apiBaseUrl ?? "https://vercel.com/api",
      OI_VERCEL_SNAPSHOT_EXPIRATION_MS: String(
        this.providerConfig.snapshotExpirationMs ?? DEFAULT_SNAPSHOT_EXPIRATION_MS
      ),
    };
  }

  private async deriveCodeServerPassword(sandboxId: string): Promise<string> {
    const digest = await computeHmacHex(
      `code-server:${sandboxId}`,
      this.providerConfig.codeServerPasswordSecret
    );
    return digest.slice(0, 32);
  }

  private classifyError(message: string, error: unknown): SandboxProviderError {
    if (error instanceof VercelSandboxApiError) {
      return SandboxProviderError.fromFetchError(
        `${message}: ${error.message}`,
        error,
        error.status
      );
    }
    return SandboxProviderError.fromFetchError(
      `${message}: ${error instanceof Error ? error.message : String(error)}`,
      error
    );
  }
}

function collectExposedPorts(
  codeServerEnabled: boolean | undefined,
  sandboxSettings: SandboxSettings | undefined
): { allExposedPorts: number[]; extraTunnelPorts: number[] } {
  const reserved = new Set<number>();
  const exposed: number[] = [];

  if (codeServerEnabled) {
    exposed.push(CODE_SERVER_PORT);
    reserved.add(CODE_SERVER_PORT);
  }
  if (sandboxSettings?.terminalEnabled) {
    exposed.push(TTYD_PROXY_PORT);
    reserved.add(TTYD_PROXY_PORT);
  }

  const extraTunnelPorts = resolveTunnelPorts(sandboxSettings?.tunnelPorts).filter(
    (port) => !reserved.has(port)
  );
  exposed.push(...extraTunnelPorts);

  return { allExposedPorts: exposed, extraTunnelPorts };
}

function resolveTunnelPorts(rawPorts: number[] | undefined): number[] {
  if (!rawPorts) return [];
  const ports: number[] = [];
  for (const value of rawPorts) {
    if (Number.isInteger(value) && value >= 1 && value <= 65535) {
      ports.push(value);
    }
    if (ports.length >= MAX_TUNNEL_PORTS) break;
  }
  return ports;
}

function routeToUrl(route: VercelSandboxRoute | undefined): string | undefined {
  if (!route) return undefined;
  if (route.url) return route.url.startsWith("http") ? route.url : `https://${route.url}`;
  return `https://${route.subdomain}.vercel.run`;
}

function buildVercelRuntimePath(runtime?: string): string {
  const resolvedRuntime = runtime || DEFAULT_VERCEL_RUNTIME;
  return `/root/.bun/bin:/usr/local/bin:/usr/bin:/bin:/vercel/runtimes/${resolvedRuntime}/bin`;
}

function buildCoordinatorScript(): string {
  return String.raw`
import hashlib
import hmac
import json
import os
import signal
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request


def read_coordinator_config():
    return {
        "build_id": os.environ.pop("OI_VERCEL_BUILD_ID"),
        "callback_url": os.environ.pop("OI_VERCEL_CALLBACK_URL"),
        "secret": os.environ.pop("OI_INTERNAL_CALLBACK_SECRET"),
        "token": os.environ.pop("OI_VERCEL_TOKEN"),
        "session_id": os.environ.pop("OI_VERCEL_SESSION_ID"),
        "team_id": os.environ.pop("OI_VERCEL_TEAM_ID", ""),
        "api_base": os.environ.pop("OI_VERCEL_API_BASE_URL", "https://vercel.com/api"),
        "snapshot_expiration_ms": os.environ.pop("OI_VERCEL_SNAPSHOT_EXPIRATION_MS", "0"),
    }


def callback(config, path_suffix, payload):
    callback_url = config["callback_url"]
    if path_suffix:
        callback_url = callback_url.replace("/build-complete", path_suffix)
    secret = config["secret"]
    timestamp = str(int(time.time() * 1000))
    signature = hmac.new(secret.encode(), timestamp.encode(), hashlib.sha256).hexdigest()
    body = json.dumps(payload).encode()
    req = urllib.request.Request(
        callback_url,
        data=body,
        method="POST",
        headers={
            "Authorization": f"Bearer {timestamp}.{signature}",
            "Content-Type": "application/json",
        },
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        resp.read()


def snapshot_session(config):
    api_base = config["api_base"].rstrip("/")
    session_id = config["session_id"]
    team_id = config["team_id"]
    token = config["token"]
    expiration = int(config["snapshot_expiration_ms"])
    query = f"?teamId={urllib.parse.quote(team_id)}" if team_id else ""
    body = json.dumps({"expiration": expiration}).encode()
    req = urllib.request.Request(
        f"{api_base}/v2/sandboxes/sessions/{urllib.parse.quote(session_id)}/snapshot{query}",
        data=body,
        method="POST",
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
            "User-Agent": "open-inspect/vercel-build-coordinator",
        },
    )
    with urllib.request.urlopen(req, timeout=600) as resp:
        data = json.loads(resp.read().decode() or "{}")
    return data["snapshot"]["id"]


COORDINATOR_ONLY_ENV_KEYS = {
    "OI_VERCEL_SESSION_ID",
    "OI_VERCEL_BUILD_ID",
    "OI_VERCEL_CALLBACK_URL",
    "OI_INTERNAL_CALLBACK_SECRET",
    "OI_VERCEL_TOKEN",
    "OI_VERCEL_TEAM_ID",
    "OI_VERCEL_API_BASE_URL",
    "OI_VERCEL_SNAPSHOT_EXPIRATION_MS",
}


def read_head_sha():
    repo_name = os.environ.get("REPO_NAME", "")
    if not repo_name:
        return ""
    try:
        return subprocess.check_output(
            ["git", "-C", f"/workspace/{repo_name}", "rev-parse", "HEAD"],
            text=True,
            stderr=subprocess.DEVNULL,
            timeout=10,
        ).strip()
    except Exception:
        return ""


def main():
    started = time.time()
    config = read_coordinator_config()
    build_id = config["build_id"]
    head_sha = ""
    last_error = ""
    build_env = os.environ.copy()
    for key in COORDINATOR_ONLY_ENV_KEYS:
        build_env.pop(key, None)
    proc = subprocess.Popen(
        ["sudo", "-E", "/usr/bin/python3.12", "-m", "sandbox_runtime.entrypoint"],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
        env=build_env,
    )
    try:
        assert proc.stdout is not None
        for line in proc.stdout:
            print(line, end="", flush=True)
            try:
                entry = json.loads(line)
            except Exception:
                continue
            event = entry.get("event")
            if event == "git.sync_complete" and entry.get("head_sha"):
                head_sha = entry["head_sha"]
            elif event in {"setup.failed", "setup.timeout", "setup.error", "supervisor.error", "supervisor.fatal"}:
                last_error = str(entry.get("output_tail") or entry.get("error_message") or entry.get("error") or event)[-500:]
            elif event == "image_build.complete":
                if not head_sha:
                    head_sha = read_head_sha()
                proc.send_signal(signal.SIGTERM)
                try:
                    proc.wait(timeout=20)
                except subprocess.TimeoutExpired:
                    proc.kill()
                    proc.wait(timeout=10)
                snapshot_id = snapshot_session(config)
                callback(config, "", {
                    "build_id": build_id,
                    "provider_image_id": snapshot_id,
                    "base_sha": head_sha,
                    "build_duration_seconds": round(time.time() - started, 3),
                })
                return
        exit_code = proc.wait()
        callback(config, "/build-failed", {
            "build_id": build_id,
            "error": last_error or f"build entrypoint exited before completion (exit_code={exit_code})",
        })
    except Exception as exc:
        try:
            callback(config, "/build-failed", {"build_id": build_id, "error": str(exc)[-500:]})
        finally:
            raise


if __name__ == "__main__":
    main()
`;
}

export function createVercelProvider(
  client: VercelSandboxClient,
  providerConfig: VercelProviderConfig
): VercelSandboxProvider {
  return new VercelSandboxProvider(client, providerConfig);
}
