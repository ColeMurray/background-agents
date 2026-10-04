import { beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import type { MemoryContent } from "@open-inspect/shared/types/memories";
import { MemoryRecordStore, type NewMemory } from "../../src/db/memory-records";
import type { MemoryPartition } from "../../src/memory/partition";
import type { MemoryActor } from "../../src/memory/types";
import { cleanD1Tables } from "./cleanup";
import { memorySelectorForTest, seedMemorySession } from "./memory-test-helpers";
import { seedActiveUser } from "./helpers";
import { SessionScopeStore } from "../../src/db/session-scope-store";

const human: MemoryActor = { kind: "user", userId: "user_a", requestId: "test" };
const agent: MemoryActor = {
  kind: "agent",
  userId: "user_a",
  sessionId: "session_a",
  requestId: "tool",
};
/** session_a is private and collaborator-free, so its personal facts may skip review. */
const AUTO_SAVE = { personalAutoSaveEligible: true };
const owner: MemoryPartition = { type: "personal", userId: "user_a" };
const fact: MemoryContent = {
  memoryType: "fact",
  title: "Test setup",
  description: "How to run integration tests",
  content: "Use the local database",
};
/** A personal fact for user_a, with optional content changes and replacement link. */
function memory(content: Partial<MemoryContent> = {}, extra: Partial<NewMemory> = {}): NewMemory {
  return {
    partition: owner,
    scope: { type: "personal" },
    content: { ...fact, ...content },
    ...extra,
  };
}
const page = { status: "active" as const, offset: 0, limit: 50 };

describe("memory persistence", () => {
  beforeEach(async () => {
    await cleanD1Tables();
    await seedActiveUser("user_a");
    await seedMemorySession("session_a", {
      userId: "user_a",
      status: "created",
      repositories: [
        { repoOwner: "group/subgroup", repoName: "api", repoId: 123, baseBranch: "main" },
      ],
    });
  });
  it("bounds candidate queries, omits fact bodies, and counts every omitted record", async () => {
    const store = new MemoryRecordStore(env.DB);
    for (let i = 0; i < 230; i++)
      await store.create(memory({ title: `Fact ${i}`, content: "x".repeat(20_000) }), human);
    for (let i = 0; i < 120; i++)
      await store.create(
        memory({ memoryType: "directive", title: `Directive ${i}`, content: "x" }),
        human
      );
    const { candidates, omittedCount } = await store.listCandidates([owner]);
    expect(candidates).toHaveLength(300);
    expect(omittedCount).toBe(50);
    expect(
      candidates
        .filter((candidate) => candidate.memoryType === "fact")
        .every((candidate) => candidate.content === null)
    ).toBe(true);
    const manifest = await memorySelectorForTest().select({
      principal: { userId: human.userId, ownerTeamId: null },
      repositories: [],
      environmentId: null,
      includePersonalMemories: true,
    });
    expect(manifest.items).toHaveLength(300);
    expect(manifest.omittedCount).toBe(50);
  });
  it("revises without replacing provenance and rejects concurrent stale edits", async () => {
    const store = new MemoryRecordStore(env.DB);
    const record = await store.create(memory(), agent, AUTO_SAVE);
    expect(record.status).toBe("active");
    const unchanged = await store.revise(record.id, fact, record.currentRevisionId, human);
    expect(unchanged.currentRevisionId).toBe(record.currentRevisionId);
    const outcomes = await Promise.allSettled(
      ["one", "two"].map((content) =>
        store.revise(record.id, { ...fact, content }, record.currentRevisionId, human)
      )
    );
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect((await store.get(record.id))?.authorKind).toBe("agent");
    expect(await store.revisions(record.id)).toHaveLength(2);
  });
  it("proposals cannot supersede active memories before approval", async () => {
    const store = new MemoryRecordStore(env.DB);
    // The stored display name differs from the session's: partitions match on the stable ID.
    const input = memory(
      {},
      {
        partition: { type: "repository", repoId: 123 },
        scope: { type: "repository", repoOwner: "old-owner", repoName: "api" },
      }
    );
    const original = await store.create(input, human);
    const replacement = await store.create(
      { ...input, content: { ...fact, content: "Updated" }, supersedesMemoryId: original.id },
      agent
    );
    expect(replacement.status).toBe("proposed");
    expect((await store.get(original.id))?.status).toBe("active");
    await store.transition(replacement.id, "approve", replacement.currentRevisionId, human);
    expect((await store.get(original.id))?.archiveKind).toBe("superseded");
    expect((await store.get(replacement.id))?.status).toBe("active");
    await store.transition(replacement.id, "archive", replacement.currentRevisionId, human);
    expect(
      (await store.transition(replacement.id, "restore", replacement.currentRevisionId, human))
        .status
    ).toBe("active");
    expect((await store.get(original.id))?.status).toBe("archived");
  });
  it("approves only one competing replacement and rejects stale predecessors", async () => {
    const store = new MemoryRecordStore(env.DB);
    const original = await store.create(memory({ memoryType: "directive" }), human);
    const proposals = await Promise.all(
      [1, 2].map((n) =>
        store.create(
          memory({ title: `Replacement ${n}` }, { supersedesMemoryId: original.id }),
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
    expect((await store.list(owner, page)).map((record) => record.supersedesMemoryId)).toEqual([
      original.id,
    ]);
  });
  it("enforces the total write quota even when records are archived", async () => {
    const store = new MemoryRecordStore(env.DB);
    for (let n = 0; n < 20; n++) {
      const record = await store.create(memory(), agent, AUTO_SAVE);
      await store.transition(record.id, "archive", record.currentRevisionId, human);
    }
    await expect(store.create(memory(), agent, AUTO_SAVE)).rejects.toThrow(/limit/);
    expect(
      (await env.DB.prepare("SELECT COUNT(*) AS n FROM memory_revisions").first<{ n: number }>())?.n
    ).toBe(20);
  });
  it("preserves one active record across restored predecessors and multi-generation replacements", async () => {
    const store = new MemoryRecordStore(env.DB);
    const a = await store.create(memory(), human);
    const b = await store.create(memory({}, { supersedesMemoryId: a.id }), human);
    await expect(store.transition(a.id, "restore", a.currentRevisionId, human)).rejects.toThrow(
      /replacement/
    );
    const c = await store.create(memory({}, { supersedesMemoryId: b.id }), human);
    await expect(store.transition(a.id, "restore", a.currentRevisionId, human)).rejects.toThrow(
      /replacement/
    );
    await expect(store.transition(b.id, "restore", b.currentRevisionId, human)).rejects.toThrow(
      /replacement/
    );
    await store.transition(c.id, "archive", c.currentRevisionId, human);
    const restored = await Promise.allSettled(
      [a, b, c].map((record) =>
        store.transition(record.id, "restore", record.currentRevisionId, human)
      )
    );
    expect(restored.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(await store.list(owner, page)).toHaveLength(1);
  });
  it("fences personal autosave after a session was shared, even when made private again", async () => {
    const store = new MemoryRecordStore(env.DB);
    await new SessionScopeStore(env.DB).updateVisibility(["session_a"], "workspace");
    await new SessionScopeStore(env.DB).updateVisibility(["session_a"], "private");
    await expect(store.create(memory(), agent, AUTO_SAVE)).rejects.toThrow(/session access/);
    expect((await store.create(memory(), agent)).status).toBe("proposed");
  });
  it("does not let an auto-saved fact bypass directive approval through supersession", async () => {
    const store = new MemoryRecordStore(env.DB);
    const directive = await store.create(memory({ memoryType: "directive" }), human);
    const replacement = await store.create(
      memory({}, { supersedesMemoryId: directive.id }),
      agent,
      AUTO_SAVE
    );
    expect(replacement.status).toBe("proposed");
    expect((await store.get(directive.id))?.status).toBe("active");
  });
  it("restores previously active records as active but rejected proposals as proposed", async () => {
    const store = new MemoryRecordStore(env.DB);
    const active = await store.create(memory(), human);
    await store.transition(active.id, "archive", active.currentRevisionId, human, "Old");
    expect(
      (await store.transition(active.id, "restore", active.currentRevisionId, human)).status
    ).toBe("active");
    const proposal = await store.create(memory({ memoryType: "directive" }), agent, AUTO_SAVE);
    const rejected = await store.transition(
      proposal.id,
      "reject",
      proposal.currentRevisionId,
      human
    );
    expect(rejected).toMatchObject({ status: "archived", archiveKind: "rejected" });
    expect(
      (await store.transition(proposal.id, "restore", proposal.currentRevisionId, human)).status
    ).toBe("proposed");
  });
  it("serializes the pending quota and writes no orphan revisions or success audits", async () => {
    const store = new MemoryRecordStore(env.DB);
    const outcomes = await Promise.allSettled(
      Array.from({ length: 8 }, () =>
        store.create(memory({ memoryType: "directive" }), agent, AUTO_SAVE)
      )
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
  it.each(["human", "proposal"])(
    "audits the predecessor revision for a %s replacement",
    async (kind) => {
      const store = new MemoryRecordStore(env.DB);
      const original = await store.create(memory(), human);
      const replacement = await store.create(
        memory({}, { supersedesMemoryId: original.id }),
        kind === "human" ? human : agent
      );
      if (kind === "proposal")
        await store.transition(replacement.id, "approve", replacement.currentRevisionId, human);
      const audit = await env.DB.prepare(
        "SELECT metadata_json FROM authorization_audit_events WHERE action = 'memory.superseded' AND resource_id = ?"
      )
        .bind(original.id)
        .first<{ metadata_json: string }>();
      expect(JSON.parse(audit!.metadata_json).after).toMatchObject({
        revisionId: original.currentRevisionId,
        status: "archived",
      });
      expect(
        (await store.revisions(original.id)).some(
          (revision) => revision.id === JSON.parse(audit!.metadata_json).after.revisionId
        )
      ).toBe(true);
    }
  );
  it("keeps content and personal archive reasons out of workspace audit metadata", async () => {
    const store = new MemoryRecordStore(env.DB);
    const record = await store.create(memory({ content: "private-content" }), human);
    await store.transition(record.id, "archive", record.currentRevisionId, human, "private-reason");
    const audits = await env.DB.prepare(
      "SELECT metadata_json FROM authorization_audit_events"
    ).all();
    expect(JSON.stringify(audits.results)).not.toContain("private-content");
    expect(JSON.stringify(audits.results)).not.toContain("private-reason");
  });
});
