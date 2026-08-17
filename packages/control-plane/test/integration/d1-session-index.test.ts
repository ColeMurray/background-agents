import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { SessionIndexStore } from "../../src/db/session-index";
import { SessionPullRequestStore } from "../../src/db/session-pull-request-store";
import type { SessionStatus } from "@open-inspect/shared/types/sessions";
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

  it("atomically admits only one concurrent terminal-child resume for one remaining slot", async () => {
    const store = new SessionIndexStore(env.DB);
    const now = Date.now();
    const create = (id: string, status: "active" | "completed") =>
      store.create({
        id,
        title: null,
        repoOwner: "acme",
        repoName: "repo",
        model: "anthropic/claude-haiku-4-5",
        reasoningEffort: null,
        baseBranch: "main",
        status,
        parentSessionId: id === "parent" ? null : "parent",
        createdAt: now,
        updatedAt: now,
      });
    await create("parent", "active");
    await create("active-child", "active");
    await create("terminal-child-1", "completed");
    await create("terminal-child-2", "completed");

    const results = await Promise.all([
      store.acquireChildAdmissionLease("parent", "terminal-child-1", 2),
      store.acquireChildAdmissionLease("parent", "terminal-child-2", 2),
    ]);

    expect(results.filter((result) => result !== null)).toHaveLength(1);
    expect(results.filter((result) => result === null)).toHaveLength(1);
  });

  it("uses one admission authority for a concurrent spawn and resume", async () => {
    const store = new SessionIndexStore(env.DB);
    const now = Date.now();
    await store.create({
      id: "parent",
      title: null,
      repoOwner: "acme",
      repoName: "repo",
      model: "anthropic/claude-haiku-4-5",
      reasoningEffort: null,
      baseBranch: "main",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });

    const results = await Promise.all([
      store.acquireChildAdmissionLease("parent", "new-spawn", 1),
      store.acquireChildAdmissionLease("parent", "terminal-resume", 1),
    ]);

    expect(results.filter((result) => result !== null)).toHaveLength(1);
    expect(results.filter((result) => result === null)).toHaveLength(1);
  });

  it("requires lease ownership to release child admission capacity", async () => {
    const store = new SessionIndexStore(env.DB);
    const now = Date.now();
    await store.create({
      id: "parent",
      title: null,
      repoOwner: "acme",
      repoName: "repo",
      model: "anthropic/claude-haiku-4-5",
      reasoningEffort: null,
      baseBranch: "main",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    const lease = await store.acquireChildAdmissionLease("parent", "child-1", 1);
    expect(lease).not.toBeNull();
    expect(await store.acquireChildAdmissionLease("parent", "child-1", 1)).toBeNull();

    await store.releaseChildAdmissionLease({
      ...lease!,
      token: "not-the-owner",
    });
    expect(await store.acquireChildAdmissionLease("parent", "child-2", 1)).toBeNull();

    await store.releaseChildAdmissionLease(lease!);
    expect(await store.acquireChildAdmissionLease("parent", "child-2", 1)).not.toBeNull();
  });

  describe("isRepositoryAssociated", () => {
    it("matches the scalar primary and session_repositories rows case-insensitively", async () => {
      const store = new SessionIndexStore(env.DB);
      const now = Date.now();

      await store.create({
        id: "assoc-session-1",
        title: null,
        repoOwner: "Acme",
        repoName: "Web-App",
        model: "anthropic/claude-haiku-4-5",
        reasoningEffort: null,
        baseBranch: "main",
        status: "active",
        createdAt: now,
        updatedAt: now,
        repositories: [
          { repoOwner: "Acme", repoName: "Web-App", repoId: 1, baseBranch: "main" },
          { repoOwner: "Acme", repoName: "Backend", repoId: 2, baseBranch: "main" },
        ],
      });

      expect(await store.isRepositoryAssociated("assoc-session-1", "acme", "web-app")).toBe(true);
      expect(await store.isRepositoryAssociated("assoc-session-1", "ACME", "BACKEND")).toBe(true);
      expect(await store.isRepositoryAssociated("assoc-session-1", "acme", "other-repo")).toBe(
        false
      );
      expect(await store.isRepositoryAssociated("missing-session", "acme", "web-app")).toBe(false);
    });

    it("matches the scalar primary for pre-multi-repo sessions without session_repositories rows", async () => {
      const store = new SessionIndexStore(env.DB);
      const now = Date.now();

      await store.create({
        id: "assoc-session-2",
        title: null,
        repoOwner: "acme",
        repoName: "solo",
        model: "anthropic/claude-haiku-4-5",
        reasoningEffort: null,
        baseBranch: null,
        status: "active",
        createdAt: now,
        updatedAt: now,
      });

      expect(await store.isRepositoryAssociated("assoc-session-2", "acme", "solo")).toBe(true);
      expect(await store.isRepositoryAssociated("assoc-session-2", "acme", "web-app")).toBe(false);
    });
  });

  it("attaches pullRequestSummary from session_pull_requests without reordering", async () => {
    const store = new SessionIndexStore(env.DB);
    const prStore = new SessionPullRequestStore(env.DB);
    const now = Date.now();

    for (const [id, updatedAt] of [
      ["summary-session-new", now],
      ["summary-session-old", now - 10_000],
    ] as const) {
      await store.create({
        id,
        title: null,
        repoOwner: "acme",
        repoName: "web-app",
        model: "anthropic/claude-haiku-4-5",
        reasoningEffort: null,
        baseBranch: null,
        status: "active",
        createdAt: now - 20_000,
        updatedAt,
      });
    }

    // Two PRs on the OLDER session — its list position must not change.
    for (const [artifactId, prNumber, lifecycleState, isDraft] of [
      ["summary-artifact-1", 1, "open", true],
      ["summary-artifact-2", 2, "merged", false],
    ] as const) {
      await prStore.upsert({
        artifactId,
        sessionId: "summary-session-old",
        repositoryExternalId: String(prNumber),
        repoOwner: "acme",
        repoName: "web-app",
        prNumber,
        url: `https://github.com/acme/web-app/pull/${prNumber}`,
        lifecycleState,
        isDraft,
        headBranch: "open-inspect/summary-session-old",
        baseBranch: "main",
        headSha: null,
        providerCreatedAt: null,
        providerUpdatedAt: null,
        mergedAt: null,
        closedAt: null,
        createdAt: now,
        updatedAt: now,
      });
    }

    const { sessions } = await store.list();

    expect(sessions.map((session) => session.id)).toEqual([
      "summary-session-new",
      "summary-session-old",
    ]);
    expect(sessions[0].pullRequestSummary).toBeUndefined();
    expect(sessions[1].pullRequestSummary).toEqual({
      total: 2,
      open: 0,
      draft: 1,
      merged: 1,
      closed: 0,
    });
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
    expect(allResult.sessions.length).toBe(2);
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

  it("stores and retrieves scmLogin", async () => {
    const store = new SessionIndexStore(env.DB);
    const now = Date.now();

    await store.create({
      id: "session-with-login",
      title: null,
      repoOwner: "acme",
      repoName: "api",
      model: "anthropic/claude-haiku-4-5",
      reasoningEffort: null,
      baseBranch: null,
      status: "created",
      scmLogin: "testuser",
      createdAt: now,
      updatedAt: now,
    });

    const session = await store.get("session-with-login");
    expect(session).not.toBeNull();
    expect(session!.scmLogin).toBe("testuser");
  });

  it("defaults scmLogin to null when omitted", async () => {
    const store = new SessionIndexStore(env.DB);
    const now = Date.now();

    await store.create({
      id: "session-no-login",
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

    const session = await store.get("session-no-login");
    expect(session).not.toBeNull();
    expect(session!.scmLogin).toBeNull();
  });

  it("updates and retrieves session metrics", async () => {
    const store = new SessionIndexStore(env.DB);
    const now = Date.now();

    await store.create({
      id: "session-metrics",
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

    // Verify defaults
    const before = await store.get("session-metrics");
    expect(before!.totalCost).toBe(0);
    expect(before!.activeDurationMs).toBe(0);
    expect(before!.messageCount).toBe(0);
    expect(before!.prCount).toBe(0);

    // Update metrics
    const updated = await store.updateMetrics("session-metrics", {
      totalCost: 1.25,
      activeDurationMs: 120000,
      messageCount: 5,
      prCount: 1,
    });
    expect(updated).toBe(true);

    // Verify updated values
    const after = await store.get("session-metrics");
    expect(after!.totalCost).toBe(1.25);
    expect(after!.activeDurationMs).toBe(120000);
    expect(after!.messageCount).toBe(5);
    expect(after!.prCount).toBe(1);
  });

  it("updateMetrics overwrites on repeated calls (last write wins)", async () => {
    const store = new SessionIndexStore(env.DB);
    const now = Date.now();

    await store.create({
      id: "session-metrics-overwrite",
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

    await store.updateMetrics("session-metrics-overwrite", {
      totalCost: 0.5,
      activeDurationMs: 60000,
      messageCount: 3,
      prCount: 0,
    });

    await store.updateMetrics("session-metrics-overwrite", {
      totalCost: 1.75,
      activeDurationMs: 180000,
      messageCount: 8,
      prCount: 2,
    });

    const session = await store.get("session-metrics-overwrite");
    expect(session!.totalCost).toBe(1.75);
    expect(session!.activeDurationMs).toBe(180000);
    expect(session!.messageCount).toBe(8);
    expect(session!.prCount).toBe(2);
  });

  it("updateMetrics returns false for non-existent session", async () => {
    const store = new SessionIndexStore(env.DB);
    const result = await store.updateMetrics("nonexistent", {
      totalCost: 1,
      activeDurationMs: 1000,
      messageCount: 1,
      prCount: 0,
    });
    expect(result).toBe(false);
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

  it("rejects stale status updates when a newer status write exists", async () => {
    const store = new SessionIndexStore(env.DB);

    await store.create({
      id: "status-ordering-1",
      title: "Ordering",
      repoOwner: "acme",
      repoName: "worker",
      model: "anthropic/claude-haiku-4-5",
      reasoningEffort: null,
      baseBranch: null,
      status: "active",
      createdAt: 1000,
      updatedAt: 1000,
    });

    const latestApplied = await store.updateStatus("status-ordering-1", "completed", 3000);
    expect(latestApplied).toBe(true);

    const staleApplied = await store.updateStatus("status-ordering-1", "failed", 2000);
    expect(staleApplied).toBe(false);

    const row = await store.get("status-ordering-1");
    expect(row?.status).toBe("completed");
    expect(row?.updatedAt).toBe(3000);
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

    it("listByParent attaches pull request summaries to children", async () => {
      const now = Date.now();
      await new SessionPullRequestStore(env.DB).upsert({
        artifactId: "child-pr-artifact",
        sessionId: childId1,
        repositoryExternalId: "1",
        repoOwner: "owner",
        repoName: "repo",
        prNumber: 42,
        url: "https://github.com/owner/repo/pull/42",
        lifecycleState: "open",
        isDraft: false,
        headBranch: "open-inspect/child-session-1",
        baseBranch: "main",
        headSha: null,
        providerCreatedAt: null,
        providerUpdatedAt: null,
        mergedAt: null,
        closedAt: null,
        createdAt: now,
        updatedAt: now,
      });

      const children = await store.listByParent(parentId);

      expect(children.find((child) => child.id === childId1)?.pullRequestSummary).toEqual({
        total: 1,
        open: 1,
        draft: 0,
        merged: 0,
        closed: 0,
      });
      expect(children.find((child) => child.id === childId2)?.pullRequestSummary).toBeUndefined();
    });

    it("listByParent returns empty array when no children exist", async () => {
      const children = await store.listByParent("nonexistent-parent");
      expect(children).toEqual([]);
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

  describe("userId", () => {
    it("stores and retrieves userId", async () => {
      const store = new SessionIndexStore(env.DB);
      const now = Date.now();

      await store.create({
        id: "session-with-user",
        title: "User-linked session",
        repoOwner: "acme",
        repoName: "web-app",
        model: "anthropic/claude-haiku-4-5",
        reasoningEffort: null,
        baseBranch: null,
        status: "created",
        userId: "canonical-user-id",
        createdAt: now,
        updatedAt: now,
      });

      const session = await store.get("session-with-user");
      expect(session).not.toBeNull();
      expect(session!.userId).toBe("canonical-user-id");
    });

    it("defaults userId to null when omitted", async () => {
      const store = new SessionIndexStore(env.DB);
      const now = Date.now();

      await store.create({
        id: "session-no-user",
        title: "No user",
        repoOwner: "acme",
        repoName: "web-app",
        model: "anthropic/claude-haiku-4-5",
        reasoningEffort: null,
        baseBranch: null,
        status: "created",
        createdAt: now,
        updatedAt: now,
      });

      const session = await store.get("session-no-user");
      expect(session).not.toBeNull();
      expect(session!.userId).toBeNull();
    });
  });

  it("excludes automation descendants after their root is deleted", async () => {
    const store = new SessionIndexStore(env.DB);
    const now = Date.now();
    const baseSession = {
      title: null,
      repoOwner: "acme",
      repoName: "web-app",
      model: "anthropic/claude-haiku-4-5",
      reasoningEffort: null,
      baseBranch: "main",
      status: "completed" as const,
      userId: "user-1",
      createdAt: now,
    };

    await store.create({
      ...baseSession,
      id: "automation-root",
      spawnSource: "automation",
      automationId: "automation-1",
      automationRunId: "run-1",
      updatedAt: now - 1,
    });
    await store.create({
      ...baseSession,
      id: "automation-child",
      parentSessionId: "automation-root",
      spawnSource: "agent",
      automationId: "automation-1",
      automationRunId: "run-1",
      updatedAt: now,
    });
    await store.create({
      ...baseSession,
      id: "manual-session",
      spawnSource: "user",
      updatedAt: now - 2,
    });
    await store.delete("automation-root");

    const result = await store.list({
      createdByUserIds: ["user-1"],
      excludeAutomationLineage: true,
    });

    expect(result.sessions.map((session) => session.id)).toEqual(["manual-session"]);
  });

  it("excludes github-bot sessions attributed to the user from lineage-filtered lists", async () => {
    const store = new SessionIndexStore(env.DB);
    const now = Date.now();
    const baseSession = {
      title: null,
      repoOwner: "acme",
      repoName: "web-app",
      model: "anthropic/claude-haiku-4-5",
      reasoningEffort: null,
      baseBranch: "main",
      status: "completed" as const,
      userId: "user-1",
      createdAt: now,
    };

    await store.create({
      ...baseSession,
      id: "auto-review",
      spawnSource: "github-bot",
      updatedAt: now,
    });
    await store.create({
      ...baseSession,
      id: "manual-session",
      spawnSource: "user",
      updatedAt: now - 1,
    });

    const filtered = await store.list({
      createdByUserIds: ["user-1"],
      excludeAutomationLineage: true,
    });
    expect(filtered.sessions.map((session) => session.id)).toEqual(["manual-session"]);

    const unfiltered = await store.list({ createdByUserIds: ["user-1"] });
    expect(unfiltered.sessions.map((session) => session.id)).toEqual([
      "auto-review",
      "manual-session",
    ]);
  });

  describe("listAbandonedDraftSessionIds", () => {
    const HOUR_MS = 60 * 60 * 1000;

    async function seedSession(
      store: SessionIndexStore,
      id: string,
      status: SessionStatus,
      updatedAt: number
    ): Promise<void> {
      await store.create({
        id,
        title: id,
        repoOwner: "acme",
        repoName: "web-app",
        model: "anthropic/claude-haiku-4-5",
        reasoningEffort: null,
        baseBranch: null,
        status,
        createdAt: updatedAt,
        updatedAt,
      });
    }

    it("selects only drafts left untouched past the cutoff", async () => {
      const store = new SessionIndexStore(env.DB);
      const now = Date.now();
      const cutoff = now - 24 * HOUR_MS;

      await seedSession(store, "stale-draft", "created", now - 48 * HOUR_MS);
      await seedSession(store, "fresh-draft", "created", now - HOUR_MS);
      await seedSession(store, "stale-active", "active", now - 48 * HOUR_MS);
      await seedSession(store, "stale-completed", "completed", now - 48 * HOUR_MS);
      await seedSession(store, "stale-archived", "archived", now - 48 * HOUR_MS);

      const ids = await store.listAbandonedDraftSessionIds(cutoff, 50);

      expect(ids).toEqual(["stale-draft"]);
    });

    it("returns the oldest drafts first and honours the limit", async () => {
      const store = new SessionIndexStore(env.DB);
      const now = Date.now();

      await seedSession(store, "middle", "created", now - 48 * HOUR_MS);
      await seedSession(store, "oldest", "created", now - 72 * HOUR_MS);
      await seedSession(store, "newest", "created", now - 25 * HOUR_MS);

      const ids = await store.listAbandonedDraftSessionIds(now - 24 * HOUR_MS, 2);

      expect(ids).toEqual(["oldest", "middle"]);
    });

    it("archives an orphaned draft so the batch advances past it", async () => {
      // The end-to-end shape of the head-of-line bug. Reading oldest-first is
      // only correct if a visited row leaves the candidate set; a row that could
      // never be expired used to hold the head and starve everything behind it.
      const store = new SessionIndexStore(env.DB);
      const now = Date.now();
      const cutoff = now - 24 * HOUR_MS;

      await seedSession(store, "orphan", "created", now - 72 * HOUR_MS);
      await seedSession(store, "behind-it", "created", now - 48 * HOUR_MS);
      expect(await store.listAbandonedDraftSessionIds(cutoff, 1)).toEqual(["orphan"]);

      expect(await store.archiveOrphanedDraft("orphan")).toBe(true);

      expect((await store.get("orphan"))!.status).toBe("archived");
      expect(await store.listAbandonedDraftSessionIds(cutoff, 1)).toEqual(["behind-it"]);
    });

    it("refuses to archive a row that has left the draft status", async () => {
      const store = new SessionIndexStore(env.DB);
      const now = Date.now();

      await seedSession(store, "started", "active", now - 48 * HOUR_MS);

      expect(await store.archiveOrphanedDraft("started")).toBe(false);
      expect((await store.get("started"))!.status).toBe("active");
    });
  });

  describe("repairStatus", () => {
    const HOUR_MS = 60 * 60 * 1000;

    async function seedDraft(store: SessionIndexStore, id: string, updatedAt: number) {
      await store.create({
        id,
        title: id,
        repoOwner: "acme",
        repoName: "web-app",
        model: "anthropic/claude-haiku-4-5",
        reasoningEffort: null,
        baseBranch: null,
        status: "created",
        createdAt: updatedAt,
        updatedAt,
      });
    }

    it("projects a diverged status without claiming new activity", async () => {
      const store = new SessionIndexStore(env.DB);
      const updatedAt = Date.now() - 48 * HOUR_MS;
      await seedDraft(store, "diverged", updatedAt);

      expect(await store.repairStatus("diverged", "completed")).toBe(true);

      const session = await store.get("diverged");
      expect(session!.status).toBe("completed");
      // `updated_at` is user-visible recency, maintained by touchUpdatedAt on
      // real activity. A repair is bookkeeping, so it must not reorder the list.
      expect(session!.updatedAt).toBe(updatedAt);
    });

    it("lands even when the index is newer than the durable object", async () => {
      // The regression this method exists for. updateStatus guards on
      // `updated_at <= ?` to keep out-of-order async writes from winning, but a
      // repair carries the durable object's own timestamp — which is older than
      // D1 whenever touchUpdatedAt has run. The guard then drops the write and
      // reports zero changes, leaving the row selectable forever.
      const store = new SessionIndexStore(env.DB);
      const durableObjectUpdatedAt = Date.now() - 48 * HOUR_MS;
      await seedDraft(store, "index-ahead", durableObjectUpdatedAt);
      await store.touchUpdatedAt("index-ahead");

      expect(await store.updateStatus("index-ahead", "completed", durableObjectUpdatedAt)).toBe(
        false
      );

      expect(await store.repairStatus("index-ahead", "completed")).toBe(true);
      expect((await store.get("index-ahead"))!.status).toBe("completed");
    });

    it("reports no change when the index already agrees", async () => {
      const store = new SessionIndexStore(env.DB);
      await seedDraft(store, "agreed", Date.now() - 48 * HOUR_MS);

      expect(await store.repairStatus("agreed", "created")).toBe(false);
    });

    it("does not overwrite a newer non-draft projection", async () => {
      const store = new SessionIndexStore(env.DB);
      await seedDraft(store, "advanced", Date.now() - 48 * HOUR_MS);
      expect(await store.updateStatus("advanced", "active", Date.now())).toBe(true);

      expect(await store.repairStatus("advanced", "completed")).toBe(false);
      expect((await store.get("advanced"))!.status).toBe("active");
    });
  });
});
