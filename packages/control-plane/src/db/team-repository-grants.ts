import { z } from "zod";
import {
  addTeamRepositoryGrantRequestSchema,
  MAX_TEAM_REPOSITORY_GRANTS,
  teamRepositoryGrantSchema,
  type AddTeamRepositoryGrantRequest,
  type TeamRepositoryGrant,
} from "@open-inspect/shared/types/teams";
import { generateId } from "../auth/crypto";
import { TeamAuditStore } from "./team-audit";
import type { SqlDatabase } from "./sql-database";

const grantSchema = z.object({
  grant_kind: z.enum(["installation", "repository"]),
  repo_external_id: z.number().nullable(),
});

type TeamRepositoryGrantRow = z.infer<typeof grantSchema>;

/** The subset of `repoIds` a team's grants cover; an installation grant covers every id. */
export function coveredRepositoryIds<T extends number | null>(
  grants: readonly TeamRepositoryGrantRow[],
  repoIds: readonly T[]
): T[] {
  if (grants.some((grant) => grant.grant_kind === "installation")) return [...repoIds];
  const allowed = new Set(grants.map((grant) => grant.repo_external_id));
  return repoIds.filter((id) => id !== null && allowed.has(id));
}

export class TeamRepositoryGrantConflictError extends Error {
  constructor(readonly code: "grant_kind_conflict" | "repository_grant_limit" | "team_not_active") {
    super(
      code === "grant_kind_conflict"
        ? "Remove the existing grants before changing grant kind"
        : code === "repository_grant_limit"
          ? "Team repository grant limit reached"
          : "Team is not active"
    );
  }
}

type GrantActor = { actorUserId: string; requestId: string };

function toGrant(row: Record<string, unknown>): TeamRepositoryGrant {
  return teamRepositoryGrantSchema.parse({
    id: row.id,
    teamId: row.team_id,
    kind: row.grant_kind,
    repoExternalId: row.repo_external_id,
    owner: row.repo_owner,
    name: row.repo_name,
    createdAt: row.created_at,
  });
}

export class TeamRepositoryGrantStore {
  constructor(private readonly db: SqlDatabase) {}

  async listForTeam(teamId: string) {
    const rows = await this.db
      .prepare("SELECT grant_kind, repo_external_id FROM team_repository_grants WHERE team_id = ?")
      .bind(teamId)
      .all();
    return z.array(grantSchema).parse(rows.results);
  }

  async listDetailsForTeam(teamId: string): Promise<TeamRepositoryGrant[]> {
    const rows = await this.db
      .prepare("SELECT * FROM team_repository_grants WHERE team_id = ? ORDER BY created_at, id")
      .bind(teamId)
      .all();
    return rows.results.map(toGrant);
  }

  async listTeamsForRepository(repoId: number): Promise<string[]> {
    const rows = await this.db
      .prepare(
        `SELECT DISTINCT team_id FROM team_repository_grants
        WHERE grant_kind = 'installation' OR (grant_kind = 'repository' AND repo_external_id = ?)
        ORDER BY team_id`
      )
      .bind(repoId)
      .all();
    return z
      .array(z.object({ team_id: z.string() }))
      .parse(rows.results)
      .map((row) => row.team_id);
  }

  async add(
    teamId: string,
    input: AddTeamRepositoryGrantRequest,
    actor?: GrantActor
  ): Promise<TeamRepositoryGrant> {
    const body = addTeamRepositoryGrantRequestSchema.parse(input);
    const grant = teamRepositoryGrantSchema.parse({
      id: `grant_${generateId()}`,
      teamId,
      kind: body.kind,
      repoExternalId: body.kind === "repository" ? body.repoExternalId : null,
      owner: body.kind === "repository" ? body.owner : null,
      name: body.kind === "repository" ? body.name : null,
      createdAt: Date.now(),
    });
    const statements = [
      this.db
        .prepare(
          `INSERT INTO team_repository_grants
            (id, team_id, grant_kind, repo_external_id, repo_owner, repo_name, created_at)
           SELECT ?, id, ?, ?, ?, ?, ? FROM teams
           WHERE id = ? AND archived_at IS NULL
             AND NOT EXISTS (SELECT 1 FROM team_repository_grants WHERE team_id = ? AND grant_kind != ?)
             AND (SELECT COUNT(*) FROM team_repository_grants WHERE team_id = ?) < ?
           ON CONFLICT DO NOTHING`
        )
        .bind(
          grant.id,
          grant.kind,
          grant.repoExternalId,
          grant.owner,
          grant.name,
          grant.createdAt,
          teamId,
          teamId,
          body.kind,
          teamId,
          MAX_TEAM_REPOSITORY_GRANTS
        ),
      this.db
        .prepare(
          "UPDATE teams SET grants_version = grants_version + 1, updated_at = ? WHERE id = ? AND changes() = 1"
        )
        .bind(grant.createdAt, teamId),
    ];
    if (actor) {
      statements.push(
        new TeamAuditStore(this.db).bind(
          { ...actor, teamId, action: "team.grant_added", before: {}, after: grant },
          true
        )
      );
    }
    const [inserted] = await this.db.batch(statements);
    if (inserted.meta.changes === 1) return grant;

    const grants = await this.listDetailsForTeam(teamId);
    const existing = grants.find(
      (row) => row.kind === body.kind && row.repoExternalId === grant.repoExternalId
    );
    if (existing) return existing;
    if (grants.some((row) => row.kind !== body.kind))
      throw new TeamRepositoryGrantConflictError("grant_kind_conflict");
    if (grants.length >= MAX_TEAM_REPOSITORY_GRANTS)
      throw new TeamRepositoryGrantConflictError("repository_grant_limit");
    throw new TeamRepositoryGrantConflictError("team_not_active");
  }

  async remove(teamId: string, grantId: string, actor?: GrantActor): Promise<boolean> {
    const row = await this.db
      .prepare("SELECT * FROM team_repository_grants WHERE team_id = ? AND id = ?")
      .bind(teamId, grantId)
      .first();
    if (!row) return false;
    const before = toGrant(row);
    const statements = [
      this.db
        .prepare(
          `DELETE FROM team_repository_grants WHERE team_id = ? AND id = ?
          AND EXISTS (SELECT 1 FROM teams WHERE id = ? AND archived_at IS NULL)`
        )
        .bind(teamId, grantId, teamId),
      this.db
        .prepare(
          "UPDATE teams SET grants_version = grants_version + 1, updated_at = ? WHERE id = ? AND changes() = 1"
        )
        .bind(Date.now(), teamId),
    ];
    if (actor)
      statements.push(
        new TeamAuditStore(this.db).bind(
          { ...actor, teamId, action: "team.grant_removed", before, after: {} },
          true
        )
      );
    const [deleted] = await this.db.batch(statements);
    return deleted.meta.changes === 1;
  }

  async covers(teamId: string, repoIds: readonly (number | null)[]): Promise<boolean> {
    if (repoIds.length === 0) return true;
    const grants = await this.listForTeam(teamId);
    return coveredRepositoryIds(grants, repoIds).length === repoIds.length;
  }
}
