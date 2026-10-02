import { createExecutionContext, env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TeamStore } from "../../src/db/teams";
import { TeamMembershipStore } from "../../src/db/team-memberships";
import { TeamRepositoryGrantStore } from "../../src/db/team-repository-grants";
import { EnvironmentStore } from "../../src/db/environments";
import { UserStore } from "../../src/db/user-store";
import { REPOS_CACHE_KEY, reposCacheIdentity } from "../../src/routes/repos";
import { GitHubSourceControlProvider } from "../../src/source-control/providers/github-provider";
import { cleanD1Tables } from "./cleanup";
import { routeRequest, seedActiveUser, serviceRequestHeaders } from "./helpers";

const MEMBER = "22222222222222222222222222222222";
const OTHER = "33333333333333333333333333333333";
const repos = [1, 2].map((id) => ({
  id,
  owner: "acme",
  name: `repo-${id}`,
  fullName: `acme/repo-${id}`,
  description: null,
  private: true,
  archived: false,
  defaultBranch: "main",
}));

async function request(path: string, method = "GET", body?: object, userId?: string) {
  const url = `https://test.local${path}`;
  const payload = body ? JSON.stringify(body) : undefined;
  const headers = await serviceRequestHeaders(url, {
    method,
    body: payload,
    ...(userId ? { as: { userId, role: "member" } } : {}),
  });
  return routeRequest(
    new Request(url, { method, headers, body: payload }),
    env,
    createExecutionContext()
  );
}

