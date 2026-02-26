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
});
