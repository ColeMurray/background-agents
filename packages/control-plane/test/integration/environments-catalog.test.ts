import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { EnvironmentStore } from "../../src/db/environments";
import { TeamMembershipStore } from "../../src/db/team-memberships";
import { TeamRepositoryGrantStore } from "../../src/db/team-repository-grants";
import { TeamStore } from "../../src/db/teams";
import { cleanD1Tables } from "./cleanup";
import { seedActiveUser, serviceFetch } from "./helpers";

const BASE = "https://test.local/environments";
const MEMBER = "22222222222222222222222222222222";
const OTHER = "33333333333333333333333333333333";

describe("team-scoped environment catalog", () => {
  let teamId: string;

  beforeEach(async () => {
    await cleanD1Tables();
    await seedActiveUser(MEMBER);
    await seedActiveUser(OTHER);
    teamId = (
      await new TeamStore(env.DB).create({
        slug: "engineering",
        name: "Engineering",
        joinPolicy: "invite_only",
      })
    ).id;
    await new TeamMembershipStore(env.DB).add(teamId, MEMBER);
    const targets: [string, (number | null)[]][] = [
      ["covered", [1]],
      ["denied", [2]],
      ["multi", [1, 2]],
      ["nullable", [null]],
      ["empty", []],
    ];
    for (const [name, repoIds] of targets) {
      await new EnvironmentStore(env.DB).create(
        {
          id: `env_${name}`,
          owner_team_id: name === "denied" ? teamId : null,
          name,
          description: null,
          prebuild_enabled: 0,
          channel_associations: null,
          created_at: 1,
          updated_at: 1,
        },
        repoIds.map((repoId, position) => ({
          position,
          repo_owner: "acme",
          repo_name: `repo-${repoId ?? 1}`,
          repo_id: repoId,
          base_branch: "main",
        }))
      );
    }
  });

  it("filters persisted refs without SCM configuration, and retains the workspace catalog", async () => {
    const scopedUrl = `${BASE}?teamId=${teamId}`;
    const member = { as: { userId: MEMBER, role: "member" as const } };
    const grants = new TeamRepositoryGrantStore(env.DB);
    expect(await (await serviceFetch(scopedUrl, member)).json()).toEqual({
      environments: [],
      total: 0,
    });
    const first = await grants.add(teamId, {
      kind: "repository",
      repoExternalId: 1,
      owner: "acme",
      name: "repo-1",
    });

    const response = await serviceFetch(scopedUrl, member);
    expect(response.status).toBe(200);
    const covered = await response.json<{
      environments: { id: string; repositories: { repoId: number | null }[] }[];
      total: number;
    }>();
    expect(covered.total).toBe(1);
    expect(covered.environments.map((row) => row.id)).toEqual(["env_covered"]);
    expect(covered.environments[0].repositories.map((repo) => repo.repoId)).toEqual([1]);
    expect(await (await serviceFetch(BASE, member)).json()).toMatchObject({ total: 5 });

    const second = await grants.add(teamId, {
      kind: "repository",
      repoExternalId: 2,
      owner: "acme",
      name: "repo-2",
    });
    const allNumeric = await (
      await serviceFetch(scopedUrl, member)
    ).json<{
      environments: { id: string }[];
      total: number;
    }>();
    expect(allNumeric.total).toBe(3);
    expect(allNumeric.environments.map((row) => row.id).sort()).toEqual([
      "env_covered",
      "env_denied",
      "env_multi",
    ]);

    await grants.remove(teamId, first.id);
    await grants.remove(teamId, second.id);
    await grants.add(teamId, { kind: "installation" });
    const installation = await (
      await serviceFetch(scopedUrl, member)
    ).json<{
      environments: { id: string }[];
      total: number;
    }>();
    expect(installation.total).toBe(4);
    expect(installation.environments.map((row) => row.id).sort()).toEqual([
      "env_covered",
      "env_denied",
      "env_multi",
      "env_nullable",
    ]);
  });

  it("audits concealed nonmember, missing, and archived scopes through the existing writer", async () => {
    const nonmember = { as: { userId: OTHER, role: "member" as const } };
    const responses = [
      await serviceFetch(`${BASE}?teamId=${teamId}`, nonmember),
      await serviceFetch(`${BASE}?teamId=team_missing`, nonmember),
    ];
    await new TeamStore(env.DB).archive(teamId);
    responses.push(
      await serviceFetch(`${BASE}?teamId=${teamId}`, {
        as: { userId: MEMBER, role: "member" },
      }),
      await serviceFetch(`${BASE}?teamId=${teamId}`)
    );
    for (const response of responses) {
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: "Team not found" });
    }

    const audit = await env.DB.prepare(
      "SELECT action, reason_code, operation_result, metadata_json, team_id FROM authorization_audit_events WHERE resource_id = '/environments' AND operation_result = 'denied'"
    ).all<{
      action: string;
      reason_code: string;
      operation_result: string;
      metadata_json: string;
      team_id: string;
    }>();
    expect(audit.results).toHaveLength(4);
    expect(audit.results.map((row) => row.team_id).sort()).toEqual(
      [teamId, "team_missing", teamId, teamId].sort()
    );
    for (const row of audit.results) {
      expect(row).toMatchObject({
        action: "authorization.request_denied",
        reason_code: "team_not_visible",
        operation_result: "denied",
      });
      expect(JSON.parse(row.metadata_json)).toMatchObject({
        httpMethod: "GET",
        httpPath: "/environments",
        httpStatus: 404,
        requirements: [{ kind: "team", teamIdParam: "teamId", need: "member" }],
      });
    }
  });
});
