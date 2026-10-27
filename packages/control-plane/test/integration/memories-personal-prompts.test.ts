import { beforeEach, describe, expect, it } from "vitest";
import { env, SELF } from "cloudflare:test";
import {
  sessionMemorySelectionStatusSchema,
  type MemoryContent,
} from "@open-inspect/shared/types/memories";
import { MemoryPreferenceStore } from "../../src/db/memory-preferences";
import { MemoryRecordStore } from "../../src/db/memory-records";
import { SessionMemorySelectionStore } from "../../src/db/session-memory-selections";
import { UserStore } from "../../src/db/user-store";
import { cleanD1Tables } from "./cleanup";
import {
  enrollSlackActor,
  initNamedSessionDO,
  queryDO,
  seedActiveUser,
  seedSandboxAuthHash,
  serviceFetch,
} from "./helpers";
import { seedMemorySession, seedPrompt } from "./memory-test-helpers";

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

async function eligibility(sessionId: string) {
  return env.DB.prepare(
    "SELECT personal_reads_eligible, personal_auto_save_eligible FROM session_memory_manifests WHERE session_id = ?"
  )
    .bind(sessionId)
    .first();
}

const asUser = (userId: string) => ({ as: { userId, role: "member" as const } });

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

    // The owner's next prompt reads again, but what the agent saves now needs review.
    await seedPrompt(sandbox.stub, OWNER);
    expect((await sandbox(`/${record.id}`)).status).toBe(200);
    const write = await sandbox("", "POST", personalWrite);
    expect(write.status).toBe(201);
    expect(await write.json()).toMatchObject({ status: "proposed" });
  });

  it("switches personal reads off for good when someone else receives sandbox credentials", async () => {
    const record = await personalMemory();
    const sandbox = await ownedSession("sandbox-shared");
    await seedPrompt(sandbox.stub, OWNER);
    await queryDO(
      sandbox.stub,
      "UPDATE sandbox SET status = 'ready', code_server_url = ?, ttyd_url = ?, tunnel_urls = ?",
      "https://code.example.test",
      "https://terminal.example.test",
      JSON.stringify({ "3000": "https://app.example.test" })
    );
    const credentials = (userId: string) =>
      serviceFetch(`${BASE}/sessions/${sandbox.id}/sandbox-access`, asUser(userId));

    expect((await credentials(OWNER)).status).toBe(200);
    expect(
      (await serviceFetch(`${BASE}/sessions/${sandbox.id}/tunnel-urls`, asUser(TEAMMATE))).status
    ).toBe(200);
    expect(await eligibility(sandbox.id)).toEqual({
      personal_reads_eligible: 1,
      personal_auto_save_eligible: 1,
    });
    expect((await sandbox(`/${record.id}`)).status).toBe(200);

    expect((await credentials(TEAMMATE)).status).toBe(200);
    expect(await eligibility(sandbox.id)).toEqual({
      personal_reads_eligible: 0,
      personal_auto_save_eligible: 0,
    });
    expect((await sandbox(`/${record.id}`)).status).toBe(404);
    expect(await searchIds(sandbox, "personal")).toBe(403);
    const write = await sandbox("", "POST", personalWrite);
    expect(write.status).toBe(201);
    expect(await write.json()).toMatchObject({ status: "proposed" });
  });

  it("does not switch personal reads off when no credentials are handed out", async () => {
    const sandbox = await ownedSession("sandbox-unavailable");
    await queryDO(sandbox.stub, "UPDATE sandbox SET status = 'stopped'");
    expect(
      (await serviceFetch(`${BASE}/sessions/${sandbox.id}/sandbox-access`, asUser(TEAMMATE))).status
    ).toBe(409);
    expect(await eligibility(sandbox.id)).toEqual({
      personal_reads_eligible: 1,
      personal_auto_save_eligible: 1,
    });
  });

  it("applies the owner's preference to existing sessions", async () => {
    const record = await personalMemory();
    const sandbox = await ownedSession("preference");
    await seedPrompt(sandbox.stub, OWNER);
    const preferences = new MemoryPreferenceStore(env.DB);

    await preferences.set(OWNER, { includePersonalMemories: false });
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
