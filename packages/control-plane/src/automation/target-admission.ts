import type { AutomationRow, AutomationRunRow } from "../db/automation-store";
import type { SqlDatabase } from "../db/sql-database";
import { TeamStore } from "../db/teams";
import { TeamRepositoryGrantStore } from "../db/team-repository-grants";
import { createRequestMetrics } from "../db/instrumented-sql-database";
import type { Env } from "../types";
import type { BackgroundTasks } from "../platform-ports";
import type { Logger } from "../logger";
import { AutomationExecutionUnauthorizedError } from "./authorization-guard";
import { resolveAutomationSessionTarget, type AutomationSessionTarget } from "./session-target";

export type LaunchTargetSnapshot = { target: AutomationSessionTarget } | { error: unknown };

/** Initial attempts and retries admit the exact workspace against one grants snapshot. */
export async function prepareAutomationTargetAdmission(
  db: SqlDatabase,
  env: Env,
  automation: AutomationRow,
  candidates: readonly AutomationRunRow[],
  backgroundJobs: BackgroundTasks,
  log: Logger
) {
  const team =
    automation.owner_team_id === null
      ? null
      : await new TeamStore(db).getById(automation.owner_team_id);
  if (automation.owner_team_id !== null && !team) throw new AutomationExecutionUnauthorizedError();
  const targets = new Map<string, LaunchTargetSnapshot>();
  if (!team) return { targets, teamGrantsVersion: undefined };
  await Promise.all(
    candidates.map(async (child) => {
      try {
        const target = await resolveAutomationSessionTarget(
          env,
          child,
          {
            trace_id: `automation:${automation.id}`,
            request_id: child.id,
            metrics: createRequestMetrics(),
            db,
            executionCtx: backgroundJobs,
          },
          log
        );
        targets.set(child.id, { target });
      } catch (error) {
        targets.set(child.id, { error });
      }
    })
  );
  const repoIds = [...targets.values()].flatMap((snapshot) => {
    if (!("target" in snapshot)) return [];
    return (
      snapshot.target.repositories?.map((repository) => repository.repoId) ??
      (snapshot.target.repoId === null ? [] : [snapshot.target.repoId])
    );
  });
  if (!(await new TeamRepositoryGrantStore(db).covers(team.id, repoIds))) {
    throw new AutomationExecutionUnauthorizedError("target_team_missing_grant");
  }
  return {
    targets,
    teamGrantsVersion: { teamId: team.id, version: team.grantsVersion },
  };
}
