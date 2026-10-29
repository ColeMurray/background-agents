import { beforeEach, describe, expect, it } from "vitest";
import { env, SELF } from "cloudflare:test";
import {
  sessionMemorySelectionStatusSchema,
  type MemoryContent,
} from "@open-inspect/shared/types/memories";
import { encryptToken } from "../../src/auth/crypto";
import { MemoryPreferenceStore } from "../../src/db/memory-preferences";
import { MemoryRecordStore } from "../../src/db/memory-records";
import { SessionIndexStore } from "../../src/db/session-index";
import { SessionMemorySelectionStore } from "../../src/db/session-memory-selections";
import { UserStore } from "../../src/db/user-store";
import { estimateSelectionTokens } from "../../src/memory/selection";
import { resolvedPin } from "../../src/session/pinned";
import { cleanD1Tables } from "./cleanup";
import {
  enrollSlackActor,
  initNamedSessionDO,
  queryDO,
  seedActiveUser,
  seedSandboxAuthHash,
  serviceFetch,
  TEST_SESSION_PROVIDER_AUTH,
} from "./helpers";
import { memorySelectorForTest, seedMemorySession, seedPrompt } from "./memory-test-helpers";

const BASE = "https://test.local";
const OWNER = "11111111111111111111111111111111";
const TEAMMATE = "22222222222222222222222222222222";
const fact: MemoryContent = {
  memoryType: "fact",
  title: "Deploy notes",
  description: "How I deploy",
  content: "Use the blue cluster",
};
const personalWrite = { ...fact, title: "Deploy learning", scopeType: "personal" as const };

function personalMemory(userId = OWNER, content: Partial<MemoryContent> = {}) {
  return new MemoryRecordStore(env.DB).create(
    {
      partition: { type: "personal", userId },
      scope: { type: "personal" },
      content: { ...fact, ...content },
    },
    { kind: "user", userId, requestId: "seed" }
  );
}

