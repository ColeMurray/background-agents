import type { AutomationRow } from "../db/automation-store";
import type { Env } from "../types";
import { createSourceControlProviderFromEnv, type SourceControlProvider } from "../source-control";

export async function resolveAutomationTarget(
  env: Env,
  automation: AutomationRow,
  sourceControlProvider?: SourceControlProvider
): Promise<{
  repoOwner: string | null;
  repoName: string | null;
  repoId: number | null;
  baseBranch: string | null;
}> {
  const mode = automation.target_mode ?? "fixed_single_repo";

  if (mode === "no_repository") {
    return { repoOwner: null, repoName: null, repoId: null, baseBranch: null };
  }

  if (mode !== "fixed_single_repo") {
    throw new Error(`Unsupported automation target mode: ${mode}`);
  }

  if (!automation.repo_owner || !automation.repo_name) {
    throw new Error("Fixed repository automation is missing repository");
  }

  const provider = sourceControlProvider ?? createSourceControlProviderFromEnv(env);

  const access = await provider.checkRepositoryAccess({
    owner: automation.repo_owner,
    name: automation.repo_name,
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
