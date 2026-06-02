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

const log = createLogger("vercel-provider");

const CODE_SERVER_PORT = 8080;
const TTYD_PROXY_PORT = 7680;
const TUNNEL_ENV_FILE_PATH = "/workspace/.tunnels.env";
const EXPECTED_TUNNEL_PORTS_ENV_VAR = "EXPECTED_TUNNEL_PORTS";
const VERCEL_PYTHON_BIN = "/usr/bin/python3.12";
const DEFAULT_RUNTIME = "node24";
const DEFAULT_RUNTIME_REPO_URL = "https://github.com/ColeMurray/background-agents.git";
const DEFAULT_RUNTIME_REPO_REF = "main";
const DEFAULT_SNAPSHOT_EXPIRATION_MS = 0;
const BUILD_TIMEOUT_SECONDS = 1800;

export interface VercelProviderConfig {
  scmProvider: SourceControlProviderName;
  runtimeRepoUrl?: string;
  runtimeRepoRef?: string;
  baseSnapshotId?: string;
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
      const sourceSnapshotId = config.repoImageId || this.providerConfig.baseSnapshotId;

      const created = await this.client.createSandbox(
        {
          name: config.sandboxId,
          runtime: this.providerConfig.runtime || DEFAULT_RUNTIME,
          timeoutMs: (config.timeoutSeconds ?? DEFAULT_SANDBOX_TIMEOUT_SECONDS) * 1000,
          ports,
          env,
          tags: this.buildTags(config),
          sourceSnapshotId: sourceSnapshotId || undefined,
        },
        config.correlation
      );

      if (!sourceSnapshotId) {
        await this.bootstrapRuntime(created.session.id, config.correlation);
      }

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
          runtime: this.providerConfig.runtime || DEFAULT_RUNTIME,
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
      const sandboxName = `build-${config.repoOwner}-${config.repoName}-${Date.now()}`;
      const env = await this.buildBuildEnvVars(config);
      const created = await this.client.createSandbox(
        {
          name: sandboxName,
          runtime: this.providerConfig.runtime || DEFAULT_RUNTIME,
          timeoutMs: BUILD_TIMEOUT_SECONDS * 1000,
          env,
          tags: {
            openinspect_framework: "open-inspect",
            openinspect_kind: "repo-image-build",
            openinspect_build_id: config.buildId,
            openinspect_repo: `${config.repoOwner}/${config.repoName}`,
          },
          sourceSnapshotId: this.providerConfig.baseSnapshotId,
        },
        config.correlation
      );

      if (!this.providerConfig.baseSnapshotId) {
        await this.bootstrapRuntime(created.session.id, config.correlation);
      }

      await this.launchBuildCoordinator(created.session.id, {
        OI_VERCEL_SESSION_ID: created.session.id,
      });

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
      PATH: "/root/.bun/bin:/usr/local/bin:/usr/bin:/bin:/vercel/runtimes/node24/bin",
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
      PATH: "/root/.bun/bin:/usr/local/bin:/usr/bin:/bin:/vercel/runtimes/node24/bin",
      PYTHONPATH: "/app",
      PYTHONUNBUFFERED: "1",
      NODE_PATH: "/usr/lib/node_modules:/usr/local/lib/node_modules",
      SANDBOX_ID: `build-${config.repoOwner}-${config.repoName}`,
      REPO_OWNER: config.repoOwner,
      REPO_NAME: config.repoName,
      IMAGE_BUILD_MODE: "true",
      SESSION_CONFIG: JSON.stringify({ branch: config.defaultBranch }),
      OI_VERCEL_BUILD_ID: config.buildId,
      OI_VERCEL_CALLBACK_URL: config.callbackUrl,
      OI_INTERNAL_CALLBACK_SECRET: this.providerConfig.internalCallbackSecret ?? "",
      OI_VERCEL_TOKEN: this.providerConfig.token,
      OI_VERCEL_TEAM_ID: this.providerConfig.teamId ?? "",
      OI_VERCEL_API_BASE_URL: this.providerConfig.apiBaseUrl ?? "https://vercel.com/api",
      OI_VERCEL_SNAPSHOT_EXPIRATION_MS: String(
        this.providerConfig.snapshotExpirationMs ?? DEFAULT_SNAPSHOT_EXPIRATION_MS
      ),
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

