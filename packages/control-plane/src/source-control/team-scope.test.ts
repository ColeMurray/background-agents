import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createNodeSqlDatabase, type NodeSqlDatabase } from "../node/sqlite-database";
import { resolveTeamTokenScope } from "./team-scope";

describe("resolveTeamTokenScope", () => {
  let db: NodeSqlDatabase;

  beforeEach(async () => {
    db = createNodeSqlDatabase(new DatabaseSync(":memory:"));
    await db
      .prepare(
        "CREATE TABLE team_repository_grants (team_id TEXT, grant_kind TEXT, repo_external_id INTEGER)"
      )
      .run();
  });

  afterEach(() => db.close());

  async function grant(teamId: string, repositoryId: number | null): Promise<void> {
    await db
      .prepare("INSERT INTO team_repository_grants VALUES (?, ?, ?)")
      .bind(teamId, repositoryId === null ? "installation" : "repository", repositoryId)
      .run();
  }

  it("keeps workspace credentials installation-wide without reading grants", async () => {
    await db.prepare("DROP TABLE team_repository_grants").run();
    expect(await resolveTeamTokenScope(db, null)).toEqual({ kind: "all" });
  });

  it("uses an installation grant for installation-wide credentials", async () => {
    await grant("team_a", 12);
    await grant("team_a", null);
    expect(await resolveTeamTokenScope(db, "team_a")).toEqual({ kind: "all" });
  });

  it("returns only the team's sorted, de-duplicated repository grants", async () => {
    await grant("team_a", 30);
    await grant("team_b", 99);
    await grant("team_a", 2);
    await grant("team_a", 30);
    expect(await resolveTeamTokenScope(db, "team_a")).toEqual({
      kind: "repositories",
      repositoryIds: [2, 30],
    });
  });

  it("returns an empty scope rather than installation access when no grants exist", async () => {
    expect(await resolveTeamTokenScope(db, "team_missing")).toEqual({
      kind: "repositories",
      repositoryIds: [],
    });
  });

  it("refuses a malformed repository grant instead of broadening its scope", async () => {
    await db
      .prepare("INSERT INTO team_repository_grants VALUES (?, 'repository', NULL)")
      .bind("team_a")
      .run();
    await expect(resolveTeamTokenScope(db, "team_a")).rejects.toThrow();
  });
});
