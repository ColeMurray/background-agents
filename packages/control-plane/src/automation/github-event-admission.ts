import {
  conditionRegistry,
  matchesConditions,
  type GitHubAutomationEvent,
} from "@open-inspect/shared/triggers";
import {
  AutomationStore,
  parseAutomationTriggerFields,
  type AutomationRepositoryInsert,
  type AutomationRow,
} from "../db/automation-store";
import { GitHubAutomationStore } from "../db/github-automation-store";
import { TeamRepositoryGrantStore } from "../db/team-repository-grants";
import type { SqlDatabase } from "../db/sql-database";
import type { Logger } from "../logger";
import type { SchedulerEventResult, StartInvocationResult } from "../scheduler/scheduler";

export const MAX_GITHUB_ADMISSION_ATTEMPTS = 3;

/** Rejecting leaves delivery cleanup/redelivery to the event transport, not a terminal skip. */
export class GitHubAdmissionRetryError extends Error {
  constructor(readonly automationId: string) {
    super(`GitHub admission did not stabilize for ${automationId}`);
    this.name = "GitHubAdmissionRetryError";
  }
}

/** Keep GitHub identity, grant races, and retry policy outside the shared firing pipeline. */
export async function admitGitHubEvent(
  db: SqlDatabase,
  event: GitHubAutomationEvent,
  fire: (
    automation: AutomationRow,
    repositories: AutomationRepositoryInsert[]
  ) => Promise<StartInvocationResult>,
  log: Logger
): Promise<SchedulerEventResult> {
  const store = new AutomationStore(db);
  const github = new GitHubAutomationStore(db);
  const grants = new TeamRepositoryGrantStore(db);
  const candidates = await github.getGitHubAutomationsForEvent(event.repositoryId, event.eventType);
  let triggered = 0;
  let skipped = 0;
  let retryFailure: GitHubAdmissionRetryError | undefined;

  candidateLoop: for (const candidate of candidates) {
    for (let attempt = 0; attempt < MAX_GITHUB_ADMISSION_ATTEMPTS; attempt++) {
      const automation = await store.getById(candidate.automation.id);
      if (
        !automation ||
        automation.enabled !== 1 ||
        automation.deleted_at !== null ||
        automation.trigger_type !== "github_event" ||
        automation.event_type !== event.eventType
      ) {
        skipped++;
        continue candidateLoop;
      }
      let conditions;
      try {
        conditions = parseAutomationTriggerFields(automation).triggerConfig?.conditions ?? [];
      } catch {
        log.error("Skipped automation with invalid stored trigger fields", {
          event: "scheduler.invalid_trigger_fields",
          automation_id: automation.id,
        });
        skipped++;
        continue candidateLoop;
      }
      if (!matchesConditions(conditions, event, conditionRegistry)) continue candidateLoop;

      const selection = await store.getRepositoriesForAutomation(automation.id);
      if (selection.length !== 1 || selection[0].repo_id !== event.repositoryId) {
        skipped++;
        continue candidateLoop;
      }
      const uncovered =
        automation.owner_team_id !== null &&
        !(await grants.covers(automation.owner_team_id, [event.repositoryId]));
      if (uncovered && (await github.recordGitHubGrantDenied(automation.id, event))) {
        skipped++;
        continue candidateLoop;
      }
      const repositories = selection.map((repository) => ({
        ...repository,
        repo_owner: event.repoOwner,
        repo_name: event.repoName,
      }));
      const result = await fire(automation, repositories);
      if (result.outcome === "blocked" && result.reason === "team_grants_changed") continue;
      if (result.outcome === "unauthorized" && result.reason === "target_team_missing_grant") {
        if (await github.recordGitHubGrantDenied(automation.id, event)) {
          skipped++;
          continue candidateLoop;
        }
        // Coverage returned before the conditional denial; retry fresh admission.
        continue;
      }
      switch (result.outcome) {
        case "started":
          if (result.launched > 0) triggered++;
          break;
        case "unauthorized":
          log.warn("Skipped event automation after execution authorization denial", {
            event: "scheduler.authorization_denied",
            automation_id: automation.id,
            source: "github",
            reason_code: result.reason ?? "execution_authorization_denied",
          });
          skipped++;
          break;
        case "skipped":
        case "blocked":
        case "deduplicated":
          skipped++;
          break;
      }
      continue candidateLoop;
    }
    retryFailure ??= new GitHubAdmissionRetryError(candidate.automation.id);
  }
  if (retryFailure) throw retryFailure;
  log.info("Event processed", {
    event: "scheduler.event_processed",
    source: "github",
    event_type: event.eventType,
    trigger_key: event.triggerKey,
    triggered,
    skipped,
    steered: 0,
    candidates: candidates.length,
  });
  return { triggered, skipped, steered: 0 };
}
