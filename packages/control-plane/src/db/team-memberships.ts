import { z } from "zod";
import {
  teamMemberSchema,
  teamMembershipSchema,
  teamRoleSchema,
  type TeamMembership,
  type TeamRole,
} from "@open-inspect/shared/types/teams";
import { TeamAuditStore, type TeamAuditActor, type TeamAuditInput } from "./team-audit";
import type { SqlDatabase, SqlResult, SqlStatement } from "./sql-database";

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

  /** With `audit`, the insert and its `team.member_added` row commit or roll back together. */
  async add(
    teamId: string,
    userId: string,
    role: TeamRole = "member",
    source: TeamMembership["source"] = "manual",
    audit?: TeamAuditActor
  ): Promise<boolean> {
    const createdAt = Date.now();
    const result = await this.runAudited(
      this.db
        .prepare(
          "INSERT INTO team_memberships (team_id, user_id, role, source, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING"
        )
        .bind(teamId, userId, teamRoleSchema.parse(role), source, createdAt),
      audit && {
        ...audit,
        teamId,
        targetUserId: userId,
        action: "team.member_added",
        before: {},
        after: { teamId, userId, role, source, createdAt },
      }
    );
    return result.meta.changes > 0;
  }

  /** With `audit`, the join and its `team.member_joined` row commit or roll back together. */
  async addIfJoinable(teamId: string, userId: string, audit?: TeamAuditActor): Promise<boolean> {
    const createdAt = Date.now();
    const result = await this.runAudited(
      this.bindAddIfJoinable(teamId, userId, createdAt),
      audit && {
        ...audit,
        teamId,
        targetUserId: userId,
        action: "team.member_joined",
        before: {},
        after: { teamId, userId, role: "member", source: "manual", createdAt },
      }
    );
    return result.meta.changes > 0;
  }

  private bindAddIfJoinable(teamId: string, userId: string, createdAt: number): SqlStatement {
    return this.db
      .prepare(
        `INSERT INTO team_memberships (team_id, user_id, role, source, created_at)
         SELECT id, ?, 'member', 'manual', ? FROM teams
         WHERE id = ? AND join_policy = 'open' AND archived_at IS NULL
         ON CONFLICT DO NOTHING`
      )
      .bind(userId, createdAt, teamId);
  }

  /** With `audit`, the change and its `team.member_role_changed` row commit or roll back together. */
  async setRole(
    teamId: string,
    userId: string,
    role: TeamRole,
    audit?: TeamAuditActor & { before: TeamMembership }
  ): Promise<void> {
    const result = await this.runAudited(
      this.db
        .prepare(
          `UPDATE team_memberships SET role = ? WHERE team_id = ? AND user_id = ?
                AND (? = 'lead' OR role != 'lead' OR (SELECT COUNT(*) FROM team_memberships WHERE team_id = ? AND role = 'lead') > 1)`
        )
        .bind(teamRoleSchema.parse(role), teamId, userId, role, teamId),
      audit && {
        ...audit,
        teamId,
        targetUserId: userId,
        action: "team.member_role_changed",
        after: { ...audit.before, role },
      }
    );
    if (result.meta.changes === 0) await this.throwMembershipUpdateError(teamId, userId);
  }

  /** With `audit`, the removal and its `team.member_removed` row commit or roll back together. */
  async remove(
    teamId: string,
    userId: string,
    audit?: TeamAuditActor & { before: TeamMembership }
  ): Promise<void> {
    const result = await this.runAudited(
      this.db
        .prepare(
          `DELETE FROM team_memberships WHERE team_id = ? AND user_id = ?
                AND (role != 'lead' OR (SELECT COUNT(*) FROM team_memberships WHERE team_id = ? AND role = 'lead') > 1)`
        )
        .bind(teamId, userId, teamId),
      audit && {
        ...audit,
        teamId,
        targetUserId: userId,
        action: "team.member_removed",
        after: {},
      }
    );
    if (result.meta.changes === 0) await this.throwMembershipUpdateError(teamId, userId);
  }

  /** Runs `mutation`, audited in the same batch only when it changed a row. */
  private async runAudited(
    mutation: SqlStatement,
    audit: TeamAuditInput | undefined
  ): Promise<SqlResult> {
    const [result] = await this.db.batch(
      audit ? [mutation, new TeamAuditStore(this.db).bind(audit, true)] : [mutation]
    );
    return result;
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