/** A workspace-visible root session of OWNER's, with its runtime and sandbox-token memory calls. */
async function ownedSession(id: string) {
  await seedMemorySession(id, { userId: OWNER, visibility: "workspace", status: "created" });
  const { stub } = await initNamedSessionDO(id);
  await seedSandboxAuthHash(stub, { authToken: `token-${id}`, sandboxId: `sandbox-${id}` });
  const call = (path: string, method = "GET", body?: unknown) =>
    SELF.fetch(`${BASE}/sessions/${id}/sandbox-memory${path}`, {
      method,
      headers: { Authorization: `Bearer token-${id}`, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return Object.assign(call, { stub, id });
}
type Sandbox = Awaited<ReturnType<typeof ownedSession>>;

async function searchIds(sandbox: Sandbox, scopeType?: "personal") {
  const response = await sandbox("/search", "POST", {
    query: "deploy",
    ...(scopeType ? { scopeType } : {}),
  });
  return response.ok
    ? ((await response.json()) as { results: { id: string }[] }).results.map((hit) => hit.id).sort()
    : response.status;
}

const asUser = (userId: string) => ({ as: { userId, role: "member" as const } });

/** Review feedback for the session runtime's Autofix endpoint, from GitHub reviewer 7. */
const AUTOFIX_FEEDBACK = {
  type: "enqueue_feedback",
  feedbackKey: "github:review:1",
  pullRequest: { repositoryId: "12345", number: 1, artifactId: "pull-request" },
  prompt: "Address the review",
  author: { id: "7", login: "reviewer" },
  origin: {
    kind: "review",
    authorType: "human",
    feedbackUrl: "https://github.com/acme/web-app/pull/1#pullrequestreview-1",
  },
  attemptLimit: 10,
};

/**
 * Make the Autofix turn the one processing, as if reviewer 7's GitHub account mapped to OWNER:
 * linked after the turn was queued, or before it with `linkedFirst`.
 */
async function processAutofixMappedToOwner(stub: DurableObjectStub, linkedFirst = false) {
  if (linkedFirst)
    await queryDO(
      stub,
      "INSERT INTO participants (id, user_id, canonical_user_id, role, joined_at) VALUES ('reviewer-7', 'github:7', ?, 'member', 1)",
      OWNER
    );
  const response = await stub.fetch("http://internal/internal/autofix", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(AUTOFIX_FEEDBACK),
  });
  expect(response.status).toBe(200);
  await queryDO(
    stub,
    `UPDATE messages SET status = CASE WHEN autofix_feedback_key IS NOT NULL
       THEN 'processing' ELSE 'completed' END, started_at = COALESCE(started_at, ?)`,
    Date.now()
  );
  if (!linkedFirst)
    await queryDO(
      stub,
      "UPDATE participants SET canonical_user_id = ? WHERE user_id = 'github:7'",
      OWNER
    );
}

/** Make the session's sandbox ready with a terminal and an editor whose credentials it hands out. */
async function readySandboxWithTools(stub: DurableObjectStub) {
  await queryDO(
    stub,
    `UPDATE sandbox SET status = 'ready', code_server_url = ?, code_server_password = ?,
       ttyd_url = ?, ttyd_token = ?, tunnel_urls = ?`,
    "https://code.example.test",
    await encryptToken("code-secret", env.REPO_SECRETS_ENCRYPTION_KEY!),
    "https://terminal.example.test",
    await encryptToken("terminal-secret", env.REPO_SECRETS_ENCRYPTION_KEY!),
    JSON.stringify({ "3000": "https://app.example.test" })
  );
}

async function memoryPromptContext(stub: DurableObjectStub) {
  return (await stub.fetch("http://internal/internal/memory-prompt-context")).json();
}

describe("personal memory follows the session owner's prompts", () => {
  beforeEach(async () => {
    await cleanD1Tables();
    await seedActiveUser(OWNER);
    await seedActiveUser(TEAMMATE);
  });

  it("gives the owner's prompt the whole personal store in a workspace-visible session", async () => {
    const pinned = await personalMemory();
    const sandbox = await ownedSession("owner-prompt");
    const later = await personalMemory(OWNER, { title: "Deploy rollback" });
    await seedPrompt(sandbox.stub, OWNER);

    expect((await sandbox(`/${later.id}`)).status).toBe(200);
    expect(await searchIds(sandbox)).toEqual([pinned.id, later.id].sort());
    const saved = await sandbox("", "POST", personalWrite);
    expect(saved.status).toBe(201);
    expect(await saved.json()).toMatchObject({ status: "active" });

    const audits = await env.DB.prepare(
      `SELECT principal_kind, actor_user_id_snapshot, resource_type, resource_id,
         target_user_id_snapshot, metadata_json
       FROM authorization_audit_events WHERE action = 'memory.personal_read' ORDER BY occurred_at`
    ).all<Record<string, string>>();
    expect(audits.results).toHaveLength(2);
    expect(audits.results[0]).toMatchObject({
      principal_kind: "sandbox",
      actor_user_id_snapshot: OWNER,
      resource_type: "session",
      resource_id: "owner-prompt",
      target_user_id_snapshot: OWNER,
    });
    expect(JSON.parse(audits.results[0].metadata_json)).toEqual({
      before: {},
      requested: {},
      after: { memoryIds: [later.id] },
    });
  });

  it("refuses personal reads and writes on anyone else's prompt, keeping pinned directives", async () => {
    await personalMemory(OWNER, { memoryType: "directive", content: "Answer in haiku" });
    const record = await personalMemory();
    const sandbox = await ownedSession("teammate-prompt");
    await seedPrompt(sandbox.stub, TEAMMATE);

    expect((await sandbox(`/${record.id}`)).status).toBe(404);
    expect(await searchIds(sandbox)).toEqual([]);
    expect(await searchIds(sandbox, "personal")).toBe(403);
    const write = await sandbox("", "POST", personalWrite);
    expect(write.status).toBe(403);
    expect(await write.text()).toContain("only on the session owner's own prompts");
    expect(((await (await sandbox("")).json()) as { rendered: string }).rendered).toContain(
      "Answer in haiku"
    );
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM authorization_audit_events WHERE action = 'memory.personal_read'"
      ).first()
    ).toEqual({ count: 0 });
  });

  it("treats integration authors and calls between prompts as someone else", async () => {
    const record = await personalMemory();
    const sandbox = await ownedSession("autofix-prompt");
    expect((await sandbox(`/${record.id}`)).status).toBe(404);

    await seedPrompt(sandbox.stub, null);
    expect((await sandbox(`/${record.id}`)).status).toBe(404);
    expect((await sandbox("", "POST", personalWrite)).status).toBe(403);

    // That prompt could have left something running, so the owner's later prompts stop reading
    // and what the agent saves needs review, even once its author is linked to the owner's account.
    await queryDO(
      sandbox.stub,
      "UPDATE participants SET canonical_user_id = ? WHERE canonical_user_id IS NULL",
      OWNER
    );
    await seedPrompt(sandbox.stub, OWNER);
    expect((await sandbox(`/${record.id}`)).status).toBe(404);
    expect(await searchIds(sandbox, "personal")).toBe(403);
    const write = await sandbox("", "POST", personalWrite);
    expect(write.status).toBe(201);
    expect(await write.json()).toMatchObject({ status: "proposed" });
  });

  it("stops personal reads in children once someone else has prompted a session that spawned them", async () => {
    const record = await personalMemory();
    const child = async (id: string, parentId: string) => {
      await seedMemorySession(id, {
        userId: OWNER,
        visibility: "workspace",
        status: "created",
        parentSessionId: parentId,
      });
      const { stub } = await initNamedSessionDO(id, { parentSessionId: parentId });
      await seedSandboxAuthHash(stub, { authToken: `token-${id}`, sandboxId: `sandbox-${id}` });
      await seedPrompt(stub, OWNER);
      return () =>
        SELF.fetch(`${BASE}/sessions/${id}/sandbox-memory/${record.id}`, {
          headers: { Authorization: `Bearer token-${id}` },
        });
    };

    const ownerOnly = await ownedSession("owner-only-parent");
    await seedPrompt(ownerOnly.stub, OWNER);
    expect((await (await child("child-of-owner-only", ownerOnly.id))()).status).toBe(200);

    const coPrompted = await ownedSession("co-prompted-parent");
    await seedPrompt(coPrompted.stub, TEAMMATE, "completed");
    await seedPrompt(coPrompted.stub, OWNER);
    expect((await (await child("child-of-co-prompted", coPrompted.id))()).status).toBe(404);
  });

  it("leaves personal memory on when someone else opens the sandbox", async () => {
    const record = await personalMemory();
    const sandbox = await ownedSession("sandbox-shared");
    await seedPrompt(sandbox.stub, OWNER);
    await readySandboxWithTools(sandbox.stub);

    // Sandbox access is trusted like the session's other credentials (see docs/MEMORY.md).
    const access = await serviceFetch(
      `${BASE}/sessions/${sandbox.id}/sandbox-access`,
      asUser(TEAMMATE)
    );
    expect(access.status).toBe(200);
    expect(await access.json()).toMatchObject({ ttyd: { token: "terminal-secret" } });
    expect((await sandbox(`/${record.id}`)).status).toBe(200);
    const write = await sandbox("", "POST", personalWrite);
    expect(write.status).toBe(201);
    expect(await write.json()).toMatchObject({ status: "active" });
  });

  it("stops personal reads for a suspended owner's queued prompts", async () => {
    const record = await personalMemory();
    const sandbox = await ownedSession("suspended-owner");
    await seedPrompt(sandbox.stub, OWNER);
    expect((await sandbox(`/${record.id}`)).status).toBe(200);

    await env.DB.prepare("UPDATE users SET suspended_at = 1 WHERE id = ?").bind(OWNER).run();
    expect((await sandbox(`/${record.id}`)).status).toBe(404);
  });

  it("records who wrote real web and Slack prompts, and never an Autofix turn's", async () => {
    const sandbox = await ownedSession("real-prompts");
    const processLatest = () =>
      queryDO(
        sandbox.stub,
        `UPDATE messages SET status = CASE WHEN id = (SELECT id FROM messages ORDER BY created_at DESC LIMIT 1)
           THEN 'processing' ELSE 'completed' END, started_at = COALESCE(started_at, ?)`,
        Date.now()
      );

    const web = await serviceFetch(`${BASE}/sessions/${sandbox.id}/prompt`, {
      method: "POST",
      body: JSON.stringify({ content: "From the web" }),
      ...asUser(OWNER),
    });
    expect(web.status).toBe(200);
    await processLatest();
    expect(await memoryPromptContext(sandbox.stub)).toEqual({
      authorUserId: OWNER,
      othersPrompted: false,
      parentSessionId: null,
    });

    await new UserStore(env.DB).createIdentity({
      userId: OWNER,
      provider: "slack",
      providerUserId: "U0OWNER",
    });
    const slack = await serviceFetch(
      `${BASE}/sessions/${sandbox.id}/prompt?channel=slack:D0OWNER`,
      {
        service: "slack-bot",
        actor: "slack:U0OWNER",
        method: "POST",
        body: JSON.stringify({ content: "From a Slack DM", source: "slack" }),
      }
    );
    expect(slack.status).toBe(200);
    await processLatest();
    expect(await memoryPromptContext(sandbox.stub)).toEqual({
      authorUserId: OWNER,
      othersPrompted: false,
      parentSessionId: null,
    });

    // Even a reviewer whose GitHub account maps to the owner relays feedback, not a prompt.
    await processAutofixMappedToOwner(sandbox.stub);
    expect(await memoryPromptContext(sandbox.stub)).toEqual({
      authorUserId: null,
      othersPrompted: true,
      parentSessionId: null,
    });
  });

  it("applies the owner's preference to existing sessions", async () => {
    const record = await personalMemory();
    const sandbox = await ownedSession("preference");
    await seedPrompt(sandbox.stub, OWNER);
    const preferences = new MemoryPreferenceStore(env.DB);

    await preferences.set(OWNER, { includePersonalMemories: false });
    expect(((await (await sandbox("")).json()) as { rendered: string }).rendered).toContain(
      fact.title
    );
    expect((await sandbox(`/${record.id}`)).status).toBe(404);
    expect(await searchIds(sandbox)).toEqual([]);
    expect((await sandbox("", "POST", personalWrite)).status).toBe(403);

    await preferences.set(OWNER, { includePersonalMemories: true });
    expect((await sandbox(`/${record.id}`)).status).toBe(200);
  });

  it("lists personal items in the sidebar only for their owner", async () => {
    const personal = await personalMemory();
    await ownedSession("sidebar");
    const view = async (userId: string) =>
      sessionMemorySelectionStatusSchema.parse(
        await (await serviceFetch(`${BASE}/sessions/sidebar/memories`, asUser(userId))).json()
      );

    expect(await view(OWNER)).toMatchObject({
      items: [expect.objectContaining({ memoryId: personal.id })],
      hiddenPersonalCount: 0,
    });
    const teammateView = await view(TEAMMATE);
    expect(teammateView.items).toEqual([]);
    expect(teammateView.hiddenPersonalCount).toBe(1);
    expect(JSON.stringify(teammateView)).not.toContain(fact.title);
  });
});