describe("team repository grants", () => {
  let teamId: string;
  beforeEach(async () => {
    await cleanD1Tables();
    await seedActiveUser(MEMBER);
    await seedActiveUser(OTHER);
    await request("/me/authorization");
    teamId = (
      await new TeamStore(env.DB).create({
        slug: "engineering",
        name: "Engineering",
        joinPolicy: "invite_only",
      })
    ).id;
    await new TeamMembershipStore(env.DB).add(teamId, MEMBER);
    await env.REPOS_CACHE.put(
      REPOS_CACHE_KEY,
      JSON.stringify({
        repos,
        cachedAt: "2026-10-01T00:00:00.000Z",
        freshUntil: Date.now() + 60_000,
        scmIdentity: await reposCacheIdentity(env),
      })
    );
    vi.spyOn(GitHubSourceControlProvider.prototype, "checkRepositoryAccess").mockImplementation(
      async ({ owner, name }) => ({
        repoId: Number(name.slice("repo-".length)),
        repoOwner: owner,
        repoName: name,
        defaultBranch: "main",
      })
    );
  });
  afterEach(() => vi.restoreAllMocks());

  it("filters a cached catalog by numeric grants while leaving the workspace list full", async () => {
    await new TeamRepositoryGrantStore(env.DB).add(teamId, {
      kind: "repository",
      repoExternalId: 1,
      owner: "acme",
      name: "repo-1",
    });
    const response = await request(`/repos?teamId=${teamId}`, "GET", undefined, MEMBER);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      repos: [repos[0]],
      teamHasRepositoryGrants: true,
    });
    expect(await (await request("/repos")).json()).toMatchObject({ repos });
  });

  it("serves the full installation catalog for an installation grant", async () => {
    await new TeamRepositoryGrantStore(env.DB).add(teamId, { kind: "installation" });
    expect(await (await request(`/repos?teamId=${teamId}`)).json()).toMatchObject({
      repos,
      teamHasRepositoryGrants: true,
    });
  });

  it("admits Slack catalogs with a current member actor and rechecks grants and membership", async () => {
    await new UserStore(env.DB).createIdentity({
      userId: MEMBER,
      provider: "slack",
      providerUserId: "U-CATALOG",
    });
    const grants = new TeamRepositoryGrantStore(env.DB);
    const grant = await grants.add(teamId, {
      kind: "repository",
      repoExternalId: 1,
      owner: "acme",
      name: "repo-1",
    });
    await new EnvironmentStore(env.DB).create(
      {
        id: "env_slack_catalog",
        owner_team_id: teamId,
        name: "Slack catalog",
        description: null,
        prebuild_enabled: 0,
        channel_associations: null,
        created_at: 1,
        updated_at: 1,
      },
      [{ position: 0, repo_owner: "acme", repo_name: "repo-1", repo_id: 1, base_branch: "main" }]
    );
    const read = async (path: string, actor = "slack:U-CATALOG") => {
      const url = `https://test.local${path}?teamId=${teamId}`;
      return routeRequest(
        new Request(url, {
          headers: await serviceRequestHeaders(url, {
            service: "slack-bot",
            actor: actor || undefined,
          }),
        }),
        env,
        createExecutionContext()
      );
    };
    const repoList = await read("/repos");
    expect(repoList.status).toBe(200);
    expect(await repoList.json()).toMatchObject({ repos: [repos[0]] });
    const environmentList = await read("/environments");
    expect(environmentList.status).toBe(200);
    expect(await environmentList.json()).toMatchObject({
      environments: [expect.objectContaining({ id: "env_slack_catalog" })],
    });
    for (const path of ["/repos", "/environments"]) {
      expect((await read(path, "")).status).toBe(404);
    }
    await grants.remove(teamId, grant.id);
    expect(await (await read("/repos")).json()).toMatchObject({ repos: [] });
    expect(await (await read("/environments")).json()).toMatchObject({ environments: [] });
    await new TeamMembershipStore(env.DB).remove(teamId, MEMBER);
    for (const path of ["/repos", "/environments"]) {
      expect((await read(path)).status).toBe(404);
    }
  });

  it("identifies a team with no grants without falling back to the installation list", async () => {
    expect(await (await request(`/repos?teamId=${teamId}`)).json()).toMatchObject({
      repos: [],
      teamHasRepositoryGrants: false,
    });
  });

  it.each(["/repos?teamId=", "/teams/"])("conceals a nonmember's %s grant read", async (prefix) => {
    const path =
      prefix === "/teams/" ? `${prefix}${teamId}/repository-grants` : `${prefix}${teamId}`;
    const response = await request(path, "GET", undefined, OTHER);
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: "Team not found" });
    const denial =
      prefix === "/repos?teamId="
        ? await env.DB.prepare(
            "SELECT action, reason_code FROM authorization_audit_events WHERE team_id = ? AND operation_result = 'denied'"
          )
            .bind(teamId)
            .all()
        : await env.DB.prepare(
            "SELECT action, reason_code FROM authorization_audit_events WHERE operation_result = 'denied'"
          ).all();
    expect(denial.results).toContainEqual({
      action: "authorization.request_denied",
      reason_code: "team_not_visible",
    });
  });

  it("audits missing teams identically to teams hidden from a nonmember", async () => {
    const visible = await request(`/teams/${teamId}/repository-grants`, "GET", undefined, OTHER);
    const missing = await request("/teams/team_missing/repository-grants", "GET", undefined, OTHER);
    expect(missing.status).toBe(visible.status);
    expect(await missing.json()).toEqual(await visible.json());
    const rows = await env.DB.prepare(
      "SELECT reason_code, operation_result FROM authorization_audit_events WHERE action = 'authorization.request_denied'"
    ).all();
    expect(rows.results).toHaveLength(2);
    expect(rows.results).toEqual([
      { reason_code: "team_not_visible", operation_result: "denied" },
      { reason_code: "team_not_visible", operation_result: "denied" },
    ]);
  });

  it("lets a member read without audit rows but refuses grant changes", async () => {
    const before = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM authorization_audit_events"
    ).first();
    const response = await request(`/teams/${teamId}/repository-grants`, "GET", undefined, MEMBER);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ grants: [] });
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS count FROM authorization_audit_events").first()
    ).toEqual(before);
    expect(
      (await request(`/teams/${teamId}/repository-grants`, "PUT", { kind: "installation" }, MEMBER))
        .status
    ).toBe(403);
  });

  it("adds and removes grants atomically with a version bump and before/after audit", async () => {
    const added = await request(`/teams/${teamId}/repository-grants`, "PUT", {
      kind: "repository",
      repoExternalId: 1,
      owner: "acme",
      name: "repo-1",
    });
    expect(added.status).toBe(200);
    const { grant } = await added.json<{ grant: { id: string } }>();
    expect((await new TeamStore(env.DB).getById(teamId))?.grantsVersion).toBe(1);
    expect((await request(`/teams/${teamId}/repository-grants/${grant.id}`, "DELETE")).status).toBe(
      204
    );
    expect((await new TeamStore(env.DB).getById(teamId))?.grantsVersion).toBe(2);
    const audit = await env.DB.prepare(
      "SELECT action, metadata_json FROM authorization_audit_events WHERE team_id = ? AND action IN ('team.grant_added', 'team.grant_removed') ORDER BY occurred_at, id"
    )
      .bind(teamId)
      .all<{ action: string; metadata_json: string }>();
    expect(audit.results.map((row) => row.action)).toEqual([
      "team.grant_added",
      "team.grant_removed",
    ]);
    expect(JSON.parse(audit.results[0].metadata_json)).toMatchObject({
      before: {},
      after: { id: grant.id },
    });
    expect(JSON.parse(audit.results[1].metadata_json)).toMatchObject({
      before: { id: grant.id },
      after: {},
    });
  });

  it("rejects a forged external repository ID before granting it", async () => {
    const response = await request(`/teams/${teamId}/repository-grants`, "PUT", {
      kind: "repository",
      repoExternalId: 99,
      owner: "acme",
      name: "repo-1",
    });
    expect(response.status).toBe(409);
    expect(await new TeamRepositoryGrantStore(env.DB).listForTeam(teamId)).toEqual([]);
  });

  it("lets a team lead manage grants without workspace administration", async () => {
    await new TeamMembershipStore(env.DB).setRole(teamId, MEMBER, "lead");
    const response = await request(
      `/teams/${teamId}/repository-grants`,
      "PUT",
      { kind: "installation" },
      MEMBER
    );
    expect(response.status).toBe(200);
    const { grant } = await response.json<{ grant: { id: string } }>();
    expect(
      (await request(`/teams/${teamId}/repository-grants/${grant.id}`, "DELETE", undefined, MEMBER))
        .status
    ).toBe(204);
  });

  it("refuses a 501st named grant at the API without changing the version", async () => {
    await env.DB.batch(
      Array.from({ length: 500 }, (_, index) =>
        env.DB.prepare(
          "INSERT INTO team_repository_grants (id, team_id, grant_kind, repo_external_id, repo_owner, repo_name, created_at) VALUES (?, ?, 'repository', ?, 'acme', ?, 1)"
        ).bind(`grant-${index}`, teamId, index + 1, `repo-${index + 1}`)
      )
    );
    const response = await request(`/teams/${teamId}/repository-grants`, "PUT", {
      kind: "repository",
      repoExternalId: 501,
      owner: "acme",
      name: "repo-501",
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "repository_grant_limit" });
    expect(await new TeamRepositoryGrantStore(env.DB).listForTeam(teamId)).toHaveLength(500);
    expect((await new TeamStore(env.DB).getById(teamId))?.grantsVersion).toBe(0);
  });

  it("denies session creation with an ungranted repository before creating a session", async () => {
    const response = await request(
      "/sessions",
      "POST",
      { teamId, repoOwner: "acme", repoName: "repo-2" },
      MEMBER
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: "target_team_missing_grant",
      repository: "acme/repo-2",
    });
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM sessions").first()).toEqual({
      count: 0,
    });
  });

  it("denies adding an ungranted repository to a team-owned environment without changing its members", async () => {
    const store = new EnvironmentStore(env.DB);
    await store.create(
      {
        id: "env_granted",
        owner_team_id: teamId,
        name: "Granted",
        description: null,
        prebuild_enabled: 0,
        channel_associations: null,
        created_at: 1,
        updated_at: 1,
      },
      [{ position: 0, repo_owner: "acme", repo_name: "repo-1", repo_id: 1, base_branch: "main" }]
    );
    await new TeamRepositoryGrantStore(env.DB).add(teamId, {
      kind: "repository",
      repoExternalId: 1,
      owner: "acme",
      name: "repo-1",
    });
    const response = await request("/environments/env_granted", "PUT", {
      repositories: [{ repoOwner: "acme", repoName: "repo-2" }],
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: "target_team_missing_grant",
      repository: "acme/repo-2",
    });
    expect(
      (await store.getRepositoriesForEnvironment("env_granted")).map((repo) => repo.repo_id)
    ).toEqual([1]);
  });
});
