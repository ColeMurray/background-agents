import { createExecutionContext, env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryStore } from "../../src/db/memories";
import { SessionIndexStore } from "../../src/db/session-index";
import { SessionCollaboratorStore } from "../../src/db/session-collaborators";
import { resolveSessionMemory } from "../../src/session/memory-resolution";
import { GitHubSourceControlProvider } from "../../src/source-control/providers/github-provider";
import { cleanD1Tables } from "./cleanup";
import { initNamedSessionDO, routeRequest, seedActiveUser, seedSandboxAuthHash } from "./helpers";
import {
  assignCustomRole,
  ownershipRequest,
  seedEnvironment,
  seedGrant,
  seedTeam,
} from "./ownership-test-helpers";

const MEMBER = "22222222222222222222222222222222";
const OUTSIDER = "33333333333333333333333333333333";
const repo = { repoOwner: "acme/group", repoName: "api", repoId: 123, baseBranch: "main" };
const content = {
  memoryType: "fact" as const,
  title: "Deploy setup",
  description: "How deployment works",
  content: "Use the staging environment",
};
const actor = { kind: "user" as const, userId: MEMBER, requestId: "setup" };
const request = (path: string, method = "GET", body?: unknown, userId = MEMBER) =>
  ownershipRequest(path, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    as: { userId, role: "member" },
  });

describe("memory shared-scope authorization", () => {
  beforeEach(async () => {
    await cleanD1Tables();
    for (const id of [MEMBER, OUTSIDER]) {
      await seedActiveUser(id);
      await request("/me/authorization", "GET", undefined, id);
      await assignCustomRole(id, [
        "repositories.read",
        "repositories.settings.manage",
        "environments.read",
        "environments.manage",
        "environments.settings.manage",
      ]);
    }
    await seedTeam("engineering", [[MEMBER, "member"]]);
    await seedGrant("engineering", {
      repo_id: 123,
      repo_owner: repo.repoOwner,
      repo_name: repo.repoName,
    });
    await seedEnvironment("dev", "engineering");
    vi.spyOn(GitHubSourceControlProvider.prototype, "checkRepositoryAccess").mockResolvedValue({
      ...repo,
      defaultBranch: "main",
    });
  });
  afterEach(() => vi.restoreAllMocks());

  it.each([
    { type: "repository" as const, repoOwner: repo.repoOwner, repoName: repo.repoName },
    { type: "environment" as const, environmentId: "dev" },
  ])("requires both scope membership and management authority for $type", async (scope) => {
    const record = await new MemoryStore(env.DB).create(
      { ...content, scope },
      actor,
      scope.type === "repository" ? 123 : null
    );
    const read = await request(`/memories/${record.id}`);
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({ memory: { capabilities: { canEdit: false } } });
    expect((await request(`/memories/${record.id}`, "GET", undefined, OUTSIDER)).status).toBe(
      scope.type === "repository" ? 403 : 404
    );
    expect((await request("/memories", "POST", { ...content, scope })).status).toBe(403);
    await env.DB.prepare(
      "UPDATE team_memberships SET role = 'lead' WHERE team_id = 'engineering' AND user_id = ?"
    )
      .bind(MEMBER)
      .run();
    expect((await request("/memories", "POST", { ...content, scope })).status).toBe(201);
  });

  it("revokes sandbox installation, reads and writes when its team repository grant disappears", async () => {
    const record = await new MemoryStore(env.DB).create(
      {
        ...content,
        scope: { type: "repository", repoOwner: repo.repoOwner, repoName: repo.repoName },
      },
      actor,
      123
    );
    const manifest = await resolveSessionMemory(env.DB, {
      canonicalUserId: MEMBER,
      repositories: [repo],
      environmentId: "dev",
    });
    await new SessionIndexStore(env.DB).create({
      id: "scoped",
      title: null,
      userId: MEMBER,
      ownerTeamId: "engineering",
      visibility: "team",
      repoOwner: repo.repoOwner,
      repoName: repo.repoName,
      repositories: [repo],
      environmentId: "dev",
      model: "anthropic/claude-sonnet-4-6",
      reasoningEffort: null,
      baseBranch: "main",
      status: "created",
      createdAt: 1,
      updatedAt: 1,
      memoryManifest: manifest,
    });
    const { stub } = await initNamedSessionDO("scoped");
    await seedSandboxAuthHash(stub, { authToken: "scoped-token", sandboxId: "sandbox-scoped" });
    const sandbox = (path = "", method = "GET", body?: unknown) =>
      routeRequest(
        new Request(`https://test.local/sessions/scoped/sandbox-memory${path}`, {
          method,
          headers: { Authorization: "Bearer scoped-token", "Content-Type": "application/json" },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
        env,
        createExecutionContext()
      );
    expect((await sandbox()).status).toBe(200);
    expect((await sandbox(`/${record.id}`)).status).toBe(200);
    await env.DB.prepare("DELETE FROM team_repository_grants WHERE team_id = 'engineering'").run();
    expect((await sandbox()).status).toBe(403);
    expect((await sandbox(`/${record.id}`)).status).toBe(404);
    expect((await sandbox("", "POST", { ...content, scope: record.scope })).status).toBe(403);
  });

  it("permanently revokes personal autosave when a collaborator was added and removed", async () => {
    const manifest = await resolveSessionMemory(env.DB, {
      canonicalUserId: MEMBER,
      repositories: [],
      environmentId: null,
    });
    await new SessionIndexStore(env.DB).create({
      id: "private",
      title: null,
      userId: MEMBER,
      ownerTeamId: null,
      visibility: "private",
      repoOwner: null,
      repoName: null,
      model: "anthropic/claude-sonnet-4-6",
      reasoningEffort: null,
      baseBranch: null,
      status: "created",
      createdAt: 1,
      updatedAt: 1,
      memoryManifest: manifest,
    });
    const collaborators = new SessionCollaboratorStore(env.DB);
    await collaborators.add("private", OUTSIDER, MEMBER);
    await collaborators.remove("private", OUTSIDER);
    expect(
      await env.DB.prepare(
        "SELECT personal_auto_save_eligible FROM session_memory_manifests WHERE session_id = 'private'"
      ).first()
    ).toEqual({ personal_auto_save_eligible: 0 });
    await expect(
      new MemoryStore(env.DB).create(
        { ...content, scope: { type: "personal" } },
        { ...actor, kind: "agent", sessionId: "private", allowPersonalAutoSave: true }
      )
    ).rejects.toThrow(/session access/);
  });
});