describe("personal memory in integration-started sessions", () => {
  const SLACK_ACTOR = "slack:U0PERSONAL";

  beforeEach(async () => {
    await cleanD1Tables();
    await enrollSlackActor(SLACK_ACTOR);
  });

  /** The canonical account the Slack actor enrolled as, with one personal memory. */
  async function slackOwner() {
    const identity = await env.DB.prepare(
      "SELECT user_id FROM user_identities WHERE provider = 'slack' AND provider_user_id = ?"
    )
      .bind(SLACK_ACTOR.slice("slack:".length))
      .first<{ user_id: string }>();
    await personalMemory(identity!.user_id);
    return identity!.user_id;
  }

  async function createAs(
    service: "slack-bot" | "linear-bot" | "github-bot",
    actor: string,
    body: Record<string, unknown> = {}
  ) {
    const response = await serviceFetch(`${BASE}/sessions`, {
      service,
      actor,
      method: "POST",
      body: JSON.stringify({ title: "Integration session", ...body }),
    });
    expect(response.status).toBe(201);
    const { sessionId } = (await response.json()) as { sessionId: string };
    return (await new SessionMemorySelectionStore(env.DB).loadSelection(sessionId))!.selection;
  }

  it("includes personal memory only for a Slack direct message, following the owner's default", async () => {
    const owner = await slackOwner();
    expect((await createAs("slack-bot", SLACK_ACTOR)).personalOwnerUserId).toBeNull();
    expect(
      (await createAs("slack-bot", SLACK_ACTOR, { includePersonalMemories: true }))
        .personalOwnerUserId
    ).toBeNull();

    const direct = await createAs("slack-bot", SLACK_ACTOR, { directMessage: true });
    expect(direct.personalOwnerUserId).toBe(owner);
    expect(direct.items).toHaveLength(1);

    await new MemoryPreferenceStore(env.DB).set(owner, { includePersonalMemories: false });
    expect(
      (await createAs("slack-bot", SLACK_ACTOR, { directMessage: true })).personalOwnerUserId
    ).toBeNull();
  });

  it.each([
    ["linear-bot", "linear"],
    ["github-bot", "github"],
  ] as const)("never includes personal memory for %s sessions", async (service, provider) => {
    const owner = await slackOwner();
    await new UserStore(env.DB).createIdentity({
      userId: owner,
      provider,
      providerUserId: "4242",
    });
    const selection = await createAs(service, `${provider}:4242`, {
      includePersonalMemories: true,
      directMessage: true,
    });
    expect(selection.personalOwnerUserId).toBeNull();
    expect(selection.items).toEqual([]);
  });
});

