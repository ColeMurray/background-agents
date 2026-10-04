import { DatabaseSync } from "node:sqlite";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyMigrations } from "../node/migrate";
import { createNodeSqlDatabase, type NodeSqlDatabase } from "../node/sqlite-database";
import { TeamStore } from "./teams";
import { TeamRepositoryGrantStore } from "./team-repository-grants";

describe("team repository grant writes", () => {
  let db: NodeSqlDatabase;
  let store: TeamRepositoryGrantStore;
  let teamId: string;

  beforeEach(async () => {
    const sqlite = new DatabaseSync(":memory:");
    applyMigrations(
      sqlite,
      resolve(dirname(fileURLToPath(import.meta.url)), "../../../../terraform/d1/migrations")
    );
    db = createNodeSqlDatabase(sqlite);
    store = new TeamRepositoryGrantStore(db);
    teamId = (
      await new TeamStore(db).create({
        slug: "engineering",
        name: "Engineering",
        joinPolicy: "invite_only",
      })
    ).id;
  });
  afterEach(() => db.close());

  const named = (repoExternalId = 1) => ({
    kind: "repository" as const,
    repoExternalId,
    owner: "acme",
    name: `repo-${repoExternalId}`,
  });

  it("adds display-ready grants and bumps the version only for actual writes", async () => {
    const grant = await store.add(teamId, named());
    expect(grant).toMatchObject({
      teamId,
      kind: "repository",
      repoExternalId: 1,
      owner: "acme",
      name: "repo-1",
    });
    expect((await new TeamStore(db).getById(teamId))?.grantsVersion).toBe(1);
    expect(await store.add(teamId, named())).toEqual(grant);
    expect((await new TeamStore(db).getById(teamId))?.grantsVersion).toBe(1);
    expect(await store.remove(teamId, grant.id)).toBe(true);
    expect((await new TeamStore(db).getById(teamId))?.grantsVersion).toBe(2);
    expect(await store.remove(teamId, grant.id)).toBe(false);
    expect((await new TeamStore(db).getById(teamId))?.grantsVersion).toBe(2);
  });

  it.each(["installation", "repository"] as const)(
    "refuses mixing %s with the other grant kind",
    async (kind) => {
      await store.add(teamId, kind === "installation" ? { kind } : named());
      await expect(
        store.add(teamId, kind === "installation" ? named() : { kind: "installation" })
      ).rejects.toThrow("Remove the existing grants before changing grant kind");
      expect((await new TeamStore(db).getById(teamId))?.grantsVersion).toBe(1);
    }
  );

  it("refuses the 501st named grant, including concurrent additions at the cap", async () => {
    await db.batch(
      Array.from({ length: 499 }, (_, i) =>
        db
          .prepare(
            "INSERT INTO team_repository_grants (id, team_id, grant_kind, repo_external_id, repo_owner, repo_name, created_at) VALUES (?, ?, 'repository', ?, 'acme', ?, 1)"
          )
          .bind(`grant-${i}`, teamId, i + 1, `repo-${i + 1}`)
      )
    );
    const results = await Promise.allSettled([
      store.add(teamId, named(500)),
      store.add(teamId, named(501)),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(await store.listForTeam(teamId)).toHaveLength(500);
    expect((await new TeamStore(db).getById(teamId))?.grantsVersion).toBe(1);
  });

  it("validates the discriminated request before writing", async () => {
    await expect(store.add(teamId, { ...named(), repoExternalId: -1 })).rejects.toThrow();
    expect(await store.listForTeam(teamId)).toEqual([]);
    expect((await new TeamStore(db).getById(teamId))?.grantsVersion).toBe(0);
  });

  it("does not delete another team's grant", async () => {
    const grant = await store.add(teamId, named());
    const other = await new TeamStore(db).create({
      slug: "other",
      name: "Other",
      joinPolicy: "open",
    });
    expect(await store.remove(other.id, grant.id)).toBe(false);
    expect((await new TeamStore(db).getById(other.id))?.grantsVersion).toBe(0);
    expect(await store.covers(teamId, [1])).toBe(true);
    expect(await store.covers(teamId, [null])).toBe(false);
  });

  it("does not mutate grants on an archived team", async () => {
    const grant = await store.add(teamId, named());
    await new TeamStore(db).archive(teamId);
    expect(await store.remove(teamId, grant.id)).toBe(false);
    await expect(store.add(teamId, named(2))).rejects.toThrow("Team is not active");
    expect(await store.covers(teamId, [1])).toBe(true);
    expect((await new TeamStore(db).getById(teamId))?.grantsVersion).toBe(1);
  });

  it("covers unresolved repository rows only with an installation grant", async () => {
    await store.add(teamId, { kind: "installation" });
    expect(await store.covers(teamId, [null, 2])).toBe(true);
  });

  it("leaves repositories workspace-level when no grant names them", async () => {
    expect(await store.listTeamsForRepository(1)).toEqual([]);
    await store.add(teamId, named(2));
    expect(await store.listTeamsForRepository(1)).toEqual([]);
    expect(await store.listTeamsForRepository(2)).toEqual([teamId]);
  });

  it("finds every granting team by numeric identity, including installation grants", async () => {
    const other = await new TeamStore(db).create({
      slug: "other",
      name: "Other",
      joinPolicy: "open",
    });
    await store.add(teamId, named(1));
    await store.add(other.id, { kind: "installation" });
    expect(await store.listTeamsForRepository(1)).toEqual([other.id, teamId].sort());
    expect(await store.listTeamsForRepository(999)).toEqual([other.id]);
  });

  it("does not turn a retained archived-team grant into workspace-wide access", async () => {
    await store.add(teamId, named(1));
    await new TeamStore(db).archive(teamId);
    expect(await store.listTeamsForRepository(1)).toEqual([teamId]);
  });

  it("rolls mutation, version and domain audit back together", async () => {
    const failingStore = new TeamRepositoryGrantStore({
      prepare: (sql) => db.prepare(sql),
      batch: (statements) =>
        db.batch([...statements, db.prepare("INSERT INTO missing_table VALUES (1)")]),
    });
    await expect(
      failingStore.add(teamId, named(), { actorUserId: "actor", requestId: "request" })
    ).rejects.toThrow();
    expect(await store.listForTeam(teamId)).toEqual([]);
    expect((await new TeamStore(db).getById(teamId))?.grantsVersion).toBe(0);
    expect(
      await db
        .prepare(
          "SELECT COUNT(*) AS count FROM authorization_audit_events WHERE action = 'team.grant_added'"
        )
        .first()
    ).toEqual({ count: 0 });
  });
});
