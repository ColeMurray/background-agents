import type { GitPushSpec } from "../types";
import { SourceControlProviderError } from "../errors";

interface BuildTokenGitPushSpecConfig {
  host: string;
  username: string;
  token: string;
  owner: string;
  name: string;
  sourceRef: string;
  targetBranch: string;
  force?: boolean;
}

export function buildTokenGitPushSpec(config: BuildTokenGitPushSpecConfig): GitPushSpec {
  return {
    remoteUrl: `https://${config.username}:${config.token}@${config.host}/${config.owner}/${config.name}.git`,
    redactedRemoteUrl: `https://${config.username}:<redacted>@${config.host}/${config.owner}/${config.name}.git`,
    refspec: `${config.sourceRef}:refs/heads/${config.targetBranch}`,
    targetBranch: config.targetBranch,
    force: config.force ?? false,
  };
}

export function toSourceControlProviderError(
  message: string,
  error: unknown,
  status?: number
): SourceControlProviderError {
  if (error instanceof SourceControlProviderError) {
    return error;
  }

  return SourceControlProviderError.fromFetchError(
    `${message}: ${error instanceof Error ? error.message : String(error)}`,
    error,
    status
  );
}
