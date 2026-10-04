import { beforeEach, describe, expect, it } from "vitest";
import { env, SELF } from "cloudflare:test";
import {
  memoryDtoSchema,
  memorySelectionSummarySchema,
  sessionMemorySelectionStatusSchema,
} from "@open-inspect/shared/types/memories";
import { MemoryPreferenceStore } from "../../src/db/memory-preferences";
import { MemoryRecordStore } from "../../src/db/memory-records";
import { mergeUsers } from "../../src/db/user-merge";
import { memorySelectorForTest, seedMemorySession } from "./memory-test-helpers";
import { SessionMemorySelectionStore } from "../../src/db/session-memory-selections";
import { cleanD1Tables } from "./cleanup";
import { initNamedSessionDO, seedActiveUser, seedSandboxAuthHash, serviceFetch } from "./helpers";

const BASE = "https://test.local";
const OWNER = "11111111111111111111111111111111";
const OTHER = "22222222222222222222222222222222";
const fields = {
  memoryType: "fact" as const,
  title: "Test setup",
  description: "How to run integration tests",
  content: "Original body",
};
/** Human management body and the equivalent session-relative agent tool input. */
const content = { ...fields, scope: { type: "personal" as const } };
const agentWrite = { ...fields, scopeType: "personal" as const };
const request = (path: string, method = "GET", body?: unknown, userId = OWNER, revision?: string) =>
  serviceFetch(`${BASE}${path}`, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    ...(revision ? { headers: { "If-Match": revision } } : {}),
    as: { userId, role: "administrator" },
  });
/** A lifecycle action fenced by the reviewed revision. */
const act = (id: string, action: string, revision: string, body: object = {}, userId = OWNER) =>
  request(`/memories/${id}/${action}`, "POST", body, userId, revision);

