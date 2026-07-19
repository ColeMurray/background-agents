import { computeHmacHex, type McpServerConfig } from "@open-inspect/shared";
import type { SourceControlProviderName } from "../source-control";
import type { CreateSandboxConfig, RestoreConfig, SessionRepositoryInfo } from "./provider";
import { resolveServicePorts } from "./providers/port-resolution";

/**
 * Shared assembly for the sandbox environment contract.
 *
 * The runtime decodes the `SESSION_CONFIG` env var into a single canonical
 * shape (see the Python `SessionConfig` in
 * `packages/sandbox-runtime/src/sandbox_runtime/types.py`). Every provider used
 * to hand-roll that object independently, which let fields silently diverge —
 * the Daytona provider dropped `mcp_servers` entirely because its local copy
 * never added the key. This module is the single source of truth for the shape
 * so providers serialize it instead of reassembling ad-hoc objects.
 *
 * The runtime reads `session_id`, `branch`, `provider`, `model`, and
 * `mcp_servers` from this payload; `repo_owner` / `repo_name` are included to
 * mirror the full contract.
 */

/** Snake_case wire twin of {@link SessionRepositoryInfo} (runtime SessionRepositoryConfig). */
export interface SessionRepositoryConfigPayload {
  repo_owner: string;
  repo_name: string;
  branch: string;
  base_sha?: string;
}

/** Canonical `SESSION_CONFIG` payload handed to the sandbox runtime. */
export interface SessionConfigPayload {
  session_id: string;
  repo_owner: string | null;
  repo_name: string | null;
  provider: string;
  model: string;
  /** Omitted from the serialized payload when undefined. */
  mcp_servers?: McpServerConfig[];
  /** Omitted from the serialized payload when undefined. */
  branch?: string | null;
  /** Ordered member list; only present for multi-repo sessions. */
  repositories?: SessionRepositoryConfigPayload[];
}

/** Provider-agnostic inputs needed to assemble a {@link SessionConfigPayload}. */
export interface SessionConfigInput {
  sessionId: string;
  repoOwner: string | null;
  repoName: string | null;
  provider: string;
  model: string;
  mcpServers?: McpServerConfig[];
  branch?: string | null;
  repositories?: SessionRepositoryInfo[];
}

/**
 * Build the canonical `SESSION_CONFIG` payload from provider inputs.
 *
 * `mcp_servers` is always set (left undefined when absent) so `JSON.stringify`
 * omits it — matching how the runtime treats an absent key and an empty list
 * identically. `branch` is only omitted when undefined; null is serialized to
 * explicitly represent a no-repository session.
 */
export function buildSessionConfig(input: SessionConfigInput): SessionConfigPayload {
  const payload: SessionConfigPayload = {
    session_id: input.sessionId,
    repo_owner: input.repoOwner,
    repo_name: input.repoName,
    provider: input.provider,
    model: input.model,
    mcp_servers: input.mcpServers,
  };
  if (input.branch !== undefined) {
    payload.branch = input.branch;
  }
  if (input.repositories?.length) {
    payload.repositories = input.repositories.map(toRepositoryConfigPayload);
  }
  return payload;
}

export function toRepositoryConfigPayload(
  repository: SessionRepositoryInfo
): SessionRepositoryConfigPayload {
  return {
    repo_owner: repository.repoOwner,
    repo_name: repository.repoName,
    branch: repository.baseBranch,
    ...(repository.baseSha ? { base_sha: repository.baseSha } : {}),
  };
}

/** `SESSION_CONFIG` env var carrying the serialized {@link SessionConfigPayload}. */
export const SESSION_CONFIG_ENV_VAR = "SESSION_CONFIG";
/** Build-mode marker checked as `=== "true"` by the runtime entrypoint. */
export const IMAGE_BUILD_MODE_ENV_VAR = "IMAGE_BUILD_MODE";
/** One-shot clone token used only by image-build sandboxes. */
export const VCS_CLONE_TOKEN_ENV_VAR = "VCS_CLONE_TOKEN";

/** Host/username pair git pairs with the brokered clone token in the sandbox. */
export interface ScmCloneIdentity {
  /** `VCS_HOST` — hostname the credential helper and clone URLs target. */
  readonly host: string;
  /** `VCS_CLONE_USERNAME` — username git sends alongside the brokered token. */
  readonly cloneUsername: string;
}

