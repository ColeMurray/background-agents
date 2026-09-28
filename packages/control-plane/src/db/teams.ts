import {
  teamRowSchema,
  type Team,
  type TeamJoinPolicy,
  type SessionVisibility,
} from "@open-inspect/shared/types/teams";
import { generateId } from "../auth/crypto";
import { isUniqueConstraintError } from "./errors";
import { TeamAuditStore } from "./team-audit";
import type { SqlDatabase, SqlStatement } from "./sql-database";

export class TeamSlugConflictError extends Error {
  constructor() {
    super("Team slug already exists");
    this.name = "TeamSlugConflictError";
  }
}

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

  async isActive(id: string): Promise<boolean> {
    return (
      (await this.db
        .prepare("SELECT 1 AS ok FROM teams WHERE id = ? AND archived_at IS NULL")
        .bind(id)
        .first()) !== null
    );
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

  async update(
    id: string,
    fields: {
      slug?: string;
      name?: string;
      description?: string | null;
      joinPolicy?: TeamJoinPolicy;
      defaultVisibility?: SessionVisibility;
      defaultEnvironmentId?: string | null;
    }
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
      try {
        await this.db
          .prepare(
            `UPDATE teams SET ${entries.map(([key]) => `${key} = ?`).join(", ")}, updated_at = ? WHERE id = ?`
          )
          .bind(...entries.map((entry) => entry[1]), Date.now(), id)
          .run();
      } catch (cause) {
        rethrowTeamWriteError(cause);
      }
    }
    return this.getById(id);
  }

  async archive(id: string): Promise<boolean> {
    return await this.setArchived(id, Date.now());
  }

  async restore(id: string): Promise<boolean> {
    return await this.setArchived(id, null);
  }

  private async setArchived(id: string, archivedAt: number | null): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE teams SET archived_at = ?, updated_at = ?
                 WHERE id = ? AND ${archivedAt === null ? "archived_at IS NOT NULL" : "archived_at IS NULL"}`
      )
      .bind(archivedAt, Date.now(), id)
      .run();
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
