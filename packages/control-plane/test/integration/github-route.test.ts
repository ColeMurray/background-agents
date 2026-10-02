import { SELF, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { UserStore } from "../../src/db/user-store";
import { TeamStore } from "../../src/db/teams";
import { TeamMembershipStore } from "../../src/db/team-memberships";
import { TeamRepositoryGrantStore } from "../../src/db/team-repository-grants";
import { SessionIndexStore } from "../../src/db/session-index";
import { SessionPullRequestStore } from "../../src/db/session-pull-request-store";
import { cleanD1Tables } from "./cleanup";
import { serviceFetch, serviceRequestHeaders } from "./helpers";

const BASE = "https://test.local";
const REPOSITORY_ID = 12345;
const SENDER = "github:101";
const WORKSPACE = { teamId: null, via: "workspace" };
let senderUserId: string;

function lookup(query = `repositoryId=${REPOSITORY_ID}&sender=${SENDER}`) {
  return serviceFetch(`${BASE}/github/route?${query}`, { service: "github-bot" });
}

async function expectRoute(query: string, result: { teamId: string | null; via: string }) {
  const response = await lookup(query);
  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  await expect(response.json()).resolves.toEqual(result);
}

async function team(slug: string, grant: "repository" | "installation" | null = "repository") {
  const value = await new TeamStore(env.DB).create({ slug, name: slug, joinPolicy: "open" });
  await new TeamMembershipStore(env.DB).add(value.id, senderUserId);
  if (grant) {
    await new TeamRepositoryGrantStore(env.DB).add(
      value.id,
      grant === "installation"
        ? { kind: "installation" }
        : {
            kind: "repository",
            repoExternalId: REPOSITORY_ID,
            owner: "old-owner",
            name: "old-name",
          }
    );
  }
  return value.id;
}

async function session(
  id: string,
  teamId: string | null,
  createdAt = 1,
  repositoryId: number | null = REPOSITORY_ID,
  userId = senderUserId,
  visibility: "team" | "workspace" | "private" = teamId ? "team" : "workspace"
) {
  await new SessionIndexStore(env.DB).create({
    id,
    title: "Do not expose this session title",
    repoOwner: "old-owner",
    repoName: "old-name",
    model: "anthropic/claude-haiku-4-5",
    reasoningEffort: null,
    baseBranch: "main",
    status: "completed",
    ownerTeamId: teamId,
    visibility,
    userId,
    createdAt,
    updatedAt: createdAt,
    repositories: [
      { repoOwner: "old-owner", repoName: "old-name", repoId: repositoryId, baseBranch: "main" },
    ],
  });
}

async function pullRequest(sessionId: string, repositoryId: string | null = String(REPOSITORY_ID)) {
  await new SessionPullRequestStore(env.DB).upsert({
    artifactId: `pr-${sessionId}`,
    sessionId,
    repositoryExternalId: repositoryId,
    repoOwner: "old-owner",
    repoName: "old-name",
    prNumber: 7,
    url: "https://github.com/old-owner/old-name/pull/7",
    lifecycleState: "open",
    isDraft: false,
    headBranch: "feature",
    baseBranch: "main",
    headSha: null,
    providerCreatedAt: null,
    providerUpdatedAt: null,
    mergedAt: null,
    closedAt: null,
    createdAt: 1,
    updatedAt: 1,
  });
}

async function counts() {
  const rows = await env.DB.batch(
    ["users", "user_identities", "user_role_assignments", "sessions", "team_memberships"].map(
      (table) => env.DB.prepare(`SELECT COUNT(*) AS count FROM ${table}`)
    )
  );
  return rows.map((row) => row.results);
}

describe("GET /github/route", () => {
  beforeEach(async () => {
    await cleanD1Tables();
    const sender = await new UserStore(env.DB).resolveOrCreateUser({
      provider: "github",
      providerUserId: "101",
      providerLogin: "renamed-sender",
    });
    senderUserId = sender.id;
  });

  it("keeps auto-review workspace-level without a sender or pull number", async () => {
    const teamId = await team("auto-review");
    await session("linked", teamId);
    await pullRequest("linked");
    await expectRoute(`repositoryId=${REPOSITORY_ID}`, WORKSPACE);
  });

  it("prioritizes numeric PR linkage over the sender's granted memberships", async () => {
    const linkedTeam = await team("linked", null);
    await new TeamMembershipStore(env.DB).remove(linkedTeam, senderUserId);
    await team("sender");
    await session("linked", linkedTeam);
    await pullRequest("linked");
    await expectRoute(`repositoryId=${REPOSITORY_ID}&pullNumber=7&sender=${SENDER}`, {
      teamId: linkedTeam,
      via: "pull_request_session",
    });
  });

  it("resolves a PR without a sender and never exposes private session details", async () => {
    const teamId = await team("private-pr");
    await session("private-linked", teamId, 1, REPOSITORY_ID, senderUserId, "private");
    await pullRequest("private-linked");
    await expectRoute(`repositoryId=${REPOSITORY_ID}&pullNumber=7`, {
      teamId,
      via: "pull_request_session",
    });
    const details = await serviceFetch(`${BASE}/sessions/private-linked`, {
      service: "github-bot",
    });
    expect(details.status).toBe(403);
  });

  it("preserves a linked workspace session instead of falling through to membership", async () => {
    await team("sender");
    await session("workspace-linked", null);
    await pullRequest("workspace-linked");
    await expectRoute(`repositoryId=${REPOSITORY_ID}&pullNumber=7&sender=${SENDER}`, {
      teamId: null,
      via: "pull_request_session",
    });
  });

  it("does not confuse the same PR number in another numeric repository", async () => {
    const teamId = await team("sender");
    const otherTeam = await team("other", null);
    await session("other-linked", otherTeam);
    await pullRequest("other-linked", "99999");
    await expectRoute(`repositoryId=${REPOSITORY_ID}&pullNumber=7&sender=${SENDER}`, {
      teamId,
      via: "sender_membership",
    });
  });

  it("does not treat an owner/name-only legacy PR as numeric linkage", async () => {
    const teamId = await team("legacy", null);
    await session("legacy-linked", teamId);
    await pullRequest("legacy-linked", null);
    await expectRoute(`repositoryId=${REPOSITORY_ID}&pullNumber=7`, WORKSPACE);
  });

  it("falls back to membership when the requested pull number is not linked", async () => {
    const teamId = await team("sender");
    await session("linked", null);
    await pullRequest("linked");
    await expectRoute(`repositoryId=${REPOSITORY_ID}&pullNumber=8&sender=${SENDER}`, {
      teamId,
      via: "sender_membership",
    });
  });

  it("resolves exactly one active granted membership by numeric GitHub identity", async () => {
    const teamId = await team("sender");
    await team("not-granted", null);
    await expectRoute(`repositoryId=${REPOSITORY_ID}&sender=${SENDER}`, {
      teamId,
      via: "sender_membership",
    });
  });

  it("returns workspace for an unknown sender without enrolling or writing sessions", async () => {
    await team("sender");
    const before = await counts();
    await expectRoute(`repositoryId=${REPOSITORY_ID}&sender=github:404`, WORKSPACE);
    expect(await counts()).toEqual(before);
  });

  it("does not resolve a numeric sender through a matching login or another provider", async () => {
    await env.DB.prepare("UPDATE user_identities SET provider_login = '404' WHERE user_id = ?")
      .bind(senderUserId)
      .run();
    await new UserStore(env.DB).createIdentity({
      userId: senderUserId,
      provider: "slack",
      providerUserId: "404",
    });
    await team("sender");
    await expectRoute(`repositoryId=${REPOSITORY_ID}&sender=github:404`, WORKSPACE);
  });

  it("returns workspace when the sender has no granted memberships", async () => {
    await team("not-granted", null);
    await expectRoute(`repositoryId=${REPOSITORY_ID}&sender=${SENDER}`, WORKSPACE);
  });

  it("returns workspace for multiple granted memberships with no recent session", async () => {
    await team("one");
    await team("two");
    await expectRoute(`repositoryId=${REPOSITORY_ID}&sender=${SENDER}`, WORKSPACE);
  });

  it("returns workspace when multiple memberships have sessions only in other repositories", async () => {
    const first = await team("one");
    const second = await team("two");
    await session("other-repository", first, 10, 99999);
    await session("unknown-repository", second, 20, null);
    await expectRoute(`repositoryId=${REPOSITORY_ID}&sender=${SENDER}`, WORKSPACE);
  });

  it("chooses the sender's most recently created session among granted active memberships", async () => {
    const first = await team("one");
    const recent = await team("two");
    const ungranted = await team("ungranted", null);
    const nonmember = await team("nonmember");
    await new TeamMembershipStore(env.DB).remove(nonmember, senderUserId);
    await session("old", first, 10);
    await session("recent", recent, 20);
    await session("wrong-repo", first, 30, 99999);
    await session("ungranted", ungranted, 40);
    await session("nonmember", nonmember, 50);
    await session("another-user", first, 60, REPOSITORY_ID, "another-user");
    await session("workspace", null, 70);
    await env.DB.prepare("UPDATE sessions SET updated_at = 100 WHERE id = 'old'").run();
    await expectRoute(`repositoryId=${REPOSITORY_ID}&sender=${SENDER}`, {
      teamId: recent,
      via: "sender_membership",
    });
  });

  it("matches a secondary numeric repository in a multi-repository session", async () => {
    const teamId = await team("one");
    await team("two");
    await session("multi", teamId, 20, 99999);
    await env.DB.prepare(
      "INSERT INTO session_repositories (session_id, position, repo_owner, repo_name, repo_id, base_branch) VALUES ('multi', 1, 'new-owner', 'new-name', ?, 'main')"
    )
      .bind(REPOSITORY_ID)
      .run();
    await expectRoute(`repositoryId=${REPOSITORY_ID}&sender=${SENDER}`, {
      teamId,
      via: "sender_membership",
    });
  });

  it("does not use display-only legacy session repositories for the tie-breaker", async () => {
    const teamId = await team("one");
    await team("two");
    await session("unknown-id", teamId, 20, null);
    await session("scalar-display-only", teamId, 30);
    await env.DB.prepare(
      "DELETE FROM session_repositories WHERE session_id = 'scalar-display-only'"
    ).run();
    await expectRoute(`repositoryId=${REPOSITORY_ID}&sender=${SENDER}`, WORKSPACE);
  });

  it("includes installation grants", async () => {
    const teamId = await team("installation", "installation");
    await expectRoute("repositoryId=99999&sender=github:101", {
      teamId,
      via: "sender_membership",
    });
  });

  it("stops routing through a revoked grant despite a recent session", async () => {
    const teamId = await team("revoked");
    await session("recent", teamId, 20);
    const grants = new TeamRepositoryGrantStore(env.DB);
    const [grant] = await grants.listDetailsForTeam(teamId);
    await grants.remove(teamId, grant.id);
    await expectRoute(`repositoryId=${REPOSITORY_ID}&sender=${SENDER}`, WORKSPACE);
  });

  it("excludes archived teams when counting eligible memberships", async () => {
    const archived = await team("archived");
    const active = await team("active");
    await session("archived-recent", archived, 20);
    await env.DB.prepare("UPDATE teams SET archived_at = 1 WHERE id = ?").bind(archived).run();
    await expectRoute(`repositoryId=${REPOSITORY_ID}&sender=${SENDER}`, {
      teamId: active,
      via: "sender_membership",
    });
    await env.DB.prepare("UPDATE teams SET archived_at = 1 WHERE id = ?").bind(active).run();
    await expectRoute(`repositoryId=${REPOSITORY_ID}&sender=${SENDER}`, WORKSPACE);
  });

  it("keeps routing by numeric ID after repository rename or transfer", async () => {
    const teamId = await team("renamed");
    await session("renamed-linked", teamId);
    await pullRequest("renamed-linked");
    await env.DB.prepare(
      "UPDATE session_pull_requests SET repo_owner = 'new-owner', repo_name = 'new-name' WHERE session_id = 'renamed-linked'"
    ).run();
    await expectRoute(`repositoryId=${REPOSITORY_ID}&pullNumber=7&sender=${SENDER}`, {
      teamId,
      via: "pull_request_session",
    });
    await expectRoute(`repositoryId=${REPOSITORY_ID}&sender=${SENDER}`, {
      teamId,
      via: "sender_membership",
    });
    await expectRoute(`repositoryId=99999&sender=${SENDER}`, WORKSPACE);
  });

  it.each(["slack-bot", "linear-bot", "web"] as const)("rejects actorless %s", async (service) => {
    const response = await serviceFetch(`${BASE}/github/route?repositoryId=${REPOSITORY_ID}`, {
      service,
    });
    expect(response.status).toBe(403);
  });

  it.each(["github-bot", "slack-bot", "linear-bot"] as const)(
    "rejects actor-bearing %s before enrolling an identity",
    async (service) => {
      const before = await counts();
      const response = await serviceFetch(`${BASE}/github/route?repositoryId=${REPOSITORY_ID}`, {
        service,
        actor: `${service.replace("-bot", "")}:202`,
      });
      expect(response.status).toBe(403);
      expect(await counts()).toEqual(before);
    }
  );

  it("rejects a known GitHub actor without changing users, memberships, or sessions", async () => {
    await team("sender");
    const before = await counts();
    const response = await serviceFetch(`${BASE}/github/route?repositoryId=${REPOSITORY_ID}`, {
      service: "github-bot",
      actor: SENDER,
    });
    expect(response.status).toBe(403);
    expect(await counts()).toEqual(before);
  });

  it("rejects browser cookies without a service signature", async () => {
    const url = `${BASE}/github/route?repositoryId=${REPOSITORY_ID}`;
    const headers = await serviceRequestHeaders(url);
    const response = await SELF.fetch(url, { headers: { Cookie: headers.Cookie } });
    expect(response.status).toBe(401);
  });

  it("requires a signature over the repository, pull number, and sender", async () => {
    const url = `${BASE}/github/route?repositoryId=${REPOSITORY_ID}&pullNumber=7&sender=${SENDER}`;
    expect((await SELF.fetch(url)).status).toBe(401);
    const headers = await serviceRequestHeaders(url, { service: "github-bot" });
    for (const query of [
      `repositoryId=99999&pullNumber=7&sender=${SENDER}`,
      `repositoryId=${REPOSITORY_ID}&pullNumber=8&sender=${SENDER}`,
      `repositoryId=${REPOSITORY_ID}&pullNumber=7&sender=github:202`,
    ]) {
      expect((await SELF.fetch(`${BASE}/github/route?${query}`, { headers })).status).toBe(401);
    }
  });

  it.each([
    "",
    "repositoryId=",
    "repositoryId=abc",
    "repositoryId=-1",
    "repositoryId=0",
    "repositoryId=1.5",
    "repositoryId=1e3",
    "repositoryId=%2012345",
    "repositoryId=9007199254740992",
    "repositoryId=12345&repositoryId=99999",
    "repositoryId=12345&pullNumber=",
    "repositoryId=12345&pullNumber=0",
    "repositoryId=12345&pullNumber=-1",
    "repositoryId=12345&pullNumber=1.5",
    "repositoryId=12345&pullNumber=1e3",
    "repositoryId=12345&pullNumber=9007199254740992",
    "repositoryId=12345&pullNumber=7&pullNumber=8",
    "repositoryId=12345&sender=",
    "repositoryId=12345&sender=github:",
    "repositoryId=12345&sender=github:renamed-sender",
    "repositoryId=12345&sender=slack:101",
    "repositoryId=12345&sender=github:-1",
    "repositoryId=12345&sender=github:1.5",
    "repositoryId=12345&sender=github:101&sender=github:202",
  ])("rejects invalid input %s without creating users or sessions", async (query) => {
    const before = await counts();
    const response = await lookup(query);
    expect(response.status).toBe(400);
    expect(await counts()).toEqual(before);
  });
});
