import {
  teamChannelBindingSchema,
  type TeamChannelBinding,
  type TeamChannelBindingProvider,
} from "@open-inspect/shared/types/team-channel-bindings";
import { isUniqueConstraintError } from "./errors";
import type { SqlDatabase, SqlStatement } from "./sql-database";

export interface TeamChannelBindingActor {
  requestId: string;
  actorUserId: string;
}

export class TeamChannelBindingConflictError extends Error {
  constructor() {
    super("Channel binding conflicts with an existing binding");
    this.name = "TeamChannelBindingConflictError";
  }
}

const BINDING_COLUMNS = 'provider, external_id AS "externalId", team_id AS "teamId", kind';

export class TeamChannelBindingStore {
  constructor(private readonly db: SqlDatabase) {}

  async get(
    provider: TeamChannelBindingProvider,
    externalId: string
  ): Promise<TeamChannelBinding | null> {
    const row = await this.db
      .prepare(
        `SELECT ${BINDING_COLUMNS} FROM team_channel_bindings WHERE provider = ? AND external_id = ?`
      )
      .bind(provider, externalId)
      .first();
    return row ? teamChannelBindingSchema.parse(row) : null;
  }

  async listByTeam(teamId: string): Promise<TeamChannelBinding[]> {
    const rows = await this.db
      .prepare(
        `SELECT ${BINDING_COLUMNS} FROM team_channel_bindings
         WHERE team_id = ? ORDER BY provider, external_id`
      )
      .bind(teamId)
      .all();
    return rows.results.map((row) => teamChannelBindingSchema.parse(row));
  }

  async put(
    binding: TeamChannelBinding,
    actor: TeamChannelBindingActor
  ): Promise<TeamChannelBinding> {
    binding = teamChannelBindingSchema.parse(binding);
    const { provider, externalId, teamId, kind } = binding;
    try {
      const [, result] = await this.db.batch([
        this.bindAudit("team.binding_added", binding, actor),
        this.db
          .prepare(
            `INSERT INTO team_channel_bindings (provider, external_id, team_id, kind, created_at)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT (provider, external_id) DO UPDATE SET kind = excluded.kind
             WHERE team_channel_bindings.team_id = excluded.team_id
               AND team_channel_bindings.kind <> excluded.kind`
          )
          .bind(provider, externalId, teamId, kind, Date.now()),
      ]);
      if (result.meta.changes === 0) {
        const existing = await this.get(provider, externalId);
        if (existing?.teamId !== teamId || existing.kind !== kind) {
          throw new TeamChannelBindingConflictError();
        }
      }
    } catch (cause) {
      if (isUniqueConstraintError(cause)) throw new TeamChannelBindingConflictError();
      throw cause;
    }
    return binding;
  }

  async remove(
    teamId: string,
    provider: TeamChannelBindingProvider,
    externalId: string,
    actor: TeamChannelBindingActor
  ): Promise<boolean> {
    const [, result] = await this.db.batch([
      this.bindAudit(
        "team.binding_removed",
        { teamId, provider, externalId, kind: "source" },
        actor
      ),
      this.db
        .prepare(
          "DELETE FROM team_channel_bindings WHERE team_id = ? AND provider = ? AND external_id = ?"
        )
        .bind(teamId, provider, externalId),
    ]);
    return result.meta.changes > 0;
  }

  private bindAudit(
    action: "team.binding_added" | "team.binding_removed",
    binding: TeamChannelBinding,
    actor: TeamChannelBindingActor
  ): SqlStatement {
    const { teamId, provider, externalId, kind } = binding;
    const removing = action === "team.binding_removed";
    const metadata = (before: object) =>
      JSON.stringify({ before, requested: {}, after: removing ? {} : binding });

    // Read the previous kind inside the same batch snapshot as the mutation.
    // Predicate-gated audit writes avoid SQLite-specific changes() and omit no-ops.
    return this.db
      .prepare(
        `INSERT INTO authorization_audit_events
           (id, occurred_at, request_id, principal_kind, actor_user_id_snapshot,
            action, resource_type, resource_id, team_id, reason_code, operation_result, metadata_json)
         SELECT ?, ?, ?, 'user', ?, ?, 'team', ?, ?, ?, 'applied',
           CASE (SELECT kind FROM team_channel_bindings
                 WHERE team_id = ? AND provider = ? AND external_id = ?)
             WHEN 'primary' THEN ? WHEN 'source' THEN ? ELSE ? END
         WHERE ${
           removing
             ? "EXISTS (SELECT 1 FROM team_channel_bindings WHERE team_id = ? AND provider = ? AND external_id = ?)"
             : `NOT EXISTS (SELECT 1 FROM team_channel_bindings
                           WHERE provider = ? AND external_id = ? AND (team_id <> ? OR kind = ?))`
         }`
      )
      .bind(
        crypto.randomUUID(),
        Date.now(),
        actor.requestId,
        actor.actorUserId,
        action,
        teamId,
        teamId,
        action,
        teamId,
        provider,
        externalId,
        metadata({ ...binding, kind: "primary" }),
        metadata({ ...binding, kind: "source" }),
        metadata({}),
        ...(removing ? [teamId, provider, externalId] : [provider, externalId, teamId, kind])
      );
  }
}
