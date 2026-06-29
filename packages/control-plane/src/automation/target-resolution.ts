import type { AutomationRow } from "../db/automation-store";
import type { Env } from "../types";
import { createSourceControlProviderFromEnv, type SourceControlProvider } from "../source-control";

export interface AutomationSessionLaunch {
  repoOwner: string | null;
  repoName: string | null;
  repoId: number | null;
  baseBranch: string | null;
}

export type AutomationSessionLaunches = [AutomationSessionLaunch, ...AutomationSessionLaunch[]];

export async function resolveAutomationSessionLaunches(
  env: Env,
  automation: AutomationRow,
  sourceControlProvider?: SourceControlProvider
): Promise<AutomationSessionLaunches> {
  const repoOwner = automation.repo_owner?.trim() || null;
  const repoName = automation.repo_name?.trim() || null;

  if ((repoOwner === null) !== (repoName === null)) {
    throw new Error("Automation repository target must include repo_owner and repo_name together");
  }

  if (repoOwner === null || repoName === null) {
    return [{ repoOwner: null, repoName: null, repoId: null, baseBranch: null }];
  }

  const provider = sourceControlProvider ?? createSourceControlProviderFromEnv(env);

  const access = await provider.checkRepositoryAccess({
    owner: repoOwner,
    name: repoName,
  });

  if (!access) {
    throw new Error("Repository is not accessible for the configured SCM provider");
  }

  return [
    {
      repoOwner: access.repoOwner,
      repoName: access.repoName,
      repoId: access.repoId,
      baseBranch: automation.base_branch?.trim() || access.defaultBranch || "main",
    },
  ];
}