    await this.client.runCommandAndWait(
      {
        sessionId,
        command: "sudo",
        args: ["-E", VERCEL_PYTHON_BIN, "-c", script],
        timeoutMs: 30_000,
      },
      correlation
    );
  }

  private async bootstrapRuntime(
    sessionId: string,
    correlation?: CreateSandboxConfig["correlation"]
  ): Promise<void> {
    const script = buildBootstrapScript({
      runtimeRepoUrl: this.providerConfig.runtimeRepoUrl || DEFAULT_RUNTIME_REPO_URL,
      runtimeRepoRef: this.providerConfig.runtimeRepoRef || DEFAULT_RUNTIME_REPO_REF,
    });
    const result = await this.client.runCommandAndWait(
      {
        sessionId,
        command: "bash",
        args: ["-lc", script],
        timeoutMs: 20 * 60 * 1000,
      },
      correlation
    );
    if (result.exitCode !== 0) {
      throw new Error(`Vercel runtime bootstrap failed with exit code ${result.exitCode}`);
    }
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

function buildBootstrapScript(params: { runtimeRepoUrl: string; runtimeRepoRef: string }): string {
  return `
set -euo pipefail

RUNTIME_REPO_URL=${shellQuote(params.runtimeRepoUrl)}
RUNTIME_REPO_REF=${shellQuote(params.runtimeRepoRef)}
OPENCODE_VERSION="1.14.41"
CODE_SERVER_VERSION="4.109.5"
AGENT_BROWSER_VERSION="0.21.2"
TTYD_VERSION="1.7.7"
TTYD_SHA256="8a217c968aba172e0dbf3f34447218dc015bc4d5e59bf51db2f2cd12b7be4f55"

sudo mkdir -p /workspace /app /app/plugins /app/opencode-deps /tmp/opencode /root

sudo dnf install -y dnf-plugins-core git gcc gcc-c++ make ca-certificates openssh-clients jq unzip tar gzip python3.12 python3.12-pip python3.12-devel
sudo dnf install -y libX11 libXcomposite libXdamage libXext libXfixes libXrandr libxcb libxkbcommon libdrm mesa-libgbm alsa-lib atk at-spi2-atk cups-libs pango cairo nspr nss || true
sudo dnf install -y ffmpeg || true
if ! command -v gh >/dev/null 2>&1; then
  sudo dnf config-manager --add-repo https://cli.github.com/packages/rpm/gh-cli.repo || true
  sudo dnf install -y gh || true
fi

sudo ln -sf ${VERCEL_PYTHON_BIN} /usr/local/bin/python3
sudo ln -sf ${VERCEL_PYTHON_BIN} /usr/local/bin/python
if ! ${VERCEL_PYTHON_BIN} -m pip --version >/dev/null 2>&1; then
  sudo ${VERCEL_PYTHON_BIN} -m ensurepip --upgrade
fi
sudo ${VERCEL_PYTHON_BIN} -m pip install --break-system-packages uv httpx websockets 'pydantic>=2.0' 'PyJWT[crypto]' || sudo ${VERCEL_PYTHON_BIN} -m pip install uv httpx websockets 'pydantic>=2.0' 'PyJWT[crypto]'

sudo npm install -g pnpm@latest opencode-ai@"$OPENCODE_VERSION" @opencode-ai/plugin@"$OPENCODE_VERSION" zod agent-browser@"$AGENT_BROWSER_VERSION"
if [ ! -x /root/.bun/bin/bun ]; then
  curl -fsSL https://bun.sh/install | sudo -E bash || true
fi
sudo env PATH="/root/.bun/bin:$PATH" agent-browser install || true

if ! command -v code-server >/dev/null 2>&1; then
  curl -fsSL https://code-server.dev/install.sh | sudo sh -s -- --version "$CODE_SERVER_VERSION" || true
fi
if ! command -v ttyd >/dev/null 2>&1; then
  curl -fsSL -o /tmp/ttyd "https://github.com/tsl0922/ttyd/releases/download/$TTYD_VERSION/ttyd.x86_64"
  echo "$TTYD_SHA256  /tmp/ttyd" | sha256sum -c -
  sudo mv /tmp/ttyd /usr/local/bin/ttyd
  sudo chmod 0755 /usr/local/bin/ttyd
fi

rm -rf /tmp/open-inspect-runtime
git clone --depth 1 "$RUNTIME_REPO_URL" /tmp/open-inspect-runtime
cd /tmp/open-inspect-runtime
git fetch --depth 1 origin "$RUNTIME_REPO_REF" || true
git checkout --detach FETCH_HEAD 2>/dev/null || git checkout "$RUNTIME_REPO_REF"

sudo rm -rf /app/sandbox_runtime
sudo cp -a packages/sandbox-runtime/src/sandbox_runtime /app/sandbox_runtime
sudo chmod -R a+rX /app/sandbox_runtime
sudo ${VERCEL_PYTHON_BIN} -m pip install --break-system-packages -e packages/sandbox-runtime || sudo ${VERCEL_PYTHON_BIN} -m pip install -e packages/sandbox-runtime

printf '%s\\n' '#!/bin/sh' 'exec ${VERCEL_PYTHON_BIN} -m sandbox_runtime.credentials.git_credential_helper "$@"' | sudo tee /usr/local/bin/oi-git-credentials >/dev/null
sudo chmod 0755 /usr/local/bin/oi-git-credentials
sudo git config --system credential.helper /usr/local/bin/oi-git-credentials || true
sudo git config --system credential.useHttpPath true || true

cat > /tmp/opencode-deps-package.json <<EOF
{"name":"opencode-tools","type":"module","dependencies":{"@opencode-ai/plugin":"$OPENCODE_VERSION"}}
EOF
sudo mv /tmp/opencode-deps-package.json /app/opencode-deps/package.json
cd /app/opencode-deps
sudo npm install --ignore-scripts --no-audit --no-fund
`;
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


def callback(path_suffix, payload):
    callback_url = os.environ["OI_VERCEL_CALLBACK_URL"]
    if path_suffix:
        callback_url = callback_url.replace("/build-complete", path_suffix)
    secret = os.environ["OI_INTERNAL_CALLBACK_SECRET"]
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


def snapshot_session():
    api_base = os.environ.get("OI_VERCEL_API_BASE_URL", "https://vercel.com/api").rstrip("/")
    session_id = os.environ["OI_VERCEL_SESSION_ID"]
    team_id = os.environ.get("OI_VERCEL_TEAM_ID", "")
    token = os.environ["OI_VERCEL_TOKEN"]
    expiration = int(os.environ.get("OI_VERCEL_SNAPSHOT_EXPIRATION_MS", "0"))
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
    build_id = os.environ["OI_VERCEL_BUILD_ID"]
    head_sha = ""
    last_error = ""
    proc = subprocess.Popen(
        ["sudo", "-E", "/usr/bin/python3.12", "-m", "sandbox_runtime.entrypoint"],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
        env=os.environ.copy(),
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
                snapshot_id = snapshot_session()
                callback("", {
                    "build_id": build_id,
                    "provider_image_id": snapshot_id,
                    "base_sha": head_sha,
                    "build_duration_seconds": round(time.time() - started, 3),
                })
                return
        exit_code = proc.wait()
        callback("/build-failed", {
            "build_id": build_id,
            "error": last_error or f"build entrypoint exited before completion (exit_code={exit_code})",
        })
    except Exception as exc:
        try:
            callback("/build-failed", {"build_id": build_id, "error": str(exc)[-500:]})
        finally:
            raise


if __name__ == "__main__":
    main()
`;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function createVercelProvider(
  client: VercelSandboxClient,
  providerConfig: VercelProviderConfig
): VercelSandboxProvider {
  return new VercelSandboxProvider(client, providerConfig);
}
