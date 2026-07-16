import { describe, it, expect } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";
import type { SessionDO } from "../../src/session/durable-object";
import { MIGRATIONS } from "../../src/session/schema";

describe("SessionDO Durable Object", () => {
  it("returns 404 for uninitialized session state", async () => {
    const id = env.SESSION.newUniqueId();
    const stub = env.SESSION.get(id);

    const response = await stub.fetch("http://internal/internal/state");
    expect(response.status).toBe(404);
  });

  it("initializes a session and returns state", async () => {
    const id = env.SESSION.newUniqueId();
    const stub = env.SESSION.get(id);

    const initResponse = await stub.fetch("http://internal/internal/init", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionName: "test-session-init",
        repoOwner: "acme",
        repoName: "web-app",
        repoId: 12345,
        title: "Integration test session",
        model: "anthropic/claude-haiku-4-5",
        userId: "user-1",
        scmLogin: "testuser",
      }),
    });
    expect(initResponse.status).toBe(200);

    const stateResponse = await stub.fetch("http://internal/internal/state");
    expect(stateResponse.status).toBe(200);

    const state = await stateResponse.json<{
      id: string;
      title: string;
      repoOwner: string;
      repoName: string;
      status: string;
      model: string;
    }>();
    expect(state.id).toBe("test-session-init");
    expect(state.title).toBe("Integration test session");
    expect(state.repoOwner).toBe("acme");
    expect(state.repoName).toBe("web-app");
    expect(state.status).toBe("created");
    expect(state.model).toBe("anthropic/claude-haiku-4-5");
  });

  it("has SQLite tables accessible via runInDurableObject", async () => {
    const id = env.SESSION.newUniqueId();
    const stub = env.SESSION.get(id);

    // Initialize first so schema is created
    await stub.fetch("http://internal/internal/init", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionName: "test-session-sqlite",
        repoOwner: "acme",
        repoName: "api",
        userId: "user-2",
      }),
    });

    await runInDurableObject(stub, (instance: SessionDO) => {
      const tables = instance.ctx.storage.sql
        .exec("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .toArray();

      const tableNames = tables.map((row: Record<string, unknown>) => row.name);
      expect(tableNames).toContain("session");
      expect(tableNames).toContain("participants");
      expect(tableNames).toContain("messages");
      expect(tableNames).toContain("events");
      expect(tableNames).toContain("artifacts");
      expect(tableNames).toContain("sandbox");
      expect(tableNames).toContain("ws_client_mapping");
      expect(tableNames).toContain("_schema_migrations");
    });
  });

  it("records all migration IDs in _schema_migrations", async () => {
    const id = env.SESSION.newUniqueId();
    const stub = env.SESSION.get(id);

    await stub.fetch("http://internal/internal/init", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionName: "test-session-migrations",
        repoOwner: "acme",
        repoName: "api",
        userId: "user-3",
      }),
    });

    await runInDurableObject(stub, (instance: SessionDO) => {
      const rows = instance.ctx.storage.sql
        .exec("SELECT id FROM _schema_migrations ORDER BY id")
        .toArray() as Array<{ id: number }>;

      const ids = rows.map((r) => r.id);
      expect(ids).toEqual(MIGRATIONS.map((migration) => migration.id));
    });
  });
});
