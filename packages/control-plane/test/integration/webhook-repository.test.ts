import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeWebhookEvent } from "@open-inspect/shared/triggers";
import * as sourceControl from "../../src/source-control";
import { createCloudflareEnv } from "../../src/cloudflare/platform";
import { hashApiKey } from "../../src/auth/webhook-key";
import { createTestRequestHandler } from "../../src/router.test-support";
import { automationWebhookRoutes } from "../../src/webhooks/automation-webhook";
import { assignCustomRole, seedGrant, seedTeam } from "./ownership-test-helpers";
import { AutomationStore } from "../../src/db/automation-store";
import { SessionIndexStore } from "../../src/db/session-index";
import { Scheduler } from "../../src/scheduler/scheduler";
import { cleanD1Tables } from "./cleanup";
import { queryDO, seedActiveUser } from "./helpers";
import { fetchRuns } from "./run-helpers";

const OWNER = "11111111111111111111111111111111";
const ID = "auto-payload-repository";
const repositoryFromPayload = {
  repoOwnerPath: "$.repository.owner",
  repoNamePath: "$.repository.name",
  branchPath: "$.branch",
};
const payload = {
  repository: { owner: "acme", name: "api" },
  branch: "release/next",
  alert: "CI failed",
};
const checkRepositoryAccess = vi.fn();
const getBranchHead = vi.fn();

async function seedAutomation(config: unknown = repositoryFromPayload) {
  await env.DB.prepare(
    `INSERT INTO automations (id, name, instructions, trigger_type, model, created_by, user_id,
      created_at, updated_at, trigger_config)
     VALUES (?, 'Payload repo', 'Investigate CI', 'webhook', 'anthropic/claude-sonnet-4-6', ?, ?, 1, 1, ?)`
  )
    .bind(
      ID,
      OWNER,
      OWNER,
      JSON.stringify({ conditions: [], ...(config ? { repositoryFromPayload: config } : {}) })
    )
    .run();
}

function deliver(body: unknown = payload, idempotencyKey = "delivery-1", sessionKey?: string) {
  return new Scheduler(env.DB, createCloudflareEnv(env), { submit() {} }).event(
    normalizeWebhookEvent(ID, body, { idempotencyKey, sessionKey })
  );
}

