import {
  teamRowSchema,
  type Team,
  type TeamJoinPolicy,
  type SessionVisibility,
} from "@open-inspect/shared/types/teams";
import { generateId } from "../auth/crypto";
import { isUniqueConstraintError } from "./errors";
import { TeamAuditStore, type TeamAuditActor } from "./team-audit";
import type { SqlDatabase, SqlStatement } from "./sql-database";

export class TeamSlugConflictError extends Error {
  constructor() {
    super("Team slug already exists");
    this.name = "TeamSlugConflictError";
  }
}

/** Who changed the team and the state they changed it from. */
type TeamChangeAudit = TeamAuditActor & { before: Team };

function rethrowTeamWriteError(cause: unknown): never {
  if (isUniqueConstraintError(cause)) throw new TeamSlugConflictError();
  throw cause;
}

function toTeam(value: unknown): Team {
  const row = teamRowSchema.parse(value);
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    joinPolicy: row.join_policy,
    defaultVisibility: row.default_visibility,
    defaultEnvironmentId: row.default_environment_id,
    grantsVersion: row.grants_version,
    archivedAt: row.archived_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class TeamStore {
  constructor(private readonly db: SqlDatabase) {}

  async getById(id: string): Promise<Team | null> {
    const row = await this.db.prepare("SELECT * FROM teams WHERE id = ?").bind(id).first();
    return row ? toTeam(row) : null;
  }

  async getBySlug(slug: string): Promise<Team | null> {
    const row = await this.db.prepare("SELECT * FROM teams WHERE slug = ?").bind(slug).first();
    return row ? toTeam(row) : null;
  }

  async list(
    options: { forUserId?: string; includeArchived?: boolean; search?: string } = {}
  ): Promise<Team[]> {
    const conditions: string[] = [];
    if (!options.includeArchived) conditions.push("t.archived_at IS NULL");
    if (options.forUserId)
      conditions.push(
        "EXISTS (SELECT 1 FROM team_memberships m WHERE m.team_id = t.id AND m.user_id = ?)"
      );
    if (options.search)
      conditions.push("(lower(t.name) LIKE ? ESCAPE '\\' OR lower(t.slug) LIKE ? ESCAPE '\\')");
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const search = options.search?.toLowerCase().replace(/[\\%_]/g, "\\$&");
    const rows = await this.db
      .prepare(`SELECT t.* FROM teams t ${where} ORDER BY t.name, t.id`)
      .bind(
        ...(options.forUserId ? [options.forUserId] : []),
        ...(search ? [`%${search}%`, `%${search}%`] : [])
      )
      .all();
    return rows.results.map(toTeam);
  }

  private insertStatement(
    input: {
      slug: string;
      name: string;
      description?: string | null;
      joinPolicy: TeamJoinPolicy;
    },
    id: string,
    now: number
  ): SqlStatement {
    return this.db
      .prepare(
        `INSERT INTO teams (id, slug, name, description, join_policy, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(id, input.slug, input.name, input.description ?? null, input.joinPolicy, now, now);
  }

  async create(input: {
    slug: string;
    name: string;
    description?: string | null;
    joinPolicy: TeamJoinPolicy;
  }): Promise<Team> {
    const id = `team_${generateId()}`;
    try {
      await this.insertStatement(input, id, Date.now()).run();
    } catch (cause) {
      rethrowTeamWriteError(cause);
    }
    return (await this.getById(id))!;
  }

  async createWithLead(
    input: { slug: string; name: string; description?: string | null; joinPolicy: TeamJoinPolicy },
    leadUserId: string,
    requestId: string
  ): Promise<Team> {
    const id = `team_${generateId()}`;
    const now = Date.now();
    try {
      await this.db.batch([
        this.insertStatement(input, id, now),
        this.db
          .prepare(
            "INSERT INTO team_memberships (team_id, user_id, role, source, created_at) VALUES (?, ?, 'lead', 'manual', ?)"
          )
          .bind(id, leadUserId, now),
        new TeamAuditStore(this.db).bind({
          requestId,
          actorUserId: leadUserId,
          teamId: id,
          action: "team.created",
          before: {},
          after: { ...input, teamId: id, leadUserId },
        }),
      ]);
    } catch (cause) {
      rethrowTeamWriteError(cause);
    }
    return (await this.getById(id))!;
  }

  /** With `audit`, the change and its `team.updated` row commit or roll back together. */
  async update(
    id: string,
    fields: {
      slug?: string;
      name?: string;
      description?: string | null;
      joinPolicy?: TeamJoinPolicy;
      defaultVisibility?: SessionVisibility;
      defaultEnvironmentId?: string | null;
    },
    audit?: TeamChangeAudit
  ): Promise<Team | null> {
    if (fields.defaultEnvironmentId !== undefined && fields.defaultEnvironmentId !== null) {
      const environment = await this.db
        .prepare("SELECT 1 AS ok FROM environments WHERE id = ? AND owner_team_id = ?")
        .bind(fields.defaultEnvironmentId, id)
        .first();
      if (!environment) throw new Error("Default environment must belong to the team");
    }
    const columns = {
      slug: fields.slug,
      name: fields.name,
      description: fields.description,
      join_policy: fields.joinPolicy,
      default_visibility: fields.defaultVisibility,
      default_environment_id: fields.defaultEnvironmentId,
    };
    const entries = Object.entries(columns).filter((entry) => entry[1] !== undefined);
    if (entries.length) {
      const now = Date.now();
      const statements = [
        this.db
          .prepare(
            `UPDATE teams SET ${entries.map(([key]) => `${key} = ?`).join(", ")}, updated_at = ? WHERE id = ?`
          )
          .bind(...entries.map((entry) => entry[1]), now, id),
      ];
      if (audit) {
        const changed = Object.entries(fields).filter((entry) => entry[1] !== undefined);
        statements.push(
          new TeamAuditStore(this.db).bind(
            {
              ...audit,
              teamId: id,
              action: "team.updated",
              after: { ...audit.before, ...Object.fromEntries(changed), updatedAt: now },
            },
            true
          )
        );
      }
      try {
        await this.db.batch(statements);
      } catch (cause) {
        rethrowTeamWriteError(cause);
      }
    }
    return this.getById(id);
  }

  async archive(id: string, audit?: TeamChangeAudit): Promise<boolean> {
    return await this.setArchived(id, Date.now(), audit);
  }

  async restore(id: string, audit?: TeamChangeAudit): Promise<boolean> {
    return await this.setArchived(id, null, audit);
  }

  /** With `audit`, the change and its `team.archived`/`team.restored` row commit or roll back together. */
  private async setArchived(
    id: string,
    archivedAt: number | null,
    audit?: TeamChangeAudit
  ): Promise<boolean> {
    const now = archivedAt ?? Date.now();
    const statements = [
      this.db
        .prepare(
          `UPDATE teams SET archived_at = ?, updated_at = ?
                 WHERE id = ? AND ${archivedAt === null ? "archived_at IS NOT NULL" : "archived_at IS NULL"}`
        )
        .bind(archivedAt, now, id),
    ];
    if (audit) {
      statements.push(
        new TeamAuditStore(this.db).bind(
          {
            ...audit,
            teamId: id,
            action: archivedAt === null ? "team.restored" : "team.archived",
            after: { ...audit.before, archivedAt, updatedAt: now },
          },
          true
        )
      );
    }
    const [result] = await this.db.batch(statements);
    return (result.meta.changes ?? 0) > 0;
  }

  async bumpGrantsVersion(id: string): Promise<number | null> {
    await this.db
      .prepare("UPDATE teams SET grants_version = grants_version + 1, updated_at = ? WHERE id = ?")
      .bind(Date.now(), id)
      .run();
    return (await this.getById(id))?.grantsVersion ?? null;
  }
}
