import { DatabaseSync } from "node:sqlite";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyMigrations } from "../node/migrate";
import { createNodeSqlDatabase, type NodeSqlDatabase } from "../node/sqlite-database";
import { resolveManagedSkills } from "../session/skill-resolution";
import { resolvedPin } from "../session/pinned";
import { SessionIndexStore } from "./session-index";
import { SessionSkillStore } from "./session-skills";
import { SkillProfileStore } from "./skill-profiles";
import type { SqlDatabase, SqlStatement } from "./sql-database";

let engine: NodeSqlDatabase;
beforeEach(() => {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  applyMigrations(
    sqlite,
    resolve(dirname(fileURLToPath(import.meta.url)), "../../../../terraform/d1/migrations")
  );
  engine = createNodeSqlDatabase(sqlite);
});
afterEach(() => engine.close());

// Count statements, including every member of a batch. Local SQLite/workerd
// do not enforce the hosted per-invocation D1 query budget.
function withQueryBudget(db: SqlDatabase) {
  let queries = 0;
  function charge(count: number) {
    queries += count;
    if (queries > 1000) throw new Error(`D1 invocation query budget exceeded: ${queries}`);
  }
  const originals = new WeakMap<SqlStatement, SqlStatement>();
  const wrap = (statement: SqlStatement): SqlStatement => {
    const wrapped: SqlStatement = {
      bind: (...values) => wrap(statement.bind(...values)),
      first: async <T>() => {
        charge(1);
        return statement.first<T>();
      },
      all: async <T>() => {
        charge(1);
        return statement.all<T>();
      },
      run: async <T>() => {
        charge(1);
        return statement.run<T>();
      },
    };
    originals.set(wrapped, statement);
    return wrapped;
  };
  const database: SqlDatabase = {
    ...db,
    prepare: (query) => wrap(db.prepare(query)),
    batch: async (statements) => {
      charge(statements.length);
      return db.batch(statements.map((s) => originals.get(s) ?? s));
    },
  };
  return { db: database, queries: () => queries };
}

async function seedCatalog(count: number): Promise<string[]> {
  await engine
    .prepare(
      `WITH RECURSIVE ids(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM ids WHERE n < ?)
     INSERT INTO skills (id, name, enabled, created_by, updated_by, created_at, updated_at)
     SELECT 'skill_' || n, 'skill-' || n, 1, 'user_1', 'user_1', 1, 1 FROM ids`
    )
    .bind(count)
    .run();
  await engine
    .prepare(
      `INSERT INTO skill_revisions
     (id, skill_id, revision_number, revision_sha256, description, body, total_bytes, created_by, created_at)
     SELECT 'rev_' || id, id, 1, ?, 'Description', '# Instructions', 32, 'user_1', 1 FROM skills`
    )
    .bind("a".repeat(64))
    .run();
  await engine.prepare("UPDATE skills SET current_revision_id = 'rev_' || id").run();
  await engine
    .prepare(
      `INSERT INTO skill_assignments (id, skill_id, scope_type, created_by, created_at)
     SELECT 'assignment_' || id, id, 'global', 'user_1', 1 FROM skills`
    )
    .run();
  return (
    await engine.prepare("SELECT id FROM skills ORDER BY id").all<{ id: string }>()
  ).results.map(({ id }) => id);
}

describe("managed-skill set persistence query budget", () => {
  it.each([
    { count: 1, queries: 7 },
    { count: 101, queries: 7 },
    { count: 9041, queries: 7 },
    { count: 18082, queries: 8 },
  ])("resolves and pins $count skills with $queries statements", async ({ count, queries }) => {
    await seedCatalog(count);
    const budget = withQueryBudget(engine);
    const manifest = await resolveManagedSkills(
      budget.db,
      { repositories: [], environmentId: null },
      { mode: "all" },
      "user_1"
    );
    expect(manifest.skills).toHaveLength(count);
    const session = {
      id: "wide",
      title: null,
      ownerTeamId: null,
      visibility: "workspace" as const,
      repoOwner: null,
      repoName: null,
      model: "anthropic/claude-haiku-4-5",
      reasoningEffort: null,
      baseBranch: null,
      status: "created" as const,
      createdAt: 1,
      updatedAt: 1,
      managedSkills: resolvedPin(manifest),
    };
    const sessions = new SessionIndexStore(budget.db);
    await sessions.create(session);
    expect(budget.queries()).toBe(queries);
    const pinned = await new SessionSkillStore(engine).getSessionSkillsView("wide");
    expect(pinned?.skills.map((skill) => skill.skillId)).toEqual(
      manifest.skills.map((s) => s.skillId)
    );
    expect(pinned?.skills[0].assignmentSources).toEqual(manifest.skills[0].assignmentSources);

    // The invalid revision is in the final payload chunk. The largest case
    // spans multiple chunks; earlier rows and both headers must roll back.
    await expect(
      sessions.create({
        ...session,
        id: "rolled-back",
        managedSkills: resolvedPin({
          ...manifest,
          skills: manifest.skills.map((skill, index) =>
            index === manifest.skills.length - 1 ? { ...skill, revisionId: "missing" } : skill
          ),
        }),
      })
    ).rejects.toThrow(/foreign key/i);
    for (const table of ["sessions", "session_skill_manifests", "session_skill_revisions"]) {
      const key = table === "sessions" ? "id" : "session_id";
      expect(
        await engine
          .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${key} = ?`)
          .bind("rolled-back")
          .first()
      ).toEqual({ n: 0 });
    }
  });

  it.each([
    { count: 1, queries: 4 },
    { count: 101, queries: 4 },
    { count: 33251, queries: 5 },
  ])(
    "validates and persists $count profile members with $queries statements",
    async ({ count, queries }) => {
      const ids = await seedCatalog(count);
      const budget = withQueryBudget(engine);
      const profile = await new SkillProfileStore(budget.db).create("user_1", "Everything", ids);
      expect(budget.queries()).toBe(queries);
      expect(
        (await new SkillProfileStore(engine).getOwned(profile.id, "user_1"))?.skillIds
      ).toEqual(ids);
    }
  );
});
