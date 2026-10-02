import { beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { MemoryStore, type MemoryActor } from "../../src/db/memories";
import { cleanD1Tables } from "./cleanup";
import { SessionIndexStore } from "../../src/db/session-index";
import { resolveMemoryRecords } from "../../src/session/memory-resolution";
import { SessionScopeStore } from "../../src/db/session-scope-store";

const human: MemoryActor = { kind: "user", userId: "user_a", requestId: "test" };
const agent: MemoryActor = {
  kind: "agent",
  userId: "user_a",
  sessionId: "session_a",
  requestId: "tool",
  allowPersonalAutoSave: true,
};
const personal = {
  scope: { type: "personal" as const },
  memoryType: "fact" as const,
  title: "Test setup",
  description: "How to run integration tests",
  content: "Use the local database",
};

describe("memory persistence", () => {
  beforeEach(async () => {
    await cleanD1Tables();
    await new SessionIndexStore(env.DB).create({
      id: "session_a",
      title: null,
      userId: "user_a",
      ownerTeamId: null,
      visibility: "private",
      repoOwner: null,
      repoName: null,
      model: "anthropic/claude-sonnet-4-6",
      reasoningEffort: null,
      baseBranch: null,
      status: "created",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      memoryManifest: await resolveMemoryRecords([], {
        canonicalUserId: "user_a",
        includePersonalMemories: true,
        repositories: [],
        environmentId: null,
      }),
    });
  });
  it("revises without replacing provenance and rejects concurrent stale edits", async () => {
    const store = new MemoryStore(env.DB);
    const record = await store.create(personal, agent);
    expect(record.status).toBe("active");
    const { scope: _scope, ...contentFields } = personal;
    const unchanged = await store.revise(record.id, contentFields, record.currentRevisionId, human);
    expect(unchanged.currentRevisionId).toBe(record.currentRevisionId);
    const outcomes = await Promise.allSettled(
      ["one", "two"].map((content) =>
        store.revise(record.id, { ...contentFields, content }, record.currentRevisionId, human)
      )
    );
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect((await store.get(record.id))?.authorKind).toBe("agent");
    expect(await store.revisions(record.id)).toHaveLength(2);
  });
  it("proposals cannot supersede active memories before approval", async () => {
    const store = new MemoryStore(env.DB);
    const input = {
      ...personal,
      scope: { type: "repository" as const, repoOwner: "group/subgroup", repoName: "api" },
    };
    const original = await store.create(input, human, 123);
    const replacement = await store.create(
      { ...input, content: "Updated", supersedesMemoryId: original.id },
      agent,
      123
    );
    expect(replacement.status).toBe("proposed");
    expect((await store.get(original.id))?.status).toBe("active");
    await store.transition(replacement.id, "approve", replacement.currentRevisionId, human);
    expect((await store.get(original.id))?.archiveReason).toBe("superseded");
    expect((await store.get(replacement.id))?.status).toBe("active");
    await store.transition(replacement.id, "archive", replacement.currentRevisionId, human);
    expect(
      (await store.transition(replacement.id, "restore", replacement.currentRevisionId, human))
        .status
    ).toBe("active");
    expect((await store.get(original.id))?.status).toBe("archived");
  });
  it("approves only one competing replacement and rejects stale predecessors", async () => {
    const store = new MemoryStore(env.DB);
    const original = await store.create({ ...personal, memoryType: "directive" }, human);
    const proposals = await Promise.all(
      [1, 2].map((n) =>
        store.create(
          { ...personal, title: `Replacement ${n}`, supersedesMemoryId: original.id },
          agent
        )
      )
    );
    const decisions = await Promise.allSettled(
      proposals.map((record) =>
        store.transition(record.id, "approve", record.currentRevisionId, human)
      )
    );
    expect(decisions.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(
      (await store.list({ type: "personal" }, human.userId)).map(
        (record) => record.supersedesMemoryId
      )
    ).toEqual([original.id]);
  });
  it("enforces the total write quota even when records are archived", async () => {
    const store = new MemoryStore(env.DB);
    for (let n = 0; n < 20; n++) {
      const record = await store.create(personal, agent);
      await store.transition(record.id, "archive", record.currentRevisionId, human);
    }
    await expect(store.create(personal, agent)).rejects.toThrow(/limit/);
    expect(
      (await env.DB.prepare("SELECT COUNT(*) AS n FROM memory_revisions").first<{ n: number }>())?.n
    ).toBe(20);
  });
  it("fences personal autosave after a session was shared, even when made private again", async () => {
    const store = new MemoryStore(env.DB);
    await new SessionScopeStore(env.DB).updateVisibility(["session_a"], "workspace");
    await new SessionScopeStore(env.DB).updateVisibility(["session_a"], "private");
    await expect(store.create(personal, agent)).rejects.toThrow(/session access/);
    expect((await store.create(personal, { ...agent, allowPersonalAutoSave: false })).status).toBe(
      "proposed"
    );
  });
  it("does not let an auto-saved fact bypass directive approval through supersession", async () => {
    const store = new MemoryStore(env.DB);
    const directive = await store.create({ ...personal, memoryType: "directive" }, human);
    const replacement = await store.create(
      { ...personal, supersedesMemoryId: directive.id },
      agent
    );
    expect(replacement.status).toBe("proposed");
    expect((await store.get(directive.id))?.status).toBe("active");
  });
  it("restores previously active records as active but rejected proposals as proposed", async () => {
    const store = new MemoryStore(env.DB);
    const active = await store.create(personal, human);
    await store.transition(active.id, "archive", active.currentRevisionId, human, "Old");
    expect(
      (await store.transition(active.id, "restore", active.currentRevisionId, human)).status
    ).toBe("active");
    const proposal = await store.create({ ...personal, memoryType: "directive" }, agent);
    await store.transition(proposal.id, "reject", proposal.currentRevisionId, human);
    expect(
      (await store.transition(proposal.id, "restore", proposal.currentRevisionId, human)).status
    ).toBe("proposed");
  });
  it("serializes the pending quota and writes no orphan revisions or success audits", async () => {
    const store = new MemoryStore(env.DB);
    const outcomes = await Promise.allSettled(
      Array.from({ length: 8 }, () => store.create({ ...personal, memoryType: "directive" }, agent))
    );
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(5);
    expect(
      (await env.DB.prepare("SELECT COUNT(*) AS n FROM memory_revisions").first<{ n: number }>())?.n
    ).toBe(5);
    expect(
      (
        await env.DB.prepare(
          "SELECT COUNT(*) AS n FROM authorization_audit_events WHERE action = 'memory.created'"
        ).first<{ n: number }>()
      )?.n
    ).toBe(5);
  });
  it("keeps content and personal archive reasons out of workspace audit metadata", async () => {
    const store = new MemoryStore(env.DB);
    const record = await store.create({ ...personal, content: "private-content" }, human);
    await store.transition(record.id, "archive", record.currentRevisionId, human, "private-reason");
    const audits = await env.DB.prepare(
      "SELECT metadata_json FROM authorization_audit_events"
    ).all();
    expect(JSON.stringify(audits.results)).not.toContain("private-content");
    expect(JSON.stringify(audits.results)).not.toContain("private-reason");
  });
});
