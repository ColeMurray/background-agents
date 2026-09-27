import {
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
                AND (role != 'lead' OR (SELECT COUNT(*) FROM team_memberships WHERE team_id = ? AND role = 'lead') > 1)`
      )
      .bind(teamRoleSchema.parse(role), teamId, userId, teamId)
      .run();
    if (result.meta.changes === 0) throw new LastLeadError();
  }

  async remove(teamId: string, userId: string): Promise<void> {
    const result = await this.db
      .prepare(
        `DELETE FROM team_memberships WHERE team_id = ? AND user_id = ?
                AND (role != 'lead' OR (SELECT COUNT(*) FROM team_memberships WHERE team_id = ? AND role = 'lead') > 1)`
      )
      .bind(teamId, userId, teamId)
      .run();
    if (result.meta.changes === 0) throw new LastLeadError();
  }

  autoJoinStatements(userId: string, nowMs: number): SqlStatement[] {
    return [
      this.db
        .prepare(
          `INSERT INTO team_memberships (team_id, user_id, role, source, created_at)
                  SELECT id, ?, 'member', 'auto_join', ? FROM teams
                  WHERE auto_join = 1 AND archived_at IS NULL
                  ON CONFLICT DO NOTHING`
        )
        .bind(userId, nowMs),
      this.db
        .prepare(
          `INSERT INTO authorization_audit_events
                  (id, occurred_at, request_id, principal_kind, actor_service_snapshot,
                   action, resource_type, resource_id, target_user_id_snapshot,
                   reason_code, operation_result, metadata_json, team_id)
                  SELECT lower(hex(randomblob(16))), ?, 'team-auto-join:' || ? || ':' || t.id,
                         'service', 'team-auto-join', 'team.member_auto_joined', 'team', t.id,
                         ?, 'auto_join', 'applied', ?, t.id
                  FROM teams t JOIN team_memberships m ON m.team_id = t.id AND m.user_id = ?
                  WHERE m.source = 'auto_join' AND m.created_at = ?
                    AND NOT EXISTS (
                      SELECT 1 FROM authorization_audit_events a
                      WHERE a.request_id = 'team-auto-join:' || ? || ':' || t.id
                        AND a.action = 'team.member_auto_joined'
                    )`
        )
        .bind(
          nowMs,
          userId,
          userId,
          JSON.stringify({
            before: { member: false },
            requested: { source: "auto_join" },
            after: { member: true },
          }),
          userId,
          nowMs,
          userId
        ),
    ];
  }
}
