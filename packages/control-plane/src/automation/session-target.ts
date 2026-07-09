import type { RepositoryRef } from "@open-inspect/shared";
import type { AutomationRunRow } from "../db/automation-store";
import type { Env } from "../types";
import type { Logger } from "../logger";
import type { RequestContext } from "../routes/shared";
import { EnvironmentStore } from "../db/environments";
import { resolveEnvironmentTarget, resolveSessionRepositories } from "../repos/resolve";

/**
 * The repository fields of a run's SessionInitInput, ready to spread into the
 * init input. Scalar fields mirror `repositories[0]` when the list is present
 * (the row-0-mirrors-scalars invariant initializeSession asserts).
 */
export interface AutomationSessionTarget {
  repoOwner: string | null;
  repoName: string | null;
  repoId: number | null;
  defaultBranch: string | null;
  repositories?: RepositoryRef[];
  environmentId: string | null;
}

/**
 * Resolve what an automation run's session opens (design §13.3) — the
 * session-creation counterpart of ./repository's firing-time resolution:
 *
 * - Environment run (run.environment_id set): that environment's full
 *   workspace, resolved here so the session snapshots the member list (§7.6),
 *   exactly like the session-create route. Throws HttpError when the
 *   environment is gone or a member fails to resolve — the caller's
 *   launch-failure path owns it.
 * - Otherwise: the run's firing-time repository snapshot (null fields for
 *   repo-less runs); the automation's live selection may already have been
 *   edited past it.
 */
export async function resolveAutomationSessionTarget(
  env: Env,
  run: AutomationRunRow,
  ctx: RequestContext,
  log: Logger
): Promise<AutomationSessionTarget> {
  if (run.environment_id) {
    const environmentInputs = await resolveEnvironmentTarget(
      new EnvironmentStore(env.DB),
      run.environment_id
    );
    const repositories = await resolveSessionRepositories(env, environmentInputs, ctx, log);
    const primary = repositories[0];
    return {
      repoOwner: primary.repoOwner,
      repoName: primary.repoName,
      repoId: primary.repoId,
      defaultBranch: primary.baseBranch,
      repositories,
      environmentId: run.environment_id,
    };
  }

  return {
    repoOwner: run.repo_owner,
    repoName: run.repo_name,
    repoId: run.repo_id,
    defaultBranch: run.base_branch,
    environmentId: null,
  };
}