const SCM_CLONE_IDENTITIES: Record<SourceControlProviderName, ScmCloneIdentity> = {
  github: { host: "github.com", cloneUsername: "x-access-token" },
  gitlab: { host: "gitlab.com", cloneUsername: "oauth2" },
  bitbucket: { host: "bitbucket.org", cloneUsername: "x-token-auth" },
};

/** Clone identity for an SCM provider (full github/gitlab/bitbucket mapping). */
export function scmCloneIdentity(scmProvider: SourceControlProviderName): ScmCloneIdentity {
  return SCM_CLONE_IDENTITIES[scmProvider];
}

/** Set `VCS_HOST`/`VCS_CLONE_USERNAME` (and the clone token, when given) on an env map. */
export function applyScmCloneEnv(
  envVars: Record<string, string>,
  identity: ScmCloneIdentity,
  cloneToken?: string
): void {
  envVars.VCS_HOST = identity.host;
  envVars.VCS_CLONE_USERNAME = identity.cloneUsername;
  if (cloneToken) {
    envVars[VCS_CLONE_TOKEN_ENV_VAR] = cloneToken;
  }
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

/** Provider-specific inputs to {@link buildSandboxEnvVars}. */
export interface SandboxEnvVarsOptions {
  /** Resolved clone identity — {@link scmCloneIdentity} of the configured SCM provider. */
  scmIdentity: ScmCloneIdentity;
  /**
   * Precomputed code-server password (derivation is provider-specific and
   * async). Providers derive it only when `codeServerEnabled`.
   */
  codeServerPassword?: string;
  /**
   * Overrides `config.userEnvVars` as the user layer when a provider composes
   * it differently (OpenComputer layers provider LLM credentials underneath
   * user secrets). System vars still overlay whatever is passed here.
   */
  baseEnvVars?: Record<string, string>;
}

/**
 * Build the per-session env map delivered to the sandbox runtime — the one
 * canonical assembly shared by the REST-style providers (Daytona, E2B,
 * OpenComputer, Vercel), which used to hand-roll near-identical copies.
 *
 * User env vars (repo secrets) come first, system vars are overlaid so they
 * can't be shadowed. Provider-specific additions (platform paths, image-mode
 * markers, cache-dir overrides) are applied by the caller after this returns;
 * they must not collide with the system keys set here.
 */
export function buildSandboxEnvVars(
  config: CreateSandboxConfig | RestoreConfig,
  options: SandboxEnvVarsOptions
): Record<string, string> {
  const envVars: Record<string, string> = { ...(options.baseEnvVars ?? config.userEnvVars ?? {}) };

  const sessionConfig = buildSessionConfig(config);

  Object.assign(envVars, {
    PYTHONUNBUFFERED: "1",
    SANDBOX_ID: config.sandboxId,
    CONTROL_PLANE_URL: config.controlPlaneUrl,
    SANDBOX_AUTH_TOKEN: config.sandboxAuthToken,
    REPO_OWNER: config.repoOwner ?? "",
    REPO_NAME: config.repoName ?? "",
    [SESSION_CONFIG_ENV_VAR]: JSON.stringify(sessionConfig),
  });

  if (config.codeServerEnabled) {
    envVars.CODE_SERVER_PORT = String(resolveServicePorts(config.sandboxSettings).codeServerPort);
  }

  if (options.codeServerPassword) {
    envVars.CODE_SERVER_PASSWORD = options.codeServerPassword;
  }

  if (config.agentSlackNotifyEnabled) {
    envVars.AGENT_SLACK_NOTIFY_ENABLED = "true";
  }

  applyScmCloneEnv(envVars, options.scmIdentity);

  // Note: this builder never sets VCS_CLONE_TOKEN / GITHUB_TOKEN /
  // GITHUB_APP_TOKEN as system vars. Git operations in the sandbox
  // authenticate per-request via the system git credential helper, which hits
  // /sessions/:id/scm-credentials. Embedding a system token in env would
  // silently fail once the token expires (immediately so, for GitHub App
  // installation tokens) — exactly the failure that broke long-running and
  // resumed sessions before brokered credentials landed. User-defined secrets
  // are passed through verbatim, though, so a user-supplied VCS_CLONE_TOKEN
  // survives — OpenComputer deliberately preserves one on prebuilt-image
  // boots (see its provider tests).

  return envVars;
}