async function createMemory(body: object = content) {
  const response = await request("/memories", "POST", body);
  expect(response.status).toBe(201);
  return memoryDtoSchema.parse(((await response.json()) as { memory: unknown }).memory);
}
async function session(id: string, include = true, parent?: string) {
  if (parent) await seedActiveUser(OTHER);
  await seedMemorySession(id, {
    userId: parent ? OTHER : OWNER,
    visibility: "workspace",
    status: "created",
    includePersonalMemories: include,
    parentSessionId: parent,
  });
  const { stub } = await initNamedSessionDO(id);
  await seedSandboxAuthHash(stub, { authToken: `token-${id}`, sandboxId: `sandbox-${id}` });
  return (path: string, method = "GET", body?: unknown) =>
    SELF.fetch(`${BASE}/sessions/${id}/sandbox-memory${path}`, {
      method,
      headers: { Authorization: `Bearer token-${id}`, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
}

describe("memory HTTP lifecycle and session boundaries", () => {
  beforeEach(cleanD1Tables);
  it("paginates management records and rejects unbounded page sizes", async () => {
    for (let i = 0; i < 3; i++) await createMemory();
    const first = (await (await request("/memories?limit=2")).json()) as {
      memories: { id: string }[];
      nextOffset: number;
    };
    expect(first.memories).toHaveLength(2);
    expect(first.nextOffset).toBe(2);
    const second = (await (
      await request(`/memories?limit=2&offset=${first.nextOffset}`)
    ).json()) as { memories: { id: string }[]; nextOffset: null };
    expect(second.memories).toHaveLength(1);
    expect(second.nextOffset).toBeNull();
    expect(new Set([...first.memories, ...second.memories].map((memory) => memory.id)).size).toBe(
      3
    );
    expect((await request("/memories?limit=10000")).status).toBe(400);
  });
  it("keeps personal management owner-only, including other administrators", async () => {
    const record = await createMemory();
    expect((await request(`/memories/${record.id}`, "GET", undefined, OTHER)).status).toBe(404);
    expect(
      (await request(`/memories/${record.id}/revisions`, "GET", undefined, OTHER)).status
    ).toBe(404);
    expect((await act(record.id, "archive", record.currentRevisionId, {}, OTHER)).status).toBe(404);
    expect((await request(`/memories/${record.id}/archive`, "POST", {})).status).toBe(428);
    const own = await request(`/memories/${record.id}`);
    expect(own.status).toBe(200);
    expect(own.headers.get("cache-control")).toBe("private, no-store");
  });
  it("persists the effective preference through the real create-session route", async () => {
    const record = await createMemory();
    await request("/memory-preferences", "PUT", { includePersonalMemories: false });
    const preview = await request("/memories/preview", "POST", {
      includePersonalMemories: false,
      repositories: [],
    });
    expect(preview.status).toBe(200);
    const previewBody = await preview.json();
    expect(memorySelectionSummarySchema.parse(previewBody).items).toHaveLength(0);
    expect(previewBody).not.toHaveProperty("personalOwnerUserId");
    expect(previewBody).not.toHaveProperty("manifestSha256");
    for (const override of [undefined, true]) {
      const response = await request("/sessions", "POST", {
        title: "Memory create-session integration",
        includePersonalMemories: override,
      });
      expect(response.status).toBe(201);
      const { sessionId } = await response.json<{ sessionId: string }>();
      const manifest = (await new SessionMemorySelectionStore(env.DB).loadSelection(sessionId))!
        .selection;
      expect(manifest.personalOwnerUserId).toBe(override ? OWNER : null);
      expect(manifest.items.map((item) => item.memoryId)).toEqual(override ? [record.id] : []);
      const view = await request(`/sessions/${sessionId}/memories`);
      expect(view.status).toBe(200);
      const status = sessionMemorySelectionStatusSchema.parse(await view.json());
      expect(status.items.map((item) => item.memoryId)).toEqual(
        manifest.items.map((item) => item.memoryId)
      );
    }
  });
  it("pins catalog revisions, reads live bodies and archive notices, and rejects another session token", async () => {
    const record = await createMemory();
    const sandbox = await session("pinned");
    const original = await (await sandbox("")).json();
    expect(original).not.toHaveProperty("items");
    const revision = await request(
      `/memories/${record.id}`,
      "PATCH",
      { ...fields, title: "New title", content: "New body" },
      OWNER,
      record.currentRevisionId
    );
    expect(revision.status).toBe(200);
    const loaded = (await new SessionMemorySelectionStore(env.DB).loadSelection("pinned"))!;
    expect(loaded.selection.items[0]).not.toHaveProperty("changed");
    expect(loaded.selection.items[0]).not.toHaveProperty("archived");
    const status = sessionMemorySelectionStatusSchema.parse(
      await (await request("/sessions/pinned/memories")).json()
    );
    expect(status.items[0]).toMatchObject({
      memoryId: record.id,
      revisionNumber: 1,
      revisedSinceSelection: true,
      archivedSinceSelection: false,
    });
    expect(loaded.entries[0]).not.toHaveProperty("status");
    expect(loaded.entries[0]).not.toHaveProperty("updatedAt");
    const changed = memoryDtoSchema.parse(((await revision.json()) as { memory: unknown }).memory);
    expect(await (await sandbox("")).json()).toMatchObject({
      rendered: (original as { rendered: string }).rendered,
    });
    expect(await (await sandbox(`/${record.id}`)).json()).toMatchObject({
      content: "New body",
      revisionNumber: 2,
    });
    const wrong = await SELF.fetch(`${BASE}/sessions/pinned/sandbox-memory`, {
      headers: { Authorization: "Bearer token-other" },
    });
    expect(wrong.status).toBe(401);
    await act(record.id, "archive", changed.currentRevisionId, { archiveNote: "Outdated" });
    const archivedStatus = sessionMemorySelectionStatusSchema.parse(
      await (await request("/sessions/pinned/memories")).json()
    );
    expect(archivedStatus.items[0]).toMatchObject({
      revisedSinceSelection: true,
      archivedSinceSelection: true,
    });
    expect(await (await sandbox(`/${record.id}`)).json()).toEqual({
      id: record.id,
      status: "archived",
      archiveKind: "manual",
      archivedAt: expect.any(Number),
      archiveNote: "Outdated",
    });
    expect(
      (
        await memorySelectorForTest().select({
          principal: { userId: OWNER, ownerTeamId: null },
          repositories: [],
          environmentId: null,
        })
      ).items
    ).toHaveLength(0);
  });
  it("does not live-expand pinned, revised, or unpinned directives", async () => {
    const directive = await createMemory({ ...content, memoryType: "directive" });
    const sandbox = await session("directive-pinning");
    const original = (await (await sandbox("")).json()) as { rendered: string };
    expect((await sandbox(`/${directive.id}`)).status).toBe(404);
    await request(
      `/memories/${directive.id}`,
      "PATCH",
      { ...fields, memoryType: "directive", content: "Changed instructions" },
      OWNER,
      directive.currentRevisionId
    );
    expect((await sandbox(`/${directive.id}`)).status).toBe(404);
    expect(await (await sandbox("")).json()).toMatchObject({ rendered: original.rendered });
    const unpinned = await createMemory({ ...content, memoryType: "directive" });
    expect((await sandbox(`/${unpinned.id}`)).status).toBe(404);
    const liveFact = await createMemory();
    expect(await (await sandbox(`/${liveFact.id}`)).json()).toMatchObject({
      memoryType: "fact",
      content: content.content,
    });
  });
  it("opt-out blocks guessed personal IDs and personal writes, including inherited children", async () => {
    const record = await createMemory();
    const sandbox = await session("excluded", false);
    expect((await sandbox(`/${record.id}`)).status).toBe(404);
    expect((await sandbox("", "POST", agentWrite)).status).toBe(403);
    const child = await session("child-excluded", true, "excluded");
    expect((await child(`/${record.id}`)).status).toBe(404);
    expect(
      (await new SessionMemorySelectionStore(env.DB).loadSelection("child-excluded"))?.selection
        .personalOwnerUserId
    ).toBeNull();
  });
  it.each(["archive", "reject"] as const)(
    "conceals an unpinned record after %s, even when the sandbox knows its ID",
    async (action) => {
      await createMemory();
      const sandbox = await session(`unpinned-${action}`);
      const record =
        action === "archive"
          ? await createMemory()
          : await new MemoryRecordStore(env.DB).create(
              {
                partition: { type: "personal", userId: OWNER },
                scope: { type: "personal" },
                content: fields,
              },
              {
                kind: "agent",
                userId: OWNER,
                sessionId: `unpinned-${action}`,
                requestId: "proposal",
              }
            );
      const decision = await act(record.id, action, record.currentRevisionId, {
        archiveNote: "Private archive reason",
      });
      expect(decision.status).toBe(200);
      const response = await sandbox(`/${record.id}`);
      expect(response.status).toBe(404);
      expect(await response.text()).not.toContain("Private archive reason");
    }
  );
  it("shared-session personal learning is proposed, approved, loaded next session, then archived", async () => {
    await createMemory();
    const sandbox = await session("learning");
    const write = await sandbox("", "POST", { ...agentWrite, title: "Learned fact" });
    expect(write.status).toBe(201);
    const proposal = (await write.json()) as { id: string; status: string; revisionId: string };
    expect(proposal.status).toBe("proposed");
    expect((await sandbox(`/${proposal.id}`)).status).toBe(404);
    expect((await act(proposal.id, "approve", proposal.revisionId)).status).toBe(200);
    const next = await session("next");
    expect(await (await next("")).json()).toMatchObject({
      rendered: expect.stringContaining("Learned fact"),
    });
    const inherited = await session("child-included", true, "next");
    expect((await inherited(`/${proposal.id}`)).status).toBe(200);
    expect((await inherited("", "POST", agentWrite)).status).toBe(403);
    const later = await createMemory();
    expect((await inherited(`/${later.id}`)).status).toBe(404);
    expect((await next(`/${later.id}`)).status).toBe(200);
    await act(proposal.id, "archive", proposal.revisionId);
    expect(await (await next(`/${proposal.id}`)).json()).toMatchObject({ status: "archived" });
  });
  it("enforces the record/revision pair in a pinned manifest", async () => {
    const first = await createMemory();
    const second = await createMemory();
    await session("integrity");
    await expect(
      env.DB.prepare(
        "UPDATE session_memory_items SET revision_id = ? WHERE session_id = ? AND memory_id = ?"
      )
        .bind(second.currentRevisionId, "integrity", first.id)
        .run()
    ).rejects.toThrow(/foreign key/i);
    expect((await new MemoryRecordStore(env.DB).get(first.id))?.currentRevisionId).toBe(
      first.currentRevisionId
    );
  });
  it("preserves pinned selection and preferences when canonical accounts are merged", async () => {
    const record = await createMemory();
    await request("/memory-preferences", "GET", undefined, OTHER);
    await session("merged-owner");
    const before = (await new SessionMemorySelectionStore(env.DB).loadSelection("merged-owner"))!
      .selection;
    await request("/memory-preferences", "PUT", { includePersonalMemories: false });
    await act(record.id, "archive", record.currentRevisionId);
    await mergeUsers(env.DB, { survivorId: OTHER, loserId: OWNER });
    const after = (await new SessionMemorySelectionStore(env.DB).loadSelection("merged-owner"))!
      .selection;
    expect(after.manifestSha256).toBe(before.manifestSha256);
    expect(after.personalOwnerUserId).toBe(OTHER);
    expect(await new MemoryPreferenceStore(env.DB).get(OTHER)).toEqual({
      includePersonalMemories: false,
    });
    expect(await new MemoryRecordStore(env.DB).get(record.id)).toMatchObject({
      partition: { type: "personal", userId: OTHER },
      authorUserId: OTHER,
    });
    expect(
      await env.DB.prepare("SELECT archived_by FROM memories WHERE id = ?").bind(record.id).first()
    ).toEqual({ archived_by: OTHER });
  });
});
