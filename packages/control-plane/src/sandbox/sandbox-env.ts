import type { McpServerConfig } from "@open-inspect/shared/types/integrations";
import { computeHmacHex } from "@open-inspect/shared/auth";
import type { SourceControlProviderName } from "../source-control";
import {
  DEFAULT_SANDBOX_TIMEOUT_SECONDS,
  type CreateSandboxConfig,
  type ImageBuildProviderTriggerConfig,
  type RestoreConfig,
  type SessionRepositoryInfo,
} from "./provider";
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
const SESSION_CONFIG_ENV_VAR = "SESSION_CONFIG";
/** Build-mode marker checked as `=== "true"` by the runtime entrypoint. */
export const IMAGE_BUILD_MODE_ENV_VAR = "IMAGE_BUILD_MODE";
export const IMAGE_BUILD_EXECUTION_TIMEOUT_ENV_KEY = "OI_IMAGE_BUILD_EXECUTION_TIMEOUT_SECONDS";

/**
 * Env vars of the image-build callback contract, keyed by semantic name and
 * mirrored from the runtime constants in
 * `sandbox_runtime/repo_image_callback.py`. Both language sides are pinned by
 * value to the shared manifest
 * `packages/sandbox-runtime/src/sandbox_runtime/image_build_callback_env.json`
 * (TS: `sandbox-env.test.ts`; Python:
 * `packages/modal-infra/tests/test_build_sandbox_lifecycle.py`).
 */
export const REPO_IMAGE_CALLBACK_ENV = {
  buildId: "OI_REPO_IMAGE_BUILD_ID",
  callbackUrl: "OI_REPO_IMAGE_CALLBACK_URL",
  failureCallbackUrl: "OI_REPO_IMAGE_FAILURE_CALLBACK_URL",
  token: "OI_REPO_IMAGE_CALLBACK_TOKEN",
  providerSessionId: "OI_REPO_IMAGE_PROVIDER_SESSION_ID",
} as const;

/** Values of the image-build callback contract, delivered as env vars. */
export interface ImageBuildCallbackEnvValues {
  buildId: string;
  callbackUrl: string;
  failureCallbackUrl: string;
  token: string;
  /**
   * Omitted from the returned map when absent: OpenComputer bakes the
   * callback env at create time, before the provider session id exists, and
   * delivers the id separately at runtime start.
   */
  providerSessionId?: string;
}

/**
 * Assemble the callback-contract env map from semantic values, so provider
 * call sites never pair names with values by hand (or by list position).
 */
export function buildImageBuildCallbackEnv(
  values: ImageBuildCallbackEnvValues
): Record<string, string> {
  const envVars: Record<string, string> = {
    [REPO_IMAGE_CALLBACK_ENV.buildId]: values.buildId,
    [REPO_IMAGE_CALLBACK_ENV.callbackUrl]: values.callbackUrl,
    [REPO_IMAGE_CALLBACK_ENV.failureCallbackUrl]: values.failureCallbackUrl,
    [REPO_IMAGE_CALLBACK_ENV.token]: values.token,
  };
  if (values.providerSessionId !== undefined) {
    envVars[REPO_IMAGE_CALLBACK_ENV.providerSessionId] = values.providerSessionId;
  }
  return envVars;
}

/**
 * Keys scrubbed from user env vars before a build sandbox launches, so a
 * user-defined secret can never hijack the build callback contract. Includes
 * the legacy `OI_REPO_IMAGE_CALLBACK_SECRET` from the pre-token contract —
 * still reserved so stale user secrets can't reintroduce it.
 */
export const RESERVED_REPO_IMAGE_CALLBACK_ENV_KEYS: readonly string[] = [
  ...Object.values(REPO_IMAGE_CALLBACK_ENV),
  "OI_REPO_IMAGE_CALLBACK_SECRET",
  IMAGE_BUILD_EXECUTION_TIMEOUT_ENV_KEY,
];
/** One-shot clone token used only by image-build sandboxes. */
export const VCS_CLONE_TOKEN_ENV_VAR = "VCS_CLONE_TOKEN";

/** Host/username pair git pairs with the brokered clone token in the sandbox. */
export interface ScmCloneIdentity {
  /** `VCS_HOST` — hostname the credential helper and clone URLs target. */
  readonly host: string;
  /** `VCS_CLONE_USERNAME` — username git sends alongside the brokered token. */
  readonly cloneUsername: string;
  /** Hosts an SCM credential secret may be released to (clone host + API host). */
  readonly secretHosts: readonly string[];
}

