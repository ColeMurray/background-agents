import { beforeEach, describe, expect, it } from "vitest";
import { env, SELF } from "cloudflare:test";
import {
  memoryViewSchema,
  sessionMemoryManifestSchema,
  sessionMemoryDiagnosticsSchema,
} from "@open-inspect/shared/types/memories";
import { MemoryStore } from "../../src/db/memories";
import { mergeUsers } from "../../src/db/user-merge";
import { SessionIndexStore } from "../../src/db/session-index";
import { SessionMemoryStore } from "../../src/db/session-memories";
import { resolveSessionMemory } from "../../src/session/memory-resolution";
import { cleanD1Tables } from "./cleanup";
import { initNamedSessionDO, seedActiveUser, seedSandboxAuthHash, serviceFetch } from "./helpers";

const BASE = "https://test.local";
const OWNER = "11111111111111111111111111111111";
const OTHER = "22222222222222222222222222222222";
const content = {
  scope: { type: "personal" as const },
  memoryType: "fact" as const,
  title: "Test setup",
  description: "How to run integration tests",
  content: "Original body",
};
const request = (path: string, method = "GET", body?: unknown, userId = OWNER) =>
  serviceFetch(`${BASE}${path}`, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    as: { userId, role: "administrator" },
  });

async function createMemory() {
  const response = await request("/memories", "POST", content);
  expect(response.status).toBe(201);
  return memoryViewSchema.parse(((await response.json()) as { memory: unknown }).memory);
}
async function session(id: string, include = true, parent?: string) {
  if (parent) await seedActiveUser(OTHER);
  const manifest = await resolveSessionMemory(
    env.DB,
    { canonicalUserId: OWNER, repositories: [], environmentId: null },
    include
  );
  await new SessionIndexStore(env.DB).create({
    id,
    title: null,
    userId: parent ? OTHER : OWNER,
    ownerTeamId: null,
    visibility: "workspace",
    repoOwner: null,
    repoName: null,
    model: "anthropic/claude-sonnet-4-6",
    reasoningEffort: null,
    baseBranch: null,
    status: "created",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...(parent
      ? { parentSessionId: parent, memoryManifestSourceSessionId: parent }
      : { memoryManifest: manifest }),
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
    expect(
      (
        await request(
          `/memories/${record.id}/archive`,
          "POST",
          { expectedRevisionId: record.currentRevisionId },
          OTHER
        )
      ).status
    ).toBe(404);
    const own = await request(`/memories/${record.id}`);
    expect(own.status).toBe(200);
    expect(own.headers.get("cache-control")).toBe("private, no-store");
  });
  it("persists the personal default and lets an explicit override win", async () => {
    await createMemory();
    expect(
      (await request("/memory-preferences", "PUT", { includePersonalMemories: false })).status
    ).toBe(200);
    const target = { canonicalUserId: OWNER, repositories: [], environmentId: null };
    expect((await resolveSessionMemory(env.DB, target)).items).toHaveLength(0);
    expect((await resolveSessionMemory(env.DB, target, true)).items).toHaveLength(1);
    const preview = await request("/memories/preview", "POST", {
      includePersonalMemories: false,
      repositories: [],
    });
    expect(sessionMemoryManifestSchema.parse(await preview.json()).items).toHaveLength(0);
  });
  it("persists the effective preference through the real create-session route", async () => {
    const record = await createMemory();
    await request("/memory-preferences", "PUT", { includePersonalMemories: false });
    for (const override of [undefined, true]) {
      const response = await request("/sessions", "POST", {
        title: "Memory create-session integration",
        includePersonalMemories: override,
      });
      expect(response.status).toBe(201);
      const { sessionId } = await response.json<{ sessionId: string }>();
      const manifest = (await new SessionMemoryStore(env.DB).load(sessionId))!.manifest;
      expect(manifest.includePersonalMemories).toBe(override ?? false);
      expect(manifest.items.map((item) => item.memoryId)).toEqual(override ? [record.id] : []);
      const view = await request(`/sessions/${sessionId}/memories`);
      expect(view.status).toBe(200);
      expect(sessionMemoryDiagnosticsSchema.parse(await view.json()).manifestSha256).toBe(
        manifest.manifestSha256
      );
    }
  });
  it("pins catalog revisions, reads live bodies and archive notices, and rejects another session token", async () => {
    const record = await createMemory();
    const sandbox = await session("pinned");
    const original = await (await sandbox("")).json();
    expect(original).not.toHaveProperty("items");
    const { scope: _scope, ...fields } = content;
    const revision = await request(`/memories/${record.id}`, "PATCH", {
      ...fields,
      title: "New title",
      content: "New body",
      expectedRevisionId: record.currentRevisionId,
    });
    expect(revision.status).toBe(200);
    const loaded = (await new SessionMemoryStore(env.DB).load("pinned"))!;
    expect(loaded.manifest.items[0]).not.toHaveProperty("changed");
    expect(loaded.manifest.items[0]).not.toHaveProperty("archived");
    const diagnostic = sessionMemoryDiagnosticsSchema.parse(
      await (await request("/sessions/pinned/memories")).json()
    );
    expect(diagnostic.items[0]).toMatchObject({
      revisionId: record.currentRevisionId,
      changed: true,
      archived: false,
    });
    expect(loaded.revisions[0]).not.toHaveProperty("status");
    expect(loaded.revisions[0]).not.toHaveProperty("updatedAt");
    const changed = memoryViewSchema.parse(((await revision.json()) as { memory: unknown }).memory);
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
    await request(`/memories/${record.id}/archive`, "POST", {
      expectedRevisionId: changed.currentRevisionId,
      reason: "Outdated",
    });
    const archivedDiagnostic = sessionMemoryDiagnosticsSchema.parse(
      await (await request("/sessions/pinned/memories")).json()
    );
    expect(archivedDiagnostic.items[0]).toMatchObject({ changed: true, archived: true });
    expect(await (await sandbox(`/${record.id}`)).json()).toEqual({
      id: record.id,
      status: "archived",
      archivedAt: expect.any(Number),
      reason: "Outdated",
    });
    expect(
      (
        await resolveSessionMemory(env.DB, {
          canonicalUserId: OWNER,
          repositories: [],
          environmentId: null,
        })
      ).items
    ).toHaveLength(0);
  });
  it("does not live-expand pinned, revised, or unpinned directives", async () => {
    const initial = await request("/memories", "POST", { ...content, memoryType: "directive" });
    const directive = memoryViewSchema.parse(
      ((await initial.json()) as { memory: unknown }).memory
    );
    const sandbox = await session("directive-pinning");
    const original = (await (await sandbox("")).json()) as { rendered: string };
    expect((await sandbox(`/${directive.id}`)).status).toBe(404);
    const { scope: _scope, ...fields } = content;
    await request(`/memories/${directive.id}`, "PATCH", {
      ...fields,
      memoryType: "directive",
      content: "Changed instructions",
      expectedRevisionId: directive.currentRevisionId,
    });
    expect((await sandbox(`/${directive.id}`)).status).toBe(404);
    expect(await (await sandbox("")).json()).toMatchObject({ rendered: original.rendered });
    const later = await request("/memories", "POST", { ...content, memoryType: "directive" });
    const unpinned = memoryViewSchema.parse(((await later.json()) as { memory: unknown }).memory);
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
    expect((await sandbox("", "POST", content)).status).toBe(403);
    const child = await session("child-excluded", true, "excluded");
    expect((await child(`/${record.id}`)).status).toBe(404);
    expect(
      (await new SessionMemoryStore(env.DB).load("child-excluded"))?.manifest
        .includePersonalMemories
    ).toBe(false);
  });
  it.each(["archive", "reject"] as const)(
    "conceals an unpinned record after %s, even when the sandbox knows its ID",
    async (action) => {
      await createMemory();
      const sandbox = await session(`unpinned-${action}`);
      const record =
        action === "archive"
          ? await createMemory()
          : await new MemoryStore(env.DB).create(content, {
              kind: "agent",
              userId: OWNER,
              sessionId: `unpinned-${action}`,
              requestId: "proposal",
            });
      const decision = await request(`/memories/${record.id}/${action}`, "POST", {
        expectedRevisionId: record.currentRevisionId,
        reason: "Private archive reason",
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
    const write = await sandbox("", "POST", { ...content, title: "Learned fact" });
    expect(write.status).toBe(201);
    const proposal = (await write.json()) as { id: string; status: string; revisionId: string };
    expect(proposal.status).toBe("proposed");
    expect((await sandbox(`/${proposal.id}`)).status).toBe(404);
    expect(
      (
        await request(`/memories/${proposal.id}/approve`, "POST", {
          expectedRevisionId: proposal.revisionId,
        })
      ).status
    ).toBe(200);
    const next = await session("next");
    expect(await (await next("")).json()).toMatchObject({
      rendered: expect.stringContaining("Learned fact"),
    });
    const inherited = await session("child-included", true, "next");
    expect((await inherited(`/${proposal.id}`)).status).toBe(200);
    expect((await inherited("", "POST", content)).status).toBe(403);
    const later = await createMemory();
    expect((await inherited(`/${later.id}`)).status).toBe(404);
    expect((await next(`/${later.id}`)).status).toBe(200);
    await request(`/memories/${proposal.id}/archive`, "POST", {
      expectedRevisionId: proposal.revisionId,
    });
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
    expect((await new MemoryStore(env.DB).get(first.id))?.currentRevisionId).toBe(
      first.currentRevisionId
    );
  });
  it("preserves pinned selection and preferences when canonical accounts are merged", async () => {
    const record = await createMemory();
    await request("/memory-preferences", "GET", undefined, OTHER);
    await session("merged-owner");
    const before = (await new SessionMemoryStore(env.DB).load("merged-owner"))!.manifest;
    await request("/memory-preferences", "PUT", { includePersonalMemories: false });
    await request(`/memories/${record.id}/archive`, "POST", {
      expectedRevisionId: record.currentRevisionId,
    });
    await mergeUsers(env.DB, { survivorId: OTHER, loserId: OWNER });
    const after = (await new SessionMemoryStore(env.DB).load("merged-owner"))!.manifest;
    expect(after.manifestSha256).toBe(before.manifestSha256);
    expect(after.personalOwnerUserId).toBe(OTHER);
    expect(await new MemoryStore(env.DB).getPreferences(OTHER)).toEqual({
      includePersonalMemories: false,
    });
    expect(await new MemoryStore(env.DB).get(record.id)).toMatchObject({
      ownerUserId: OTHER,
      authorUserId: OTHER,
    });
    expect(
      await env.DB.prepare("SELECT archived_by FROM memories WHERE id = ?").bind(record.id).first()
    ).toEqual({ archived_by: OTHER });
  });
});
