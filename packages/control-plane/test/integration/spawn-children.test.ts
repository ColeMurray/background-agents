import { describe, it, expect, beforeEach } from "vitest";
import { SELF, env } from "cloudflare:test";
import { SessionIndexStore } from "../../src/db/session-index";
import { cleanD1Tables } from "./cleanup";
import { initNamedSession, seedSandboxAuth } from "./helpers";

describe("POST /sessions/:parentId/children — spawn child", () => {
  beforeEach(cleanD1Tables);

  /** Sets up a parent DO + sandbox auth + D1 row, returns everything needed for spawn tests. */
  async function setupParent(opts?: {
    repoId?: number;
    userId?: string;
    scmLogin?: string;
    spawnDepth?: number;
    parentSessionId?: string;
    spawnSource?: "user" | "agent";
  }) {
    const parentName = `parent-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const { stub } = await initNamedSession(parentName, {
      repoOwner: "acme",
      repoName: "web-app",
      ...(opts?.repoId != null && { repoId: opts.repoId }),
      ...(opts?.userId != null && { userId: opts.userId }),
      ...(opts?.scmLogin != null && { scmLogin: opts.scmLogin }),
    });

    const sandboxToken = `sb-tok-${Date.now()}`;
    await seedSandboxAuth(stub, { authToken: sandboxToken, sandboxId: `sb-${Date.now()}` });

    const store = new SessionIndexStore(env.DB);
    const now = Date.now();
    await store.create({
      id: parentName,
      title: "Parent",
      repoOwner: "acme",
      repoName: "web-app",
      model: "anthropic/claude-sonnet-4-6",
      reasoningEffort: null,
      baseBranch: null,
      status: "active",
      parentSessionId: opts?.parentSessionId ?? null,
      spawnSource: opts?.spawnSource ?? "user",
      spawnDepth: opts?.spawnDepth ?? 0,
      createdAt: now,
      updatedAt: now,
    });

    return { parentName, stub, sandboxToken, store, now };
  }

  it("spawns a child session with sandbox auth (201)", async () => {
    const { parentName, sandboxToken, store } = await setupParent({
      repoId: 12345,
      userId: "user-1",
      scmLogin: "acmedev",
    });

    const res = await SELF.fetch(`https://test.local/sessions/${parentName}/children`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${sandboxToken}`,
      },
      body: JSON.stringify({
        title: "Fix the tests",
        prompt: "Please fix the failing tests in src/utils.ts",
      }),
    });

    expect(res.status).toBe(201);
    const body = await res.json<{ sessionId: string; status: string }>();
    expect(body.status).toBe("created");
    expect(body.sessionId).toEqual(expect.any(String));

    // Verify D1 row was created for the child
    const child = await store.get(body.sessionId);
    expect(child).not.toBeNull();
    expect(child!.parentSessionId).toBe(parentName);
    expect(child!.spawnSource).toBe("agent");
    expect(child!.spawnDepth).toBe(1);
    expect(child!.repoOwner).toBe("acme");
    expect(child!.repoName).toBe("web-app");

    // Verify the child DO was initialized by querying its /internal/state
    const childDoId = env.SESSION.idFromName(body.sessionId);
    const childStub = env.SESSION.get(childDoId);
    const stateRes = await childStub.fetch("http://internal/internal/state");
    expect(stateRes.status).toBe(200);
    const state = await stateRes.json<{ repoOwner: string; status: string }>();
    expect(state.repoOwner).toBe("acme");
    expect(state.status).toBe("created");
  });

  it("rejects when depth >= 2 (403)", async () => {
    const { parentName, sandboxToken } = await setupParent({
      spawnDepth: 2,
      parentSessionId: "grandparent-1",
      spawnSource: "agent",
    });

    const res = await SELF.fetch(`https://test.local/sessions/${parentName}/children`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${sandboxToken}`,
      },
      body: JSON.stringify({
        title: "Too deep",
        prompt: "This should be rejected",
      }),
    });

    expect(res.status).toBe(403);
    const body = await res.json<{ error: string }>();
    expect(body.error).toContain("depth");
  });

  it("rejects when concurrent children >= 5 (429)", async () => {
    const { parentName, sandboxToken, store, now } = await setupParent();

    // Seed 5 active children in D1
    for (let i = 0; i < 5; i++) {
      await store.create({
        id: `child-active-${i}-${Date.now()}`,
        title: `Active Child ${i}`,
        repoOwner: "acme",
        repoName: "web-app",
        model: "anthropic/claude-sonnet-4-6",
        reasoningEffort: null,
        baseBranch: null,
        status: "created",
        parentSessionId: parentName,
        spawnSource: "agent",
        spawnDepth: 1,
        createdAt: now + i,
        updatedAt: now + i,
      });
    }

    const res = await SELF.fetch(`https://test.local/sessions/${parentName}/children`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${sandboxToken}`,
      },
      body: JSON.stringify({
        title: "One too many",
        prompt: "This should be rate-limited",
      }),
    });

    expect(res.status).toBe(429);
    const body = await res.json<{ error: string }>();
    expect(body.error).toContain("concurrent");
  });

  it("rejects when total children >= 15 (429)", async () => {
    const { parentName, sandboxToken, store, now } = await setupParent();

    // Seed 15 total children (mix of active and completed)
    for (let i = 0; i < 15; i++) {
      await store.create({
        id: `child-total-${i}-${Date.now()}`,
        title: `Child ${i}`,
        repoOwner: "acme",
        repoName: "web-app",
        model: "anthropic/claude-sonnet-4-6",
        reasoningEffort: null,
        baseBranch: null,
        status: i < 4 ? "created" : "completed", // 4 active, 11 completed = 15 total
        parentSessionId: parentName,
        spawnSource: "agent",
        spawnDepth: 1,
        createdAt: now + i,
        updatedAt: now + i,
      });
    }

    const res = await SELF.fetch(`https://test.local/sessions/${parentName}/children`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${sandboxToken}`,
      },
      body: JSON.stringify({
        title: "Too many total",
        prompt: "This should be rate-limited",
      }),
    });

    expect(res.status).toBe(429);
    const body = await res.json<{ error: string }>();
    expect(body.error).toContain("total");
  });

  it("rejects cross-repo spawn (403)", async () => {
    const { parentName, sandboxToken } = await setupParent();

    const res = await SELF.fetch(`https://test.local/sessions/${parentName}/children`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${sandboxToken}`,
      },
      body: JSON.stringify({
        title: "Cross-repo attempt",
        prompt: "This should fail",
        repoOwner: "evil-corp",
        repoName: "malicious-app",
      }),
    });

    expect(res.status).toBe(403);
    const body = await res.json<{ error: string }>();
    expect(body.error).toContain("same repository");
  });

  it("rejects without auth (401)", async () => {
    const res = await SELF.fetch(`https://test.local/sessions/any-session/children`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "No auth",
        prompt: "Should fail",
      }),
    });

    expect(res.status).toBe(401);
  });

  it("lists children via GET", async () => {
    const { parentName, sandboxToken, store, now } = await setupParent();

    // Seed some children in D1
    await store.create({
      id: "child-list-1",
      title: "Child A",
      repoOwner: "acme",
      repoName: "web-app",
      model: "anthropic/claude-sonnet-4-6",
      reasoningEffort: null,
      baseBranch: null,
      status: "created",
      parentSessionId: parentName,
      spawnSource: "agent",
      spawnDepth: 1,
      createdAt: now,
      updatedAt: now,
    });

    await store.create({
      id: "child-list-2",
      title: "Child B",
      repoOwner: "acme",
      repoName: "web-app",
      model: "anthropic/claude-sonnet-4-6",
      reasoningEffort: null,
      baseBranch: null,
      status: "completed",
      parentSessionId: parentName,
      spawnSource: "agent",
      spawnDepth: 1,
      createdAt: now + 1,
      updatedAt: now + 1,
    });

    const res = await SELF.fetch(`https://test.local/sessions/${parentName}/children`, {
      headers: {
        Authorization: `Bearer ${sandboxToken}`,
      },
    });

    expect(res.status).toBe(200);
    const body = await res.json<{ children: Array<{ id: string; title: string | null }> }>();
    expect(body.children).toHaveLength(2);
    // Newest first
    expect(body.children[0].id).toBe("child-list-2");
    expect(body.children[1].id).toBe("child-list-1");
  });
});