const SCM_CLONE_IDENTITIES: Record<SourceControlProviderName, ScmCloneIdentity> = {
  github: {
    host: "github.com",
    cloneUsername: "x-access-token",
    secretHosts: ["github.com", "api.github.com"],
  },
  gitlab: {
    host: "gitlab.com",
    cloneUsername: "oauth2",
    secretHosts: ["gitlab.com", "api.gitlab.com"],
  },
  bitbucket: {
    host: "bitbucket.org",
    cloneUsername: "x-token-auth",
    secretHosts: ["bitbucket.org", "api.bitbucket.org"],
  },
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

/** Derive a deterministic VNC password in a domain distinct from code-server. */
export async function deriveVncPassword(sandboxId: string, secret: string): Promise<string> {
  const digest = await computeHmacHex(`vnc:${sandboxId}`, secret);
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  return Array.from({ length: 8 }, (_, index) => {
    const byte = Number.parseInt(digest.slice(index * 2, index * 2 + 2), 16);
    return alphabet[byte % alphabet.length];
  }).join("");
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
  /** Precomputed VNC password, present only when VNC is enabled. */
  vncPassword?: string;
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
  delete envVars.VNC_PASSWORD;
  delete envVars.NOVNC_PORT;

  const sessionConfig = buildSessionConfig(config);

  Object.assign(envVars, {
    PYTHONUNBUFFERED: "1",
    SANDBOX_ID: config.sandboxId,
    CONTROL_PLANE_URL: config.controlPlaneUrl,
    SANDBOX_AUTH_TOKEN: config.sandboxAuthToken,
    SANDBOX_TIMEOUT_SECONDS: String(config.timeoutSeconds ?? DEFAULT_SANDBOX_TIMEOUT_SECONDS),
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

  if (config.vncEnabled && options.vncPassword) {
    envVars.VNC_PASSWORD = options.vncPassword;
    envVars.NOVNC_PORT = String(resolveServicePorts(config.sandboxSettings).vncPort);
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

/**
 * Naming and provider-object labels shared by the image-build trigger paths.
 * `sandboxId` is the stable logical id the runtime sees as `SANDBOX_ID`;
 * `sandboxName` is the per-attempt provider-object name — pass the trigger
 * timestamp (`Date.now()`) as `now` so the impure input is visible at the
 * call site and one config yields one name per trigger attempt;
 * `labels` are the canonical build identity shared by providers (tags on
 * Vercel, labels on OpenComputer). Providers with extra or legacy label
 * conventions spread and extend `labels`.
 *
 * The `build-env-` prefix is deliberately scope-agnostic legacy: it predates
 * scoped builds and is kept verbatim so repo-scoped builds keep the same
 * `SANDBOX_ID`/name shape operators already query for.
 */
export function imageBuildSandboxIdentity(config: ImageBuildProviderTriggerConfig, now: number) {
  return {
    sandboxId: `build-env-${config.scopeId}`,
    sandboxName: `build-env-${config.scopeId}-${now}`,
    labels: {
      openinspect_framework: "open-inspect",
      openinspect_kind: "environment-image-build",
      openinspect_build_id: config.buildId,
      // Canonical scope labels, mirroring Modal's Python tags in
      // packages/modal-infra/src/sandbox/build_session.py.
      openinspect_scope_kind: config.scopeKind,
      openinspect_scope_id: config.scopeId,
    },
  };
}

/** Provider-specific inputs to {@link buildImageBuildEnvVars}. */
export interface ImageBuildEnvVarsOptions {
  /** Logical sandbox id (`build-env-<scopeId>`), surfaced as `SANDBOX_ID`. */
  sandboxId: string;
  /** Repositories in position order ([0] = primary), cloned at their base branches. */
  repositories: SessionRepositoryInfo[];
  /** Resolved clone identity — {@link scmCloneIdentity} of the configured SCM provider. */
  scmIdentity: ScmCloneIdentity;
  /** One-shot clone token delivered as `VCS_CLONE_TOKEN`. */
  cloneToken?: string;
  /**
   * User env vars (repo secrets), or a provider-composed base layer
   * (OpenComputer layers provider LLM credentials underneath user secrets).
   * Reserved image-build keys are scrubbed from this layer so user-defined
   * secrets can never hijack the build callback contract.
   */
  baseEnvVars?: Record<string, string>;
}

/**
 * Build the env map for an image-build sandbox — the build-mode sibling of
 * {@link buildSandboxEnvVars}, shared by the Vercel and OpenComputer
 * providers (which used to hand-roll byte-identical copies) and mirrored by
 * Modal's Python `ModalBuildSessionService.create` in
 * `packages/modal-infra/src/sandbox/build_session.py`.
 *
 * Build sandboxes never receive the session-auth system vars: the runtime
 * boots in image-build mode (`IMAGE_BUILD_MODE=true`) and reports back over
 * the callback contract instead. Provider-specific additions (platform
 * paths, callback env timing) are layered on by the caller after this
 * returns.
 */
export function buildImageBuildEnvVars(options: ImageBuildEnvVarsOptions): Record<string, string> {
  const primary = options.repositories[0];
  if (!primary) {
    throw new Error("image build requires at least one repository");
  }

  const envVars: Record<string, string> = { ...(options.baseEnvVars ?? {}) };
  for (const key of RESERVED_REPO_IMAGE_CALLBACK_ENV_KEYS) {
    delete envVars[key];
  }

  Object.assign(envVars, {
    PYTHONUNBUFFERED: "1",
    SANDBOX_ID: options.sandboxId,
    REPO_OWNER: primary.repoOwner,
    REPO_NAME: primary.repoName,
    [IMAGE_BUILD_MODE_ENV_VAR]: "true",
    [SESSION_CONFIG_ENV_VAR]: JSON.stringify({
      branch: primary.baseBranch,
      repositories: options.repositories.map(toRepositoryConfigPayload),
    }),
  });

  applyScmCloneEnv(envVars, options.scmIdentity, options.cloneToken);
  return envVars;
}