describe("Webhook repository resolution (real D1 and SessionDO)", () => {
  beforeEach(async () => {
    await cleanD1Tables();
    await seedActiveUser(OWNER);
    checkRepositoryAccess.mockReset().mockImplementation(async ({ owner, name }) => ({
      repoOwner: owner,
      repoName: name,
      repoId: 101,
      defaultBranch: "trunk",
    }));
    getBranchHead.mockReset().mockResolvedValue("a".repeat(40));
    vi.spyOn(sourceControl, "createSourceControlProviderFromEnv").mockReturnValue({
      checkRepositoryAccess,
      getBranchHead,
    } as unknown as sourceControl.SourceControlProvider);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await cleanD1Tables();
  });

  it("resolves payload repository and branch into run, session, and agent context", async () => {
    await seedAutomation();
    expect(await deliver()).toMatchObject({ triggered: 1 });
    const [run] = await fetchRuns(ID);
    expect(run).toMatchObject({
      repo_owner: "acme",
      repo_name: "api",
      repo_id: 101,
      base_branch: "release/next",
      status: "running",
    });
    expect(await new SessionIndexStore(env.DB).get(run.session_id!)).toMatchObject({
      repoOwner: "acme",
      repoName: "api",
      baseBranch: "release/next",
    });
    const stub = env.SESSION.get(env.SESSION.idFromName(run.session_id!));
    expect(await queryDO(stub, "SELECT repo_owner, repo_name, base_branch FROM session")).toEqual([
      { repo_owner: "acme", repo_name: "api", base_branch: "release/next" },
    ]);
    const messages = await queryDO<{ content: string }>(stub, "SELECT content FROM messages");
    expect(messages[0].content).toContain("acme/api");
    expect(messages[0].content).toContain("release/next");
    expect(messages[0].content).toContain('"alert": "CI failed"');
    expect(checkRepositoryAccess).toHaveBeenCalledOnce();
    expect(getBranchHead).toHaveBeenCalledWith(
      { owner: "acme", name: "api", branch: "release/next" },
      { kind: "repositories", repositoryIds: [101] }
    );
  });
  it("keeps fixed repository behavior unchanged, ignoring payload target fields", async () => {
    await seedAutomation(null);
    await new AutomationStore(env.DB).replaceRepositories(ID, [
      { repo_owner: "fixed", repo_name: "repo", repo_id: 101, base_branch: "stable" },
    ]);
    expect(await deliver()).toMatchObject({ triggered: 1 });
    expect((await fetchRuns(ID))[0]).toMatchObject({
      repo_owner: "fixed",
      repo_name: "repo",
      base_branch: "stable",
    });
    expect(getBranchHead).not.toHaveBeenCalled();
  });

  it.each([
    { config: repositoryFromPayload, expected: "trunk" },
    { config: { ...repositoryFromPayload, fallbackBranch: "stable" }, expected: "stable" },
    {
      config: { repoOwnerPath: "$.repository.owner", repoNamePath: "$.repository.name" },
      expected: "trunk",
    },
  ])("uses $expected when branch is absent or unconfigured", async ({ config, expected }) => {
    await seedAutomation(config);
    expect(await deliver({ repository: payload.repository })).toMatchObject({ triggered: 1 });
    expect((await fetchRuns(ID))[0].base_branch).toBe(expected);
  });

  it("normalizes identities and preserves nested owners", async () => {
    await seedAutomation({
      ...repositoryFromPayload,
      allowedRepositories: [{ repoOwner: "Group/SubGroup", repoName: "API" }],
    });
    expect(
      await deliver({ ...payload, repository: { owner: " Group/SubGroup ", name: " API " } })
    ).toMatchObject({ triggered: 1 });
    expect((await fetchRuns(ID))[0]).toMatchObject({
      repo_owner: "group/subgroup",
      repo_name: "api",
    });
  });

  it.each([
    { body: {}, message: /repoOwner and repoName/ },
    { body: { repository: { owner: "acme" } }, message: /repoOwner and repoName/ },
    { body: { repository: { owner: "acme", name: 42 } }, message: /repoOwner and repoName/ },
    { body: { repository: { owner: "acme", name: "../api" } }, message: /identity is invalid/ },
    { body: { ...payload, branch: 42 }, message: /branch must be/ },
    { body: { ...payload, branch: "" }, message: /branch must be/ },
    { body: { ...payload, branch: "bad..ref" }, message: /branch is invalid/ },
    { body: { ...payload, branch: "bad ref" }, message: /branch is invalid/ },
    { body: { ...payload, branch: "bad[ref" }, message: /branch is invalid/ },
    { body: { ...payload, branch: "bad\\ref" }, message: /branch is invalid/ },
    { body: { ...payload, branch: "bad\u0000ref" }, message: /branch is invalid/ },
  ])("rejects malformed payload $body without creating records", async ({ body, message }) => {
    await seedAutomation();
    await expect(deliver(body)).rejects.toThrow(message);
    expect(await fetchRuns(ID)).toEqual([]);
    expect((await env.DB.prepare("SELECT id FROM sessions").all()).results).toEqual([]);
  });

  it("rejects repositories outside the allowlist before SCM lookup", async () => {
    await seedAutomation({
      ...repositoryFromPayload,
      allowedRepositories: [{ repoOwner: "acme", repoName: "other" }],
    });
    await expect(deliver()).rejects.toMatchObject({ status: 403 });
    expect(checkRepositoryAccess).not.toHaveBeenCalled();
    expect(await fetchRuns(ID)).toEqual([]);
  });

  it("checks canonical repository names against the allowlist after redirects", async () => {
    await seedAutomation({
      ...repositoryFromPayload,
      allowedRepositories: [{ repoOwner: "acme", repoName: "api" }],
    });
    checkRepositoryAccess.mockResolvedValue({
      repoOwner: "other",
      repoName: "redirect",
      repoId: 202,
      defaultBranch: "main",
    });
    await expect(deliver()).rejects.toMatchObject({ status: 403 });
    expect(await fetchRuns(ID)).toEqual([]);
  });

  it.each(["repository", "branch", "unavailable"])(
    "rejects %s lookup failure before creating a session",
    async (kind) => {
      await seedAutomation();
      if (kind === "repository") checkRepositoryAccess.mockResolvedValue(null);
      if (kind === "branch") getBranchHead.mockResolvedValue(null);
      if (kind === "unavailable")
        checkRepositoryAccess.mockRejectedValue(new Error("upstream unavailable"));
      await expect(deliver()).rejects.toMatchObject({
        status: kind === "repository" ? 403 : kind === "branch" ? 400 : 503,
      });
      expect(await fetchRuns(ID)).toEqual([]);
      expect((await env.DB.prepare("SELECT id FROM sessions").all()).results).toEqual([]);
    }
  );

  it("requires executor repository permission", async () => {
    await seedAutomation();
    await assignCustomRole(OWNER, ["sessions.create"]);
    await expect(deliver()).rejects.toMatchObject({ status: 403 });
    expect(await fetchRuns(ID)).toEqual([]);
  });

  it.each([false, true])(
    "enforces team grants on the resolved target (granted=%s)",
    async (granted) => {
      await seedAutomation();
      await seedTeam("team_payload", [[OWNER, "member"]]);
      await env.DB.prepare("UPDATE automations SET owner_team_id = 'team_payload' WHERE id = ?")
        .bind(ID)
        .run();
      if (granted)
        await seedGrant("team_payload", {
          repo_owner: "acme",
          repo_name: "api",
          repo_id: 101,
        });
      if (granted) expect(await deliver()).toMatchObject({ triggered: 1 });
      else {
        await expect(deliver()).rejects.toMatchObject({ status: 403 });
        expect(await fetchRuns(ID)).toEqual([]);
      }
    }
  );

  it("returns the original invocation for duplicate deliveries without resolving again", async () => {
    await seedAutomation();
    const first = await deliver();
    checkRepositoryAccess.mockClear().mockResolvedValue(null);
    expect(await deliver({})).toEqual({
      triggered: 0,
      skipped: 1,
      steered: 0,
      invocationIds: first.invocationIds,
    });
    expect(checkRepositoryAccess).not.toHaveBeenCalled();
    expect(await fetchRuns(ID)).toHaveLength(1);
  });

  it("admits only one invocation for concurrent identical deliveries", async () => {
    await seedAutomation();
    const results = await Promise.all([deliver(), deliver()]);
    expect(results.reduce((total, result) => total + result.triggered, 0)).toBe(1);
    expect(results[0].invocationIds).toEqual(results[1].invocationIds);
    expect(await fetchRuns(ID)).toHaveLength(1);
  });

  it("keeps sessionKey follow-ups on the same target and releases a refused key for retry", async () => {
    await seedAutomation();
    const first = await deliver(payload, "first", "card");
    await expect(
      deliver({ ...payload, branch: "other" }, "follow-up", "card")
    ).rejects.toMatchObject({ status: 409 });
    expect(await deliver(payload, "follow-up", "card")).toMatchObject({
      steered: 1,
      invocationIds: first.invocationIds,
    });
    expect(await fetchRuns(ID)).toHaveLength(1);
  });

  it.each([
    { repoOwner: "acme", repoName: "api-v2" },
    { repoOwner: "new-owner", repoName: "api" },
  ])(
    "rejects a renamed canonical target on a sessionKey follow-up: $repoOwner/$repoName",
    async (renamed) => {
      await seedAutomation();
      const first = await deliver(payload, "first", "card");
      checkRepositoryAccess.mockResolvedValueOnce({
        ...renamed,
        repoId: 101,
        defaultBranch: "trunk",
      });
      await expect(deliver(payload, "follow-up", "card")).rejects.toMatchObject({ status: 409 });
      const [run] = await fetchRuns(ID);
      const stub = env.SESSION.get(env.SESSION.idFromName(run.session_id!));
      expect(await queryDO(stub, "SELECT content FROM messages")).toHaveLength(1);
      expect(await new SessionIndexStore(env.DB).get(run.session_id!)).toMatchObject({
        repoOwner: "acme",
        repoName: "api",
      });
      expect(await deliver(payload, "follow-up", "card")).toMatchObject({
        steered: 1,
        invocationIds: first.invocationIds,
      });
    }
  );

  it("returns HTTP 403 when repository permission is revoked between admission and launch", async () => {
    await seedAutomation();
    const claim = AutomationStore.prototype.claimRunSession;
    vi.spyOn(AutomationStore.prototype, "claimRunSession").mockImplementation(async function (
      this: AutomationStore,
      ...args
    ) {
      const claimed = await claim.apply(this, args);
      await assignCustomRole(OWNER, ["sessions.create"]);
      return claimed;
    });
    await env.DB.prepare("UPDATE automations SET trigger_auth_data = ? WHERE id = ?")
      .bind(await hashApiKey("test-webhook-key"), ID)
      .run();
    const handle = createTestRequestHandler([automationWebhookRoutes]);
    const response = await handle(
      new Request(`https://test.local/webhooks/automation/${ID}`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer test-webhook-key" },
        body: JSON.stringify({ ...payload, idempotencyKey: "revoked" }),
      }),
      createCloudflareEnv(env),
      { submit() {} }
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "WEBHOOK_REPOSITORY_RESOLUTION_FAILED" });
    expect(await fetchRuns(ID)).toEqual([
      expect.objectContaining({ status: "unauthorized", session_id: null }),
    ]);
    expect((await env.DB.prepare("SELECT id FROM sessions").all()).results).toEqual([]);
  });

  it("keeps the resolved snapshot if stored targets change during lookup", async () => {
    await seedAutomation();
    getBranchHead.mockImplementationOnce(async () => {
      await env.DB.prepare(
        "INSERT INTO automation_environments (automation_id, environment_id, created_at, updated_at) VALUES (?, 'env_deleted', 1, 1)"
      )
        .bind(ID)
        .run();
      return "a".repeat(40);
    });
    expect(await deliver()).toMatchObject({ triggered: 1 });
    expect(await fetchRuns(ID)).toEqual([
      expect.objectContaining({
        repo_owner: "acme",
        repo_name: "api",
        base_branch: "release/next",
        environment_id: null,
        status: "running",
      }),
    ]);
  });

  it("rejects a manual firing that has no payload", async () => {
    await seedAutomation();
    await expect(
      new Scheduler(env.DB, createCloudflareEnv(env), { submit() {} }).trigger(ID, OWNER)
    ).rejects.toThrow(/webhook payload/);
    expect(await fetchRuns(ID)).toEqual([]);
  });

  it("returns a clear HTTP error and creates no session when resolution fails", async () => {
    await seedAutomation();
    await env.DB.prepare("UPDATE automations SET trigger_auth_data = ? WHERE id = ?")
      .bind(await hashApiKey("test-webhook-key"), ID)
      .run();
    const handle = createTestRequestHandler([automationWebhookRoutes]);
    const response = await handle(
      new Request(`https://test.local/webhooks/automation/${ID}`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer test-webhook-key" },
        body: "{}",
      }),
      createCloudflareEnv(env),
      { submit() {} }
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      code: "WEBHOOK_REPOSITORY_RESOLUTION_FAILED",
      error: expect.stringContaining("repoOwner and repoName"),
    });
    expect(await fetchRuns(ID)).toEqual([]);
    expect((await env.DB.prepare("SELECT id FROM sessions").all()).results).toEqual([]);
  });
});
