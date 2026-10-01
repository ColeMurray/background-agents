import { z } from "zod";
import {
  teamMemberSchema,
  teamMembershipSchema,
  teamRoleSchema,
  type TeamMembership,
  type TeamRole,
} from "@open-inspect/shared/types/teams";
import type { SqlDatabase, SqlStatement } from "./sql-database";

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

  async countLeads(teamId: string): Promise<number> {
    const row = await this.db
      .prepare("SELECT COUNT(*) AS count FROM team_memberships WHERE team_id = ? AND role = 'lead'")
      .bind(teamId)
      .first();
    return teamRoleCountSchema.parse(row).count;
  }

  async listLeadCounts(): Promise<ReadonlyMap<string, number>> {
    const rows = await this.db
      .prepare(
        "SELECT team_id, COUNT(*) AS count FROM team_memberships WHERE role = 'lead' GROUP BY team_id"
      )
      .all();
    return new Map(
      rows.results.map((row) => {
        const value = teamRoleCountSchema.extend({ team_id: z.string() }).parse(row);
        return [value.team_id, value.count];
      })
    );
  }

  async countMembers(teamId: string): Promise<number> {
    const row = await this.db
      .prepare("SELECT COUNT(*) AS count FROM team_memberships WHERE team_id = ?")
      .bind(teamId)
      .first();
    return teamRoleCountSchema.parse(row).count;
  }

  async listMemberCounts(): Promise<ReadonlyMap<string, number>> {
    const rows = await this.db
      .prepare("SELECT team_id, COUNT(*) AS count FROM team_memberships GROUP BY team_id")
      .all();
    return new Map(
      rows.results.map((row) => {
        const value = teamRoleCountSchema.extend({ team_id: z.string() }).parse(row);
        return [value.team_id, value.count];
      })
    );
  }

  async listMembersWithUsers(teamId: string, { includeEmail }: { includeEmail: boolean }) {
    const rows = await this.db
      .prepare(
        `SELECT m.*, u.display_name, ${includeEmail ? "u.email" : "NULL AS email"}, u.avatar_url
      FROM team_memberships m JOIN users u ON u.id = m.user_id
      WHERE m.team_id = ? ORDER BY m.created_at, m.user_id`
      )
      .bind(teamId)
      .all();
    return rows.results.map((row) =>
      teamMemberSchema.parse({
        teamId: row.team_id,
        userId: row.user_id,
        role: row.role,
        source: row.source,
        createdAt: row.created_at,
        displayName: row.display_name,
        email: row.email,
        avatarUrl: row.avatar_url,
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

  async addIfJoinable(teamId: string, userId: string): Promise<boolean> {
    const result = await this.bindAddIfJoinable(teamId, userId).run();
    return result.meta.changes > 0;
  }

  private bindAddIfJoinable(teamId: string, userId: string): SqlStatement {
    return this.db
      .prepare(
        `INSERT INTO team_memberships (team_id, user_id, role, source, created_at)
         SELECT id, ?, 'member', 'manual', ? FROM teams
         WHERE id = ? AND join_policy = 'open' AND archived_at IS NULL
         ON CONFLICT DO NOTHING`
      )
      .bind(userId, Date.now(), teamId);
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

const teamRoleCountSchema = z.object({ count: z.number().int().nonnegative() });
