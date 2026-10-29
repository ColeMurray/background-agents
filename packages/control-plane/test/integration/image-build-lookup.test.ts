import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { SessionIndexStore } from "../../src/db/session-index";
import { createImageBuildLookup } from "../../src/image-builds/lookup";
import { cleanD1Tables } from "./cleanup";
import { environmentScope, seedEnvironment, seedImageRowForScope } from "./image-build-helpers";

const TEAM_A = "team_a";
const TEAM_B = "team_b";
const SESSION_ID = "image-lookup-session";

describe("session-scoped environment image lookup", () => {
  beforeEach(async () => {
    await cleanD1Tables();
    await env.DB.prepare(
      "INSERT INTO teams (id, slug, name, created_at, updated_at) VALUES (?, ?, ?, 1, 1), (?, ?, ?, 1, 1)"
    )
      .bind(TEAM_A, "a", "A", TEAM_B, "b", "B")
      .run();
    await new SessionIndexStore(env.DB).create({
      id: SESSION_ID,
      ownerTeamId: TEAM_A,
      visibility: "team",
      title: null,
      repoOwner: "acme",
      repoName: "web",
      baseBranch: "main",
      model: "anthropic/claude-sonnet-4-6",
      reasoningEffort: null,
      status: "active",
      createdAt: 1,
      updatedAt: 1,
    });
  });

  async function readyEnvironment(ownerTeamId: string | null) {
    const environmentId = await seedEnvironment({ prebuildEnabled: true });
    await env.DB.prepare("UPDATE environments SET owner_team_id = ? WHERE id = ?")
      .bind(ownerTeamId, environmentId)
      .run();
    const scope = environmentScope(environmentId);
    await seedImageRowForScope(scope, {
      id: "ready-image",
      status: "ready",
      providerImageId: "artifact",
    });
    return scope;
  }

  it.each([TEAM_B, null])(
    "withholds a team's environment image from owner %s",
    async (sessionTeamId) => {
      const scope = await readyEnvironment(TEAM_A);
      await env.DB.prepare(
        "UPDATE sessions SET owner_team_id = ?, visibility = 'workspace' WHERE id = ?"
      )
        .bind(sessionTeamId, SESSION_ID)
        .run();
      const lookup = createImageBuildLookup(env.DB, "modal", () => SESSION_ID);
      expect(await lookup.getLatestReady(scope)).toBeNull();
    }
  );

  it("selects matching ownership and reevaluates it after a session moves", async () => {
    const scope = await readyEnvironment(TEAM_A);
    const lookup = createImageBuildLookup(env.DB, "modal", () => SESSION_ID);
    expect(await lookup.getLatestReady(scope)).toMatchObject({ id: "ready-image" });
    await env.DB.prepare("UPDATE sessions SET owner_team_id = ? WHERE id = ?")
      .bind(TEAM_B, SESSION_ID)
      .run();
    expect(await lookup.getLatestReady(scope)).toBeNull();
  });

  it("does not require a team match for a workspace environment with no team layer", async () => {
    const scope = await readyEnvironment(null);
    const lookup = createImageBuildLookup(env.DB, "modal", () => SESSION_ID);
    expect(await lookup.getLatestReady(scope)).toMatchObject({ id: "ready-image" });
  });

  it("fails closed when the authoritative session row is missing", async () => {
    const scope = await readyEnvironment(TEAM_A);
    const lookup = createImageBuildLookup(env.DB, "modal", () => "missing-session");
    expect(await lookup.getLatestReady(scope)).toBeNull();
  });
});
