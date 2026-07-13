/**
 * Helpers for the E2B REST-based sandbox provider.
 *
 * The env map is the in-sandbox supervisor's integration contract, kept here
 * so the wire format stays in one place rather than inlined into the provider.
 */

import { computeHmacHex } from "@open-inspect/shared";
import type { SourceControlProviderName } from "../../source-control";
import { buildSessionConfig } from "../sandbox-env";
import type { CreateSandboxConfig } from "../provider";
import { resolveServicePorts } from "./port-resolution";

/**
 * Build the per-session env map delivered to the sandbox supervisor.
 *
 * User env vars (repo secrets) first, system vars overlaid so they can't be
 * shadowed.
 */
export function buildSandboxEnvVars(
  config: CreateSandboxConfig,
  opts: {
    scmProvider: SourceControlProviderName;
    /** Precomputed via deriveCodeServerPassword when codeServerEnabled. */
    codeServerPassword?: string;
  }
): Record<string, string> {
  const envVars: Record<string, string> = { ...(config.userEnvVars ?? {}) };

  // Canonical SESSION_CONFIG shared with every provider (sandbox-env.ts) so the
  // wire shape can't silently drift — this carries mcp_servers and the
  // multi-repo `repositories[]` list that a hand-rolled object used to drop.
  const sessionConfig = buildSessionConfig({
    sessionId: config.sessionId,
    repoOwner: config.repoOwner,
    repoName: config.repoName,
    provider: config.provider,
    model: config.model,
    mcpServers: config.mcpServers,
    branch: config.branch,
    repositories: config.repositories,
  });

  Object.assign(envVars, {
    PYTHONUNBUFFERED: "1",
    SANDBOX_ID: config.sandboxId,
    CONTROL_PLANE_URL: config.controlPlaneUrl,
    SANDBOX_AUTH_TOKEN: config.sandboxAuthToken,
    REPO_OWNER: config.repoOwner ?? "",
    REPO_NAME: config.repoName ?? "",
    SESSION_CONFIG: JSON.stringify(sessionConfig),
    // E2B sandboxes run as a non-root user and /run is a root-owned tmpfs, so
    // the git credential helper can't create its default cache dir (/run/oi)
    // and fails before brokering a token. Point it at a user-writable path.
    OI_SCM_CRED_CACHE_DIR: "/tmp/oi",
  });

  if (config.codeServerEnabled) {
    envVars.CODE_SERVER_PORT = String(resolveServicePorts(config.sandboxSettings).codeServerPort);
  }

  if (opts.codeServerPassword) {
    envVars.CODE_SERVER_PASSWORD = opts.codeServerPassword;
  }

  if (config.agentSlackNotifyEnabled) {
    envVars.AGENT_SLACK_NOTIFY_ENABLED = "true";
  }

  if (opts.scmProvider === "gitlab") {
    envVars.VCS_HOST = "gitlab.com";
    envVars.VCS_CLONE_USERNAME = "oauth2";
  } else {
    envVars.VCS_HOST = "github.com";
    envVars.VCS_CLONE_USERNAME = "x-access-token";
  }

  // Note: no VCS_CLONE_TOKEN / GITHUB_TOKEN / GITHUB_APP_TOKEN. Git operations
  // in the sandbox authenticate per-request via the system git credential
  // helper, which hits /sessions/:id/scm-credentials. Embedding a token in env
  // would silently fail once the token expires (immediately so, for GitHub App
  // installation tokens) — exactly the failure that broke long-running and
  // resumed sessions before brokered credentials landed.

  return envVars;
}

/**
 * Derive the code-server password for a sandbox (ported from auth.py
 * derive_code_server_password). Must match what code-server inside the
 * sandbox checks — change here and in the runtime in lockstep.
 */
export async function deriveCodeServerPassword(sandboxId: string, secret: string): Promise<string> {
  const digest = await computeHmacHex(`code-server:${sandboxId}`, secret);
  return digest.slice(0, 32);
}
