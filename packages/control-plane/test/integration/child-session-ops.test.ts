import { describe, it, expect, beforeEach } from "vitest";
import { SELF, env } from "cloudflare:test";
import { SessionIndexStore } from "../../src/db/session-index";
import { cleanD1Tables } from "./cleanup";
import { initNamedSession, seedSandboxAuth, queryDO, seedEvents } from "./helpers";

describe("Child session operations (list, get, cancel)", () => {
  beforeEach(cleanD1Tables);

  const parentName = () => `parent-ops-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

  /**
   * Helper to set up a parent+child pair.
   * Creates both DOs (via initNamedSession) and D1 rows.
   */
  async function setupParentAndChild(opts?: { childStatus?: string }) {
    const pName = parentName();
    const childName = `child-ops-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

    // Create parent DO
    const { stub: parentStub } = await initNamedSession(pName, {
      repoOwner: "acme",
      repoName: "web-app",
      userId: "user-1",
      scmLogin: "acmedev",
    });

    // Seed sandbox auth on parent so sandbox Bearer token works
    const sandboxToken = `sb-tok-ops-${Date.now()}`;
    await seedSandboxAuth(parentStub, { authToken: sandboxToken, sandboxId: "sb-ops-1" });

    // Create child DO
    const { stub: childStub } = await initNamedSession(childName, {
      repoOwner: "acme",
      repoName: "web-app",
      userId: "user-1",
      scmLogin: "acmedev",
    });

    // Seed D1 rows for both parent and child
    const store = new SessionIndexStore(env.DB);
    const now = Date.now();

    await store.create({
      id: pName,
      title: "Parent Session",
      repoOwner: "acme",
      repoName: "web-app",
      model: "anthropic/claude-sonnet-4-6",
      reasoningEffort: null,
      baseBranch: null,
      status: "active",
      spawnDepth: 0,
      createdAt: now,
      updatedAt: now,
    });

    await store.create({
      id: childName,
      title: "Child Session",
      repoOwner: "acme",
      repoName: "web-app",
      model: "anthropic/claude-sonnet-4-6",
      reasoningEffort: null,
      baseBranch: null,
      status: opts?.childStatus ?? "created",
      parentSessionId: pName,
      spawnSource: "agent",
      spawnDepth: 1,
      createdAt: now + 1,
      updatedAt: now + 1,
    });

    return { pName, childName, parentStub, childStub, sandboxToken, store };
  }

  describe("GET /sessions/:parentId/children", () => {
    it("returns children from D1", async () => {
      const { pName, childName, sandboxToken } = await setupParentAndChild();

      const res = await SELF.fetch(`https://test.local/sessions/${pName}/children`, {
        headers: { Authorization: `Bearer ${sandboxToken}` },
      });

      expect(res.status).toBe(200);
      const body = await res.json<{
        children: Array<{ id: string; parentSessionId: string | null }>;
      }>();
      expect(body.children.length).toBeGreaterThanOrEqual(1);
      const child = body.children.find((c) => c.id === childName);
      expect(child).toBeDefined();
      expect(child!.parentSessionId).toBe(pName);
    });
  });

  describe("GET /sessions/:parentId/children/:childId", () => {
    it("returns child summary data", async () => {
      const { pName, childName, childStub, sandboxToken } = await setupParentAndChild();

      // Seed some events on the child DO for the summary
      await seedEvents(childStub, [
        {
          id: "evt-1",
          type: "tool_call",
          data: JSON.stringify({ tool: "read_file", args: { path: "/src/index.ts" } }),
          createdAt: Date.now(),
        },
      ]);

      const res = await SELF.fetch(`https://test.local/sessions/${pName}/children/${childName}`, {
        headers: { Authorization: `Bearer ${sandboxToken}` },
      });

      expect(res.status).toBe(200);
      const body = await res.json<{
        session: { id: string; title: string; status: string; repoOwner: string };
        sandbox: { status: string } | null;
        artifacts: unknown[];
        recentEvents: Array<{ type: string }>;
      }>();

      expect(body.session).toBeDefined();
      expect(body.session.repoOwner).toBe("acme");
      expect(body.sandbox).not.toBeNull();
      expect(body.artifacts).toEqual(expect.any(Array));
      expect(body.recentEvents).toEqual(expect.any(Array));
      // The tool_call event should appear in recentEvents
      const toolCall = body.recentEvents.find((e) => e.type === "tool_call");
      expect(toolCall).toBeDefined();
    });

    it("returns 404 for wrong parent", async () => {
      const { childName } = await setupParentAndChild();

      // Create a different "parent" session with sandbox auth
      const fakeName = `fake-parent-${Date.now()}`;
      const { stub: fakeStub } = await initNamedSession(fakeName, {
        repoOwner: "acme",
        repoName: "web-app",
      });
      const fakeToken = `sb-tok-fake-${Date.now()}`;
      await seedSandboxAuth(fakeStub, { authToken: fakeToken, sandboxId: "sb-fake-1" });

      // Seed D1 row for the fake parent
      const store = new SessionIndexStore(env.DB);
      const now = Date.now();
      await store.create({
        id: fakeName,
        title: "Fake Parent",
        repoOwner: "acme",
        repoName: "web-app",
        model: "anthropic/claude-sonnet-4-6",
        reasoningEffort: null,
        baseBranch: null,
        status: "active",
        spawnDepth: 0,
        createdAt: now,
        updatedAt: now,
      });

      // Try to get the child through the wrong parent
      const res = await SELF.fetch(
        `https://test.local/sessions/${fakeName}/children/${childName}`,
        { headers: { Authorization: `Bearer ${fakeToken}` } }
      );

      expect(res.status).toBe(404);
    });
  });

  describe("POST /sessions/:parentId/children/:childId/cancel", () => {
    it("cancels a running child session", async () => {
      const { pName, childName, sandboxToken, store } = await setupParentAndChild({
        childStatus: "active",
      });

      const res = await SELF.fetch(
        `https://test.local/sessions/${pName}/children/${childName}/cancel`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${sandboxToken}` },
        }
      );

      expect(res.status).toBe(200);
      const body = await res.json<{ status: string }>();
      expect(body.status).toBe("cancelled");

      // Verify D1 status was updated
      const child = await store.get(childName);
      expect(child).not.toBeNull();
      expect(child!.status).toBe("cancelled");

      // Verify the child DO's session status is also cancelled
      const childDoId = env.SESSION.idFromName(childName);
      const childStub = env.SESSION.get(childDoId);
      const rows = await queryDO<{ status: string }>(
        childStub,
        "SELECT status FROM session LIMIT 1"
      );
      expect(rows[0].status).toBe("cancelled");
    });

    it("returns 409 for completed session", async () => {
      const { pName, childName, sandboxToken } = await setupParentAndChild({
        childStatus: "completed",
      });

      // Also update the child DO's session status to "completed" so the DO returns 409
      const childDoId = env.SESSION.idFromName(childName);
      const childStub = env.SESSION.get(childDoId);
      await queryDO(childStub, "UPDATE session SET status = 'completed'");

      const res = await SELF.fetch(
        `https://test.local/sessions/${pName}/children/${childName}/cancel`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${sandboxToken}` },
        }
      );

      expect(res.status).toBe(409);
      const body = await res.json<{ error: string }>();
      expect(body.error).toContain("completed");
    });

    it("returns 404 for wrong parent", async () => {
      const { childName } = await setupParentAndChild();

      // Create a different parent with sandbox auth
      const fakeName = `fake-cancel-${Date.now()}`;
      const { stub: fakeStub } = await initNamedSession(fakeName, {
        repoOwner: "acme",
        repoName: "web-app",
      });
      const fakeToken = `sb-tok-fake-cancel-${Date.now()}`;
      await seedSandboxAuth(fakeStub, { authToken: fakeToken, sandboxId: "sb-fake-cancel" });

      const store = new SessionIndexStore(env.DB);
      const now = Date.now();
      await store.create({
        id: fakeName,
        title: "Fake Parent",
        repoOwner: "acme",
        repoName: "web-app",
        model: "anthropic/claude-sonnet-4-6",
        reasoningEffort: null,
        baseBranch: null,
        status: "active",
        spawnDepth: 0,
        createdAt: now,
        updatedAt: now,
      });

      const res = await SELF.fetch(
        `https://test.local/sessions/${fakeName}/children/${childName}/cancel`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${fakeToken}` },
        }
      );

      expect(res.status).toBe(404);
    });
  });
});
