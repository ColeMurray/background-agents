import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { initSession, queryDO, seedEvents } from "./helpers";
import type { SpawnContext, ChildSessionDetail } from "@open-inspect/shared";

describe("DO internal sub-session routes", () => {
  describe("GET /internal/spawn-context", () => {
    it("returns SpawnContext with session and owner info", async () => {
      const { stub } = await initSession({
        repoOwner: "acme",
        repoName: "web-app",
        repoId: 12345,
        userId: "user-1",
        scmLogin: "acmedev",
        model: "anthropic/claude-sonnet-4-6",
      });

      const res = await stub.fetch("http://internal/internal/spawn-context");

      expect(res.status).toBe(200);
      const context = await res.json<SpawnContext>();

      expect(context.repoOwner).toBe("acme");
      expect(context.repoName).toBe("web-app");
      expect(context.repoId).toBe(12345);
      expect(context.model).toBe("anthropic/claude-sonnet-4-6");
      expect(context.reasoningEffort).toBeNull();

      // Owner fields
      expect(context.owner).toBeDefined();
      expect(context.owner.userId).toBe("user-1");
      expect(context.owner.scmLogin).toBe("acmedev");
      // Encrypted token fields may be null in tests (no SCM token provided at init)
      expect(context.owner).toHaveProperty("scmAccessTokenEncrypted");
      expect(context.owner).toHaveProperty("scmRefreshTokenEncrypted");
      expect(context.owner).toHaveProperty("scmTokenExpiresAt");
    });

    it("returns 404 when session is not initialized", async () => {
      // Create a bare DO without calling /internal/init
      const id = env.SESSION.newUniqueId();
      const stub = env.SESSION.get(id);

      const res = await stub.fetch("http://internal/internal/spawn-context");

      expect(res.status).toBe(404);
      const body = await res.json<{ error: string }>();
      expect(body.error).toBe("Session not found");
    });
  });

  describe("GET /internal/child-summary", () => {
    it("returns ChildSessionDetail shape with session, sandbox, artifacts, and events", async () => {
      const { stub } = await initSession({
        repoOwner: "acme",
        repoName: "web-app",
        title: "Child task",
        userId: "user-1",
      });

      // Seed some events (tool_call should appear, token/heartbeat should be filtered)
      await seedEvents(stub, [
        {
          id: "evt-tool-1",
          type: "tool_call",
          data: JSON.stringify({
            tool: "write_file",
            args: { path: "/src/fix.ts", content: "fixed" },
          }),
          createdAt: Date.now(),
        },
        {
          id: "evt-token-1",
          type: "token",
          data: JSON.stringify({ content: "some token" }),
          createdAt: Date.now() + 1,
        },
        {
          id: "evt-heartbeat-1",
          type: "heartbeat",
          data: JSON.stringify({ status: "running" }),
          createdAt: Date.now() + 2,
        },
      ]);

      // Seed an artifact
      await queryDO(
        stub,
        "INSERT INTO artifacts (id, type, url, metadata, created_at) VALUES (?, ?, ?, ?, ?)",
        "art-1",
        "branch",
        "https://github.com/acme/web-app/tree/fix-branch",
        JSON.stringify({ branchName: "fix-branch" }),
        Date.now()
      );

      const res = await stub.fetch("http://internal/internal/child-summary");

      expect(res.status).toBe(200);
      const detail = await res.json<ChildSessionDetail>();

      // Session info
      expect(detail.session).toBeDefined();
      expect(detail.session.repoOwner).toBe("acme");
      expect(detail.session.title).toBe("Child task");
      expect(detail.session.status).toBe("created");
      expect(detail.session.createdAt).toEqual(expect.any(Number));

      // Sandbox should exist (init creates it)
      expect(detail.sandbox).not.toBeNull();
      expect(detail.sandbox!.status).toEqual(expect.any(String));

      // Artifacts
      expect(detail.artifacts).toHaveLength(1);
      expect(detail.artifacts[0].type).toBe("branch");

      // Recent events should be filtered (no token or heartbeat)
      const eventTypes = detail.recentEvents.map((e) => e.type);
      expect(eventTypes).toContain("tool_call");
      expect(eventTypes).not.toContain("token");
      expect(eventTypes).not.toContain("heartbeat");
    });

    it("returns 404 when session is not initialized", async () => {
      const id = env.SESSION.newUniqueId();
      const stub = env.SESSION.get(id);

      const res = await stub.fetch("http://internal/internal/child-summary");

      expect(res.status).toBe(404);
    });
  });

  describe("POST /internal/cancel", () => {
    it("transitions session status to cancelled", async () => {
      const { stub } = await initSession({
        repoOwner: "acme",
        repoName: "web-app",
        userId: "user-1",
      });

      const res = await stub.fetch("http://internal/internal/cancel", { method: "POST" });

      expect(res.status).toBe(200);
      const body = await res.json<{ status: string }>();
      expect(body.status).toBe("cancelled");

      // Verify session status in DO SQLite
      const rows = await queryDO<{ status: string }>(stub, "SELECT status FROM session LIMIT 1");
      expect(rows[0].status).toBe("cancelled");
    });

    it.each(["completed", "cancelled", "archived"])(
      "returns 409 for session in terminal status (%s)",
      async (status) => {
        const { stub } = await initSession({
          repoOwner: "acme",
          repoName: "web-app",
          userId: "user-1",
        });

        await queryDO(stub, `UPDATE session SET status = '${status}'`);

        const res = await stub.fetch("http://internal/internal/cancel", { method: "POST" });

        expect(res.status).toBe(409);
        const body = await res.json<{ error: string }>();
        expect(body.error).toContain(status);
      }
    );

    it("returns 404 when no session exists (fresh DO without init)", async () => {
      const id = env.SESSION.newUniqueId();
      const stub = env.SESSION.get(id);

      const res = await stub.fetch("http://internal/internal/cancel", { method: "POST" });

      expect(res.status).toBe(404);
      const body = await res.json<{ error: string }>();
      expect(body.error).toBe("Session not found");
    });

    it("stops sandbox when cancelling an active session", async () => {
      const { stub } = await initSession({
        repoOwner: "acme",
        repoName: "web-app",
        userId: "user-1",
      });

      // Set session to active to simulate a running session
      await queryDO(stub, "UPDATE session SET status = 'active'");

      const res = await stub.fetch("http://internal/internal/cancel", { method: "POST" });
      expect(res.status).toBe(200);

      // Verify sandbox was stopped
      const sandbox = await queryDO<{ status: string }>(stub, "SELECT status FROM sandbox LIMIT 1");
      expect(sandbox[0].status).toBe("stopped");
    });
  });
});
