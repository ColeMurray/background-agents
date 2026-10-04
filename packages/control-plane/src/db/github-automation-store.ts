import type { GitHubAutomationEvent } from "@open-inspect/shared/triggers";
import { z } from "zod";
import { generateId } from "../auth/crypto";
import { withValidatedOwnerTeam, type AutomationRow } from "./automation-store";
import type { SqlDatabase } from "./sql-database";

const githubGrantRowSchema = z.object({ repo_granted: z.union([z.literal(0), z.literal(1)]) });

/** Numeric GitHub event matching and atomic, sessionless grant-denial history. */
export class GitHubAutomationStore {
  constructor(private readonly db: SqlDatabase) {}

  async getGitHubAutomationsForEvent(
    repositoryId: number,
    eventType: string
  ): Promise<Array<{ automation: AutomationRow; repositoryGranted: boolean }>> {
    // Keep uncovered teams in the result so matching events have denied-run history.
    const result = await this.db
      .prepare(
        `SELECT DISTINCT a.*,
                CASE WHEN a.owner_team_id IS NULL OR g.id IS NOT NULL THEN 1 ELSE 0 END AS repo_granted
         FROM automations a
         JOIN automation_repositories ar ON ar.automation_id = a.id
         LEFT JOIN team_repository_grants g ON g.team_id = a.owner_team_id
           AND (g.grant_kind = 'installation' OR
                (g.grant_kind = 'repository' AND g.repo_external_id = ar.repo_id))
         WHERE ar.repo_id = ? AND a.trigger_type = 'github_event' AND a.event_type = ?
           AND a.enabled = 1 AND a.deleted_at IS NULL`
      )
      .bind(repositoryId, eventType)
      .all<AutomationRow & { repo_granted: number }>();
    return (result.results ?? []).map((row) => ({
      automation: withValidatedOwnerTeam(row),
      repositoryGranted: githubGrantRowSchema.parse(row).repo_granted === 1,
    }));
  }

  /** True means the event is claimed; false leaves it available for normal admission. */
  async recordGitHubGrantDenied(
    automationId: string,
    event: GitHubAutomationEvent
  ): Promise<boolean> {
    const invocationId = generateId();
    const createdAt = Date.now();
    const [inserted] = await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO automation_invocations
           (id, automation_id, source, trigger_key, concurrency_key, created_at, updated_at)
           SELECT ?, ?, 'event', ?, ?, ?, ?
           WHERE EXISTS (SELECT 1 FROM automations a WHERE a.id = ? AND a.owner_team_id IS NOT NULL
                         AND NOT EXISTS (SELECT 1 FROM team_repository_grants g
                                         WHERE g.team_id = a.owner_team_id
                                           AND (g.grant_kind = 'installation' OR
                                                (g.grant_kind = 'repository' AND g.repo_external_id = ?))))
           ON CONFLICT DO NOTHING`
        )
        .bind(
          invocationId,
          automationId,
          event.triggerKey,
          event.concurrencyKey,
          createdAt,
          createdAt,
          automationId,
          event.repositoryId
        ),
      this.db
        .prepare(
          `INSERT INTO automation_runs
           (id, automation_id, invocation_id, status, failure_reason, scheduled_at,
            completed_at, created_at, repo_owner, repo_name, repo_id)
           SELECT ?, ?, ?, 'unauthorized', 'repo_not_granted', ?, ?, ?, ?, ?, ?
           WHERE EXISTS (SELECT 1 FROM automation_invocations WHERE id = ?)`
        )
        .bind(
          generateId(),
          automationId,
          invocationId,
          createdAt,
          createdAt,
          createdAt,
          event.repoOwner,
          event.repoName,
          event.repositoryId,
          invocationId
        ),
    ]);
    if ((inserted.meta.changes ?? 0) > 0) return true;
    return (
      (await this.db
        .prepare("SELECT 1 FROM automation_invocations WHERE automation_id = ? AND trigger_key = ?")
        .bind(automationId, event.triggerKey)
        .first()) !== null
    );
  }
}
