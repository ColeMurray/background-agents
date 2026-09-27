import {
  teamMembershipSchema,
  teamRoleSchema,
  type TeamMembership,
  type TeamRole,
} from "@open-inspect/shared/types/teams";
import type { SqlDatabase } from "./sql-database";

export class LastLeadError extends Error {
  constructor() {
    super("The last team lead cannot be demoted or removed");
    this.name = "LastLeadError";
  }
}

export class TeamMembershipNotFoundError extends Error {
  constructor() {
    super("Team membership not found");
    this.name = "TeamMembershipNotFoundError";
  }
}

export class TeamMembershipStore {
  constructor(private readonly db: SqlDatabase) {}

  async listForUser(userId: string): Promise<ReadonlyMap<string, TeamRole>> {
    const rows = await this.db
      .prepare("SELECT team_id, role FROM team_memberships WHERE user_id = ?")
      .bind(userId)
      .all();
    return new Map(
      rows.results.map((row) => {
        const value = teamMembershipSchema.pick({ teamId: true, role: true }).parse({
          teamId: row.team_id,
          role: row.role,
        });
        return [value.teamId, value.role];
      })
    );
  }

  async listMembers(teamId: string): Promise<TeamMembership[]> {
    const rows = await this.db
      .prepare("SELECT * FROM team_memberships WHERE team_id = ? ORDER BY created_at, user_id")
      .bind(teamId)
      .all();
    return rows.results.map((row) =>
      teamMembershipSchema.parse({
        teamId: row.team_id,
        userId: row.user_id,
        role: row.role,
        source: row.source,
        createdAt: row.created_at,
      })
    );
  }

  async add(
    teamId: string,
    userId: string,
    role: TeamRole = "member",
    source: TeamMembership["source"] = "manual"
  ): Promise<boolean> {
    const result = await this.db
      .prepare(
        "INSERT INTO team_memberships (team_id, user_id, role, source, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING"
      )
      .bind(teamId, userId, teamRoleSchema.parse(role), source, Date.now())
      .run();
    return result.meta.changes > 0;
  }

  async setRole(teamId: string, userId: string, role: TeamRole): Promise<void> {
    const result = await this.db
      .prepare(
        `UPDATE team_memberships SET role = ? WHERE team_id = ? AND user_id = ?
                AND (? = 'lead' OR role != 'lead' OR (SELECT COUNT(*) FROM team_memberships WHERE team_id = ? AND role = 'lead') > 1)`
      )
      .bind(teamRoleSchema.parse(role), teamId, userId, role, teamId)
      .run();
    if (result.meta.changes === 0) await this.throwMembershipUpdateError(teamId, userId);
  }

  async remove(teamId: string, userId: string): Promise<void> {
    const result = await this.db
      .prepare(
        `DELETE FROM team_memberships WHERE team_id = ? AND user_id = ?
                AND (role != 'lead' OR (SELECT COUNT(*) FROM team_memberships WHERE team_id = ? AND role = 'lead') > 1)`
      )
      .bind(teamId, userId, teamId)
      .run();
    if (result.meta.changes === 0) await this.throwMembershipUpdateError(teamId, userId);
  }

  private async throwMembershipUpdateError(teamId: string, userId: string): Promise<never> {
    const member = await this.db
      .prepare("SELECT 1 AS ok FROM team_memberships WHERE team_id = ? AND user_id = ?")
      .bind(teamId, userId)
      .first();
    if (!member) throw new TeamMembershipNotFoundError();
    throw new LastLeadError();
  }
}