describe("child sessions spawned through the route", () => {
  beforeEach(async () => {
    await cleanD1Tables();
    await seedActiveUser(OWNER);
    await seedActiveUser(TEAMMATE);
  });

  /** A root session of OWNER's that pinned a personal memory, processing `promptBy`'s prompt. */
  async function parent(id: string, promptBy: string) {
    await new SessionIndexStore(env.DB).create({
      id,
      title: "Parent",
      userId: OWNER,
      ownerTeamId: null,
      visibility: "workspace",
      repoOwner: null,
      repoName: null,
      model: "anthropic/claude-sonnet-4-6",
      reasoningEffort: null,
      baseBranch: null,
      status: "active",
      providerAuth: TEST_SESSION_PROVIDER_AUTH,
      memory: resolvedPin(
        await memorySelectorForTest().select({
          principal: { userId: OWNER, ownerTeamId: null },
          repositories: [],
          environmentId: null,
          includePersonalMemories: true,
        })
      ),
      createdAt: 1,
      updatedAt: 1,
    });
    const { stub } = await initNamedSessionDO(id, {
      repoOwner: null,
      repoName: null,
      repoId: null,
    });
    await seedSandboxAuthHash(stub, { authToken: `token-${id}`, sandboxId: `sandbox-${id}` });
    await seedPrompt(stub, promptBy);
    return stub;
  }

  /** Spawn a child on the parent's processing prompt, returning the child's ID. */
  async function spawnChild(parentId: string) {
    const response = await SELF.fetch(`${BASE}/sessions/${parentId}/children`, {
      method: "POST",
      headers: { Authorization: `Bearer token-${parentId}`, "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Child", prompt: "Look into it" }),
    });
    expect(response.status).toBe(201);
    return ((await response.json()) as { sessionId: string }).sessionId;
  }

  async function spawn(parentId: string) {
    const childId = await spawnChild(parentId);
    return (await new SessionMemorySelectionStore(env.DB).loadSelection(childId))!.selection;
  }

  /** The estimate a session's pinned memory renders to, the basis every manifest records. */
  async function renderedEstimate(sessionId: string) {
    const loaded = (await new SessionMemorySelectionStore(env.DB).loadSelection(sessionId))!;
    return estimateSelectionTokens(loaded.selection, loaded.entries);
  }

  /** Relay a follow-up from the parent's processing prompt to its child. */
  async function followUp(parentId: string, childId: string) {
    const response = await SELF.fetch(`${BASE}/sessions/${parentId}/children/${childId}/prompt`, {
      method: "POST",
      headers: { Authorization: `Bearer token-${parentId}`, "Content-Type": "application/json" },
      body: JSON.stringify({ content: "Follow up" }),
    });
    expect(response.status).toBe(200);
  }

  /** The account the child recorded for its prompt with this content. */
  async function promptAccount(childId: string, content: string) {
    const rows = await queryDO<{ author_canonical_user_id: string | null }>(
      env.SESSION.get(env.SESSION.idFromName(childId)),
      "SELECT author_canonical_user_id FROM messages WHERE content = ?",
      content
    );
    expect(rows).toHaveLength(1);
    return rows[0].author_canonical_user_id;
  }

  /** Try a personal write from the child while its follow-up is the prompt processing. */
  async function personalWriteOnFollowUp(childId: string) {
    const stub = env.SESSION.get(env.SESSION.idFromName(childId));
    await seedSandboxAuthHash(stub, { authToken: `token-${childId}`, sandboxId: `sb-${childId}` });
    await queryDO(
      stub,
      `UPDATE messages SET status = CASE WHEN content = 'Follow up' THEN 'processing' ELSE 'completed' END,
         started_at = COALESCE(started_at, ?)`,
      Date.now()
    );
    return SELF.fetch(`${BASE}/sessions/${childId}/sandbox-memory`, {
      method: "POST",
      headers: { Authorization: `Bearer token-${childId}`, "Content-Type": "application/json" },
      body: JSON.stringify(personalWrite),
    });
  }

  it("copies the owner's personal memory only into a child spawned on their own prompt", async () => {
    const pinned = await personalMemory();
    await parent("spawned-by-owner", OWNER);
    const ownerChild = await spawn("spawned-by-owner");
    expect(ownerChild.personalOwnerUserId).toBe(OWNER);
    expect(ownerChild.items.map((item) => item.memoryId)).toEqual([pinned.id]);

    await parent("spawned-by-teammate", TEAMMATE);
    const teammateChild = await spawn("spawned-by-teammate");
    expect(teammateChild.personalOwnerUserId).toBeNull();
    expect(teammateChild.items).toEqual([]);
  });

  it("measures a child's token estimate on the records it keeps", async () => {
    await personalMemory();
    await parent("estimate-by-owner", OWNER);
    const ownerChild = await spawnChild("estimate-by-owner");
    await parent("estimate-by-teammate", TEAMMATE);
    const teammateChild = await spawnChild("estimate-by-teammate");

    const selections = new SessionMemorySelectionStore(env.DB);
    const parentEstimate = (await selections.loadSelection("estimate-by-teammate"))!.selection
      .estimatedTokens;
    expect((await selections.loadSelection(ownerChild))!.selection.estimatedTokens).toBe(
      parentEstimate
    );
    // Leaving out the personal record also leaves out its rendered heading and formatting.
    const teammateEstimate = (await selections.loadSelection(teammateChild))!.selection
      .estimatedTokens;
    expect(teammateEstimate).toBe(await renderedEstimate(teammateChild));
    expect(teammateEstimate).toBeLessThan(parentEstimate);
  });

  it("never carries personal memory into a child spawned on an Autofix turn", async () => {
    await personalMemory();
    const stub = await parent("spawned-by-autofix", OWNER);
    await processAutofixMappedToOwner(stub);
    const autofixChildId = await spawnChild("spawned-by-autofix");
    const autofixChild = (await new SessionMemorySelectionStore(env.DB).loadSelection(
      autofixChildId
    ))!.selection;
    expect(autofixChild.personalOwnerUserId).toBeNull();
    expect(autofixChild.items).toEqual([]);
    // Its first prompt counts as the Autofix turn did: no one's.
    expect(await promptAccount(autofixChildId, "Look into it")).toBeNull();
  });

  it.each([
    ["after the turn was queued", "follow-up-autofix-linked-later", false],
    ["before the turn was queued", "follow-up-autofix-linked-first", true],
  ])(
    "relays a follow-up from an Autofix turn as no one's, its reviewer linked to the owner %s",
    async (_when, parentId, linkedFirst) => {
      await personalMemory();
      const stub = await parent(parentId, OWNER);
      const childId = await spawnChild(parentId);
      await processAutofixMappedToOwner(stub, linkedFirst);

      await followUp(parentId, childId);
      expect(await promptAccount(childId, "Follow up")).toBeNull();
      const write = await personalWriteOnFollowUp(childId);
      expect(write.status).toBe(403);
      expect(await write.text()).toContain("only on the session owner's own prompts");
    }
  );

  it("relays a follow-up from the owner's own prompt as theirs", async () => {
    await personalMemory();
    await parent("follow-up-owner", OWNER);
    const childId = await spawnChild("follow-up-owner");

    await followUp("follow-up-owner", childId);
    expect(await promptAccount(childId, "Follow up")).toBe(OWNER);
    // Children never auto-save, so the write waits for the owner's review.
    const write = await personalWriteOnFollowUp(childId);
    expect(write.status).toBe(201);
    expect(await write.json()).toMatchObject({ status: "proposed" });
  });
});
