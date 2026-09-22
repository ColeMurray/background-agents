/** Interactive Modal wire encodings. Resume and image builds are separate contracts. */
import { DEFAULT_MODEL, extractProviderAndModel } from "@open-inspect/shared/models";
import type { CreateSandboxRequest, RestoreSandboxRequest } from "./client";
import { DEFAULT_SANDBOX_TIMEOUT_SECONDS } from "./provider";
import { buildSessionConfig } from "./sandbox-env";
import { resolveServicePorts, resolveTunnelPorts } from "./providers/port-resolution";

export type ModalLaunchContractVersion = "legacy" | "1";

export function parseModalLaunchContractVersion(value?: string): ModalLaunchContractVersion {
  if (!value || value === "legacy") return "legacy";
  if (value === "1") return "1";
  throw new Error("MODAL_LAUNCH_CONTRACT_VERSION must be legacy or 1");
}

type LaunchRequest = CreateSandboxRequest | RestoreSandboxRequest;

const { provider: DEFAULT_MODAL_PROVIDER, model: DEFAULT_MODAL_MODEL } =
  extractProviderAndModel(DEFAULT_MODEL);

function sessionConfig(request: LaunchRequest) {
  return buildSessionConfig({
    ...request,
    provider: request.provider || DEFAULT_MODAL_PROVIDER,
    model: request.model || DEFAULT_MODAL_MODEL,
  });
}

function commonFields(request: LaunchRequest) {
  return {
    sandbox_id: request.sandboxId || null,
    control_plane_url: request.controlPlaneUrl,
    sandbox_auth_token: request.sandboxAuthToken,
    user_env_vars: request.userEnvVars || null,
    timeout_seconds: request.timeoutSeconds || null,
    code_server_enabled: request.codeServerEnabled ?? false,
    vnc_enabled: request.vncEnabled ?? false,
    agent_slack_notify_enabled: request.agentSlackNotifyEnabled ?? false,
    sandbox_settings: request.sandboxSettings ?? null,
  };
}

function versionedFields(request: LaunchRequest) {
  // Never downgrade/retry on receiver errors: creation may already have happened.
  if (!request.sandboxId) throw new Error("A reserved sandbox ID is required for launch v1");
  const config = sessionConfig(request);
  return {
    ...commonFields(request),
    contract_version: 1 as const,
    sandbox_id: request.sandboxId,
    session_config: {
      ...config,
      branch: config.branch ?? null,
      mcp_servers: config.mcp_servers ?? [],
      repositories: config.repositories ?? null,
    },
    user_env_vars: request.userEnvVars ?? {},
    timeout_seconds: request.timeoutSeconds ?? DEFAULT_SANDBOX_TIMEOUT_SECONDS,
    sandbox_settings: {
      ...request.sandboxSettings,
      ...resolveServicePorts(request.sandboxSettings),
      terminalEnabled: request.sandboxSettings?.terminalEnabled ?? false,
      tunnelPorts: resolveTunnelPorts(request.sandboxSettings?.tunnelPorts),
    },
  };
}

export function encodeModalCreate(
  request: CreateSandboxRequest,
  version: ModalLaunchContractVersion
) {
  const source = {
    repo_image_id: request.prebuiltImageId || null,
    repo_image_sha: request.prebuiltImageSha || null,
  };
  if (version === "1") {
    return {
      ...versionedFields(request),
      ...source,
      agent_session_id: request.agentSessionId || null,
    };
  }
  const config = sessionConfig(request);
  return {
    ...commonFields(request),
    ...config,
    ...source,
    agent_session_id: request.agentSessionId || null,
    // Legacy create explicitly sends null where restore omits an optional key.
    branch: request.branch || null,
    mcp_servers: config.mcp_servers || null,
    repositories: config.repositories ?? null,
  };
}

export function encodeModalRestore(
  request: RestoreSandboxRequest,
  version: ModalLaunchContractVersion
) {
  return {
    ...(version === "1"
      ? versionedFields(request)
      : {
          ...commonFields(request),
          sandbox_id: request.sandboxId,
          session_config: buildSessionConfig(request),
        }),
    snapshot_image_id: request.snapshotImageId,
  };
}
