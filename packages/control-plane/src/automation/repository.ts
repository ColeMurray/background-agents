import type { AutomationRow } from "../db/automation-store";
import type { Env } from "../types";
import { createSourceControlProviderFromEnv, type SourceControlProvider } from "../source-control";

export interface AutomationRepository {
  repoOwner: string;
  repoName: string;
  repoId: number | null;
  baseBranch: string;
}

export async function resolveAutomationRepository(
  env: Env,
  automation: AutomationRow,
  sourceControlProvider?: SourceControlProvider
): Promise<AutomationRepository | null> {
  const repoOwner = automation.repo_owner?.trim() || null;
  const repoName = automation.repo_name?.trim() || null;

  if ((repoOwner === null) !== (repoName === null)) {
    throw new Error("Automation repository must include repo_owner and repo_name together");
  }

  if (repoOwner === null || repoName === null) {
    return null;
  }

  const provider = sourceControlProvider ?? createSourceControlProviderFromEnv(env);

  const access = await provider.checkRepositoryAccess({
    owner: repoOwner,
    name: repoName,
  });

  if (!access) {
    throw new Error("Repository is not accessible for the configured SCM provider");
  }

  return {
    repoOwner: access.repoOwner,
    repoName: access.repoName,
    repoId: access.repoId,
    baseBranch: automation.base_branch?.trim() || access.defaultBranch || "main",
  };
}
