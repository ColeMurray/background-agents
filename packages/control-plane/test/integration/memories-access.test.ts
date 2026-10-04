import { createExecutionContext, env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRecordStore } from "../../src/db/memory-records";
import { SessionMemorySelectionStore } from "../../src/db/session-memory-selections";
import { Scheduler } from "../../src/scheduler/scheduler";
import { createCloudflareEnv } from "../../src/cloudflare/platform";
import { memorySelectorForTest, seedMemorySession } from "./memory-test-helpers";
import { SessionCollaboratorStore } from "../../src/db/session-collaborators";
import type { MemoryScope } from "@open-inspect/shared/types/memories";
import type { MemoryPartition } from "../../src/memory/partition";
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
const repoPartition: MemoryPartition = { type: "repository", repoId: repo.repoId };
const repoScope: MemoryScope = {
  type: "repository",
  repoOwner: repo.repoOwner,
  repoName: repo.repoName,
};
const devPartition: MemoryPartition = { type: "environment", environmentId: "dev" };
const devScope: MemoryScope = { type: "environment", environmentId: "dev" };
const createRecord = (partition: MemoryPartition, extra: { supersedesMemoryId?: string } = {}) =>
  new MemoryRecordStore(env.DB).create(
    { partition, scope: partition.type === "repository" ? repoScope : devScope, content, ...extra },
    actor
  );
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
        "sessions.create",
        "repositories.use",
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

  /** Exercise inferred targets through real session-token admission and D1 authorization. */
  async function sandboxSession(
    id: string,
    repositories: (Omit<typeof repo, "repoId"> & { repoId: number | null })[] = [repo],
    environmentId: string | null = null
  ) {
    await seedMemorySession(id, {
      userId: MEMBER,
      ownerTeamId: "engineering",
      visibility: "team",
      repositories,
      environmentId,
    });
    const { stub } = await initNamedSessionDO(id);
    await seedSandboxAuthHash(stub, { authToken: `token-${id}`, sandboxId: `sandbox-${id}` });
    /** Post agent tool input: a session-relative scope plus optional repository selector. */
    return (target: Record<string, unknown>) =>
      routeRequest(
        new Request(`https://test.local/sessions/${id}/sandbox-memory`, {
          method: "POST",
          headers: { Authorization: `Bearer token-${id}`, "Content-Type": "application/json" },
          body: JSON.stringify({ ...content, ...target }),
        }),
        env,
        createExecutionContext()
      );
  }

  it.each([null, "dev"])(
    "infers the sole repository with environment %s",
    async (environmentId) => {
      const write = await sandboxSession(`sole-${environmentId}`, [repo], environmentId);
      const response = await write({ scopeType: "repository" });
      expect(response.status).toBe(201);
      const result = await response.json<{ id: string; status: string }>();
      expect(result.status).toBe("proposed");
      expect(await new MemoryRecordStore(env.DB).get(result.id)).toMatchObject({
        partition: repoPartition,
      });
    }
  );

  it.each([null, "dev"])(
    "requires selection in a multi-repository session with environment %s",
    async (environmentId) => {
      const second = { ...repo, repoName: "web", repoId: 456 };
      await seedGrant("engineering", {
        repo_id: second.repoId,
        repo_owner: second.repoOwner,
        repo_name: second.repoName,
      });
      const write = await sandboxSession(`multi-${environmentId}`, [repo, second], environmentId);
      const ambiguous = await write({ scopeType: "repository" });
      expect(ambiguous.status).toBe(400);
      const message = await ambiguous.text();
      expect(message).toContain("repoOwner and repoName");
      expect(message).toContain("acme/group/api");
      expect(message).toContain("acme/group/web");
      expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM memories").first()).toEqual({ n: 0 });
      expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM memory_revisions").first()).toEqual({
        n: 0,
      });
      const response = await write({
        scopeType: "repository",
        repoOwner: " ACME/GROUP ",
        repoName: " WEB ",
      });
      expect(response.status).toBe(201);
      const { id } = await response.json<{ id: string }>();
      expect(await new MemoryRecordStore(env.DB).get(id)).toMatchObject({
        partition: {
          type: "repository",
          repoId: 456,
          repoOwner: second.repoOwner,
          repoName: second.repoName,
        },
      });
      if (environmentId) {
        const environment = await write({ scopeType: "environment" });
        expect(environment.status).toBe(201);
        const { id } = await environment.json<{ id: string }>();
        expect(await new MemoryRecordStore(env.DB).get(id)).toMatchObject({
          status: "proposed",
          partition: devPartition,
        });
      }
    }
  );

  it("rejects unavailable targets, partial selectors and spoofed identities without inserting", async () => {
    // This user can use the other repository, but it is deliberately absent from the session.
    await seedGrant("engineering", { repo_id: 456, repo_owner: repo.repoOwner, repo_name: "web" });
    const write = await sandboxSession("invalid-target");
    for (const [target, status] of [
      [{ scopeType: "repository", repoOwner: repo.repoOwner, repoName: "web" }, 403],
      [{ scopeType: "repository", repoOwner: repo.repoOwner }, 400],
      [{ scopeType: "personal", repoOwner: repo.repoOwner, repoName: repo.repoName }, 400],
      [{ scopeType: "repository", repoId: 123 }, 400],
      [{ scopeType: "environment" }, 403],
      [{ scopeType: "environment", environmentId: "dev" }, 400],
      [{ scope: { type: "repository" } }, 400],
    ] as const)
      expect((await write(target)).status).toBe(status);
    const noRepo = await sandboxSession("no-repository", []);
    expect((await noRepo({ scopeType: "repository" })).status).toBe(403);
    const legacy = await sandboxSession("legacy-repository", [{ ...repo, repoId: null }]);
    expect((await legacy({ scopeType: "repository" })).status).toBe(403);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM memories").first()).toEqual({ n: 0 });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM memory_revisions").first()).toEqual({
      n: 0,
    });
  });

  it("does not transfer records to a reused repository name", async () => {
    const record = await createRecord(repoPartition);
    vi.mocked(GitHubSourceControlProvider.prototype.checkRepositoryAccess).mockResolvedValue({
      ...repo,
      repoId: 456,
      defaultBranch: "main",
    });
    // The record still belongs to repository 123 and is managed by that identity.
    expect((await request(`/memories/${record.id}`)).status).toBe(200);
    expect((await request(`/memories/${record.id}/revisions`)).status).toBe(200);
    const query = new URLSearchParams({
      scopeType: "repository",
      repoOwner: repo.repoOwner,
      repoName: repo.repoName,
    });
    expect(await (await request(`/memories?${query}`)).json()).toMatchObject({ memories: [] });
    const preview = await request("/memories/preview", "POST", {
      repositories: [{ repoOwner: repo.repoOwner, repoName: repo.repoName }],
    });
    expect(preview.status).toBe(200);
    expect(await preview.json()).toMatchObject({ items: [] });
    expect(
      (
        await memorySelectorForTest().select({
          principal: { userId: MEMBER, ownerTeamId: null },
          repositories: [{ ...repo, repoId: 456 }],
          environmentId: null,
        })
      ).items
    ).toEqual([]);
    await expect(
      createRecord({ type: "repository", repoId: 456 }, { supersedesMemoryId: record.id })
    ).rejects.toThrow(/same scope/);
  });

  it("omits repository memories the creator cannot read without deciding session admission", async () => {
    await createRecord(repoPartition);
    const created = await request(
      "/sessions",
      "POST",
      { repoOwner: repo.repoOwner, repoName: repo.repoName },
      OUTSIDER
    );
    expect(created.status).toBe(201);
    const { sessionId } = await created.json<{ sessionId: string }>();
    expect(
      (await new SessionMemorySelectionStore(env.DB).loadSelection(sessionId))?.selection.items
    ).toEqual([]);
  });

  it("does not inject repository memories into an unauthorized workspace automation", async () => {
    await env.DB.prepare(
      `INSERT INTO automations
      (id, name, instructions, schedule_cron, model, next_run_at, created_by, user_id, created_at, updated_at)
      VALUES ('memory-auto', 'Memory automation', 'Run tests', '0 9 * * *', 'anthropic/claude-sonnet-4-6', 1, ?, ?, 1, 1)`
    )
      .bind(OUTSIDER, OUTSIDER)
      .run();
    await env.DB.prepare(
      `INSERT INTO automation_repositories
      (automation_id, repo_owner, repo_name, repo_id, base_branch, created_at, updated_at)
      VALUES ('memory-auto', ?, ?, ?, 'main', 1, 1)`
    )
      .bind(repo.repoOwner, repo.repoName, repo.repoId)
      .run();
    await createRecord(repoPartition);
    await new Scheduler(env.DB, createCloudflareEnv(env), { submit() {} }).tick();
    const session = await env.DB.prepare(
      "SELECT id FROM sessions WHERE automation_id = 'memory-auto'"
    ).first<{ id: string }>();
    expect(session).not.toBeNull();
    expect(
      (await new SessionMemorySelectionStore(env.DB).loadSelection(session!.id))?.selection.items
    ).toEqual([]);
  });

  it.each([
    { type: "repository" as const, repoOwner: repo.repoOwner, repoName: repo.repoName },
    { type: "environment" as const, environmentId: "dev" },
  ])("requires both scope membership and management authority for $type", async (scope) => {
    const record = await createRecord(scope.type === "repository" ? repoPartition : devPartition);
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

  it.each(["team", "workspace"] as const)(
    "revokes %s sandbox installation, reads and writes when repository access changes",
    async (ownership) => {
      const sessionId = `scoped-${ownership}`;
      if (ownership === "workspace") {
        await env.DB.prepare("DELETE FROM team_repository_grants").run();
        await env.DB.prepare("DELETE FROM team_memberships WHERE user_id = ?").bind(MEMBER).run();
      }
      const record = await createRecord(repoPartition);
      await seedMemorySession(sessionId, {
        userId: MEMBER,
        ownerTeamId: ownership === "team" ? "engineering" : null,
        visibility: ownership,
        repositories: [repo],
        environmentId: ownership === "team" ? "dev" : null,
        status: "created",
      });
      const { stub } = await initNamedSessionDO(sessionId);
      await seedSandboxAuthHash(stub, { authToken: "scoped-token", sandboxId: "sandbox-scoped" });
      const sandbox = (path = "", method = "GET", body?: unknown) =>
        routeRequest(
          new Request(`https://test.local/sessions/${sessionId}/sandbox-memory${path}`, {
            method,
            headers: { Authorization: "Bearer scoped-token", "Content-Type": "application/json" },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          }),
          env,
          createExecutionContext()
        );
      expect((await sandbox()).status).toBe(200);
      expect((await sandbox(`/${record.id}`)).status).toBe(200);
      if (ownership === "team") {
        await env.DB.prepare(
          "DELETE FROM team_repository_grants WHERE team_id = 'engineering'"
        ).run();
      } else {
        await seedGrant("engineering", {
          repo_id: 123,
          repo_owner: repo.repoOwner,
          repo_name: repo.repoName,
        });
      }
      expect((await sandbox()).status).toBe(403);
      expect((await sandbox(`/${record.id}`)).status).toBe(404);
      expect((await sandbox("", "POST", { ...content, scopeType: "repository" })).status).toBe(403);
    }
  );

  /**
   * Commit-time fencing covers facts about the writing session (liveness, owner suspension,
   * personal auto-save eligibility). Grant changes are not re-encoded in SQL: they are checked
   * just before the write and on every later read, and shared-scope agent writes are proposals.
   */
  async function raceWrite(change: string, during: () => Promise<unknown>) {
    const sessionId = `race-${change.replaceAll(" ", "-")}`;
    const workspaceOrPersonal = ["workspace membership removal", "personal failure"].includes(
      change
    );
    await seedMemorySession(sessionId, {
      userId: MEMBER,
      ownerTeamId: workspaceOrPersonal ? null : "engineering",
      visibility:
        change === "personal failure" ? "private" : workspaceOrPersonal ? "workspace" : "team",
      repositories: [repo],
      environmentId: workspaceOrPersonal ? null : "dev",
    });
    const { stub } = await initNamedSessionDO(sessionId);
    await seedSandboxAuthHash(stub, { authToken: "race-token", sandboxId: "sandbox-race" });
    const original = MemoryRecordStore.prototype.create;
    vi.spyOn(MemoryRecordStore.prototype, "create").mockImplementationOnce(async function (
      this: MemoryRecordStore,
      input,
      author,
      options
    ) {
      if (change === "personal failure") expect(options?.personalAutoSaveEligible).toBe(true);
      await during();
      return original.call(this, input, author, options);
    });
    const scope =
      change === "personal failure"
        ? "personal"
        : change === "environment transfer"
          ? "environment"
          : "repository";
    const sandbox = (path: string, body: object) =>
      routeRequest(
        new Request(`https://test.local/sessions/${sessionId}/sandbox-memory${path}`, {
          method: "POST",
          headers: { Authorization: "Bearer race-token", "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
        env,
        createExecutionContext()
      );
    return {
      response: await sandbox("", { ...content, scopeType: scope }),
      search: () => sandbox("/search", { query: "deploy", scopeType: scope }),
    };
  }

  it.each(["personal failure", "suspension", "failed", "completed", "cancelled", "archived"])(
    "rejects a write when %s wins after route authorization",
    async (change) => {
      const { response } = await raceWrite(change, () =>
        change === "personal failure"
          ? env.DB.prepare("UPDATE sessions SET status = 'failed' WHERE id = ?")
              .bind(`race-${change.replaceAll(" ", "-")}`)
              .run()
          : change === "suspension"
            ? env.DB.prepare("UPDATE users SET suspended_at = 1 WHERE id = ?").bind(MEMBER).run()
            : env.DB.prepare("UPDATE sessions SET status = ? WHERE id = ?")
                .bind(change, `race-${change}`)
                .run()
      );
      expect(response.status).toBe(409);
      expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM memories").first()).toEqual({
        count: 0,
      });
      expect(
        await env.DB.prepare("SELECT COUNT(*) AS count FROM memory_revisions").first()
      ).toEqual({ count: 0 });
      expect(
        await env.DB.prepare(
          "SELECT COUNT(*) AS count FROM authorization_audit_events WHERE action = 'memory.created'"
        ).first()
      ).toEqual({ count: 0 });
    }
  );

  it.each([
    [
      "team archive",
      () => env.DB.prepare("UPDATE teams SET archived_at = 1 WHERE id = 'engineering'").run(),
    ],
    [
      "grant removal",
      () =>
        env.DB.prepare("DELETE FROM team_repository_grants WHERE team_id = 'engineering'").run(),
    ],
    [
      "workspace membership removal",
      () => env.DB.prepare("DELETE FROM team_memberships WHERE user_id = ?").bind(MEMBER).run(),
    ],
    [
      "environment transfer",
      async () => {
        await seedTeam("other-team");
        await env.DB.prepare(
          "UPDATE environments SET owner_team_id = 'other-team' WHERE id = 'dev'"
        ).run();
      },
    ],
  ] as const)(
    "records a proposal when %s races the write, then denies later access",
    async (change, during) => {
      const { response, search } = await raceWrite(change, during);
      expect(response.status).toBe(201);
      expect(await response.json()).toMatchObject({ status: "proposed" });
      expect((await search()).status).toBe(403);
    }
  );

  it("permanently revokes personal autosave when a collaborator was added and removed", async () => {
    await seedMemorySession("private", { userId: MEMBER, status: "created" });
    const collaborators = new SessionCollaboratorStore(env.DB);
    await collaborators.add("private", OUTSIDER, MEMBER);
    await collaborators.remove("private", OUTSIDER);
    expect(
      await env.DB.prepare(
        "SELECT personal_auto_save_eligible FROM session_memory_manifests WHERE session_id = 'private'"
      ).first()
    ).toEqual({ personal_auto_save_eligible: 0 });
    await expect(
      new MemoryRecordStore(env.DB).create(
        { partition: { type: "personal", userId: MEMBER }, scope: { type: "personal" }, content },
        { ...actor, kind: "agent", sessionId: "private" },
        { personalAutoSaveEligible: true }
      )
    ).rejects.toThrow(/session access/);
  });
});
