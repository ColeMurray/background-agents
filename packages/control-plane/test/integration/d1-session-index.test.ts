import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { SessionIndexStore } from "../../src/db/session-index";
import { cleanD1Tables } from "./cleanup";

describe("D1 SessionIndexStore", () => {
  beforeEach(cleanD1Tables);

  it("creates and retrieves a session", async () => {
    const store = new SessionIndexStore(env.DB);
    const now = Date.now();

    await store.create({
      id: "test-session-1",
      title: "Test Session",
      repoOwner: "acme",
      repoName: "web-app",
      model: "anthropic/claude-haiku-4-5",
      reasoningEffort: "max",
      baseBranch: null,
      status: "created",
      createdAt: now,
      updatedAt: now,
    });

    const session = await store.get("test-session-1");
    expect(session).not.toBeNull();
    expect(session!.id).toBe("test-session-1");
    expect(session!.title).toBe("Test Session");
    expect(session!.repoOwner).toBe("acme");
    expect(session!.repoName).toBe("web-app");
    expect(session!.reasoningEffort).toBe("max");
    expect(session!.status).toBe("created");
  });

  it("lists sessions with status filter", async () => {
    const store = new SessionIndexStore(env.DB);
    const now = Date.now();

    await store.create({
      id: "session-active-1",
      title: null,
      repoOwner: "acme",
      repoName: "api",
      model: "anthropic/claude-haiku-4-5",
      reasoningEffort: null,
      baseBranch: null,
      status: "active",
      createdAt: now,
      updatedAt: now,
    });

    await store.create({
      id: "session-completed-1",
      title: null,
      repoOwner: "acme",
      repoName: "api",
      model: "anthropic/claude-haiku-4-5",
      reasoningEffort: null,
      baseBranch: null,
      status: "completed",
      createdAt: now - 1000,
      updatedAt: now - 1000,
    });

    const activeResult = await store.list({ status: "active" });
    expect(activeResult.sessions.length).toBe(1);
    expect(activeResult.sessions[0].id).toBe("session-active-1");

    const allResult = await store.list({});
    expect(allResult.total).toBe(2);
  });

  it("stores and returns reasoning effort", async () => {
    const store = new SessionIndexStore(env.DB);
    const now = Date.now();

    await store.create({
      id: "session-with-effort",
      title: null,
      repoOwner: "acme",
      repoName: "api",
      model: "anthropic/claude-sonnet-4-5",
      reasoningEffort: "high",
      baseBranch: null,
      status: "created",
      createdAt: now,
      updatedAt: now,
    });

    const session = await store.get("session-with-effort");
    expect(session!.reasoningEffort).toBe("high");

    const result = await store.list({});
    const listed = result.sessions.find((s) => s.id === "session-with-effort");
    expect(listed!.reasoningEffort).toBe("high");
  });

  it("stores null reasoning effort when not provided", async () => {
    const store = new SessionIndexStore(env.DB);
    const now = Date.now();

    await store.create({
      id: "session-no-effort",
      title: null,
      repoOwner: "acme",
      repoName: "api",
      model: "anthropic/claude-haiku-4-5",
      reasoningEffort: null,
      baseBranch: null,
      status: "created",
      createdAt: now,
      updatedAt: now,
    });

    const session = await store.get("session-no-effort");
    expect(session!.reasoningEffort).toBeNull();
  });

  it("deletes a session", async () => {
    const store = new SessionIndexStore(env.DB);
    const now = Date.now();

    await store.create({
      id: "session-to-delete",
      title: null,
      repoOwner: "acme",
      repoName: "web-app",
      model: "anthropic/claude-haiku-4-5",
      reasoningEffort: null,
      baseBranch: null,
      status: "created",
      createdAt: now,
      updatedAt: now,
    });

    const deleted = await store.delete("session-to-delete");
    expect(deleted).toBe(true);

    const session = await store.get("session-to-delete");
    expect(session).toBeNull();
  });

  describe("parent/child queries", () => {
    const store = new SessionIndexStore(env.DB);
    const parentId = "parent-session-1";
    const childId1 = "child-session-1";
    const childId2 = "child-session-2";

    beforeEach(async () => {
      await cleanD1Tables();

      const now = Date.now();

      // Seed parent
      await store.create({
        id: parentId,
        title: "Parent",
        repoOwner: "owner",
        repoName: "repo",
        model: "anthropic/claude-sonnet-4-6",
        reasoningEffort: null,
        baseBranch: null,
        status: "active",
        parentSessionId: null,
        spawnSource: "user",
        spawnDepth: 0,
        createdAt: now,
        updatedAt: now,
      });

      // Seed child 1 (active)
      await store.create({
        id: childId1,
        title: "Child 1",
        repoOwner: "owner",
        repoName: "repo",
        model: "anthropic/claude-sonnet-4-6",
        reasoningEffort: null,
        baseBranch: null,
        status: "created",
        parentSessionId: parentId,
        spawnSource: "agent",
        spawnDepth: 1,
        createdAt: now,
        updatedAt: now,
      });

      // Seed child 2 (completed)
      await store.create({
        id: childId2,
        title: "Child 2",
        repoOwner: "owner",
        repoName: "repo",
        model: "anthropic/claude-sonnet-4-6",
        reasoningEffort: null,
        baseBranch: null,
        status: "completed",
        parentSessionId: parentId,
        spawnSource: "agent",
        spawnDepth: 1,
        createdAt: now + 1,
        updatedAt: now + 1,
      });
    });

    it("listByParent returns children newest-first", async () => {
      const children = await store.listByParent(parentId);
      expect(children).toHaveLength(2);
      expect(children[0].id).toBe(childId2); // newer
      expect(children[1].id).toBe(childId1); // older
    });

    it("listByParent returns empty array when no children exist", async () => {
      const children = await store.listByParent("nonexistent-parent");
      expect(children).toEqual([]);
    });

    it("countActiveChildren excludes completed/archived/cancelled", async () => {
      const count = await store.countActiveChildren(parentId);
      expect(count).toBe(1); // child1 is "created" (active), child2 is "completed" (excluded)
    });

    it("countTotalChildren counts all children regardless of status", async () => {
      const count = await store.countTotalChildren(parentId);
      expect(count).toBe(2);
    });

    it("isChildOf returns true for valid parent-child pair", async () => {
      const result = await store.isChildOf(childId1, parentId);
      expect(result).toBe(true);
    });

    it("isChildOf returns false for unrelated sessions", async () => {
      const result = await store.isChildOf(childId1, "unrelated-session");
      expect(result).toBe(false);
    });

    it("isChildOf returns false for reversed parent-child", async () => {
      const result = await store.isChildOf(parentId, childId1);
      expect(result).toBe(false);
    });

    it("getSpawnDepth returns stored depth", async () => {
      const depth = await store.getSpawnDepth(childId1);
      expect(depth).toBe(1);
    });

    it("getSpawnDepth returns 0 for top-level session", async () => {
      const depth = await store.getSpawnDepth(parentId);
      expect(depth).toBe(0);
    });

    it("getSpawnDepth returns 0 for unknown session", async () => {
      const depth = await store.getSpawnDepth("nonexistent");
      expect(depth).toBe(0);
    });

    it("create stores parent fields and get retrieves them", async () => {
      const child = await store.get(childId1);
      expect(child).not.toBeNull();
      expect(child!.parentSessionId).toBe(parentId);
      expect(child!.spawnSource).toBe("agent");
      expect(child!.spawnDepth).toBe(1);
    });
  });
});
