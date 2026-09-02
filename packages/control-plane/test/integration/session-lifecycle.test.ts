import { runInSessionDO } from "./session-do-access";
import { describe, it, expect } from "vitest";
import type { SessionDO } from "../../src/session/durable-object";
import {
  initSession,
  queryDO,
  seedMessage,
  seedSandboxAuthHash,
  waitForSandboxStatus,
} from "./helpers";

describe("GET /internal/state", () => {
  it("state includes sandbox after init", async () => {
    const { stub } = await initSession();

    const res = await stub.fetch("http://internal/internal/state");
    expect(res.status).toBe(200);

    const state = await res.json<{
      id: string;
      status: string;
      sandbox: { id: string; status: string } | null;
    }>();

    expect(state.sandbox).not.toBeNull();
    expect(state.sandbox!.id).toEqual(expect.any(String));
    // Status depends on how far the background warmSandbox() waitUntil has run.
    // In CI the provider call can fail before this state read completes.
    expect(["pending", "spawning", "failed"]).toContain(state.sandbox!.status);
  });

  it("state reflects custom model", async () => {
    const { stub } = await initSession({ model: "anthropic/claude-sonnet-4-5" });

    const res = await stub.fetch("http://internal/internal/state");
    const state = await res.json<{ model: string }>();

    expect(state.model).toBe("anthropic/claude-sonnet-4-5");
  });
});

describe("POST /internal/archive", () => {
  it("archive sets status to archived", async () => {
    const { stub } = await initSession({ userId: "user-1" });

    const res = await stub.fetch("http://internal/internal/archive", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: "user-1" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json<{ status: string }>();
    expect(body.status).toBe("archived");

    // Verify via state endpoint
    const stateRes = await stub.fetch("http://internal/internal/state");
    const state = await stateRes.json<{ status: string }>();
    expect(state.status).toBe("archived");
  });

  it("archive does not use participant identity for authorization", async () => {
    const { stub } = await initSession({ userId: "user-1" });

    const res = await stub.fetch("http://internal/internal/archive", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: "stranger" }),
    });

    expect(res.status).toBe(200);
  });
});

describe("POST /internal/unarchive", () => {
  // Unarchive restores; it does not start work. Asserting "active" was the
  // defect: nothing settles an idle `active` session, because every settle path
  // runs off execution events, so a restored session with no queued work stayed
  // in the in-progress group until someone prompted it again.
  it("unarchive restores an empty session to created, not active", async () => {
    const { stub } = await initSession({ userId: "user-1" });

    // First archive
    await stub.fetch("http://internal/internal/archive", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: "user-1" }),
    });

    // Then unarchive
    const res = await stub.fetch("http://internal/internal/unarchive", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: "user-1" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json<{ status: string }>();
    expect(body.status).toBe("created");

    // Verify via state endpoint
    const stateRes = await stub.fetch("http://internal/internal/state");
    const state = await stateRes.json<{ status: string }>();
    expect(state.status).toBe("created");
  });

  it("unarchive restores a session with finished work to completed", async () => {
    const { stub } = await initSession({ userId: "user-1" });
    const [participant] = await queryDO<{ id: string }>(
      stub,
      "SELECT id FROM participants LIMIT 1"
    );
    await seedMessage(stub, {
      id: "msg-1",
      authorId: participant.id,
      content: "do the thing",
      source: "web",
      status: "completed",
      createdAt: 1000,
    });

    await stub.fetch("http://internal/internal/archive", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: "user-1" }),
    });

    const res = await stub.fetch("http://internal/internal/unarchive", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: "user-1" }),
    });

    expect(res.status).toBe(200);
    expect(await res.json<{ status: string }>()).toEqual({ status: "completed" });

    const stateRes = await stub.fetch("http://internal/internal/state");
    expect((await stateRes.json<{ status: string }>()).status).toBe("completed");
  });

  // The handler unit test mocks the settle service, so these are what actually
  // pin each message state to the status it produces.
  // Only terminal message states appear here: a session with a pending or
  // processing message cannot be archived at all (the archive handler 409s), so
  // an archived session always has zero queued work.
  it.each([["failed", "failed"]] as const)(
    "unarchive settles a %s message to %s",
    async (messageStatus, expected) => {
      const { stub } = await initSession({ userId: "user-1" });
      const [participant] = await queryDO<{ id: string }>(
        stub,
        "SELECT id FROM participants LIMIT 1"
      );
      await seedMessage(stub, {
        id: "msg-1",
        authorId: participant.id,
        content: "do the thing",
        source: "web",
        status: messageStatus,
        createdAt: 1000,
      });

      await stub.fetch("http://internal/internal/archive", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: "user-1" }),
      });
      const res = await stub.fetch("http://internal/internal/unarchive", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: "user-1" }),
      });

      expect(res.status).toBe(200);
      expect(await res.json<{ status: string }>()).toEqual({ status: expected });
    }
  );
});

describe("POST /internal/prompt", () => {
  it.each(["completed", "failed"])("reopens %s session back to active", async (status) => {
    const { stub } = await initSession({ userId: "user-1" });

    await runInSessionDO(stub, (instance: SessionDO, state) => {
      state.storage.sql.exec("UPDATE session SET status = ?", status);
    });

    const promptRes = await stub.fetch("http://internal/internal/prompt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: "Re-open session",
        authorId: "user-1",
        source: "web",
      }),
    });
    expect(promptRes.status).toBe(200);

    const stateRes = await stub.fetch("http://internal/internal/state");
    const state = await stateRes.json<{ status: string }>();
    expect(state.status).toBe("active");
  });

  it.each(["archived", "cancelled"])("rejects prompts for a %s session", async (status) => {
    const { stub } = await initSession({ userId: "user-1" });

    await runInSessionDO(stub, (instance: SessionDO, state) => {
      state.storage.sql.exec("UPDATE session SET status = ?", status);
    });

    const promptRes = await stub.fetch("http://internal/internal/prompt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: "Re-open session",
        authorId: "user-1",
        source: "web",
      }),
    });
    expect(promptRes.status).toBe(409);

    const stateRes = await stub.fetch("http://internal/internal/state");
    const state = await stateRes.json<{ status: string }>();
    expect(state.status).toBe(status);
  });
});

describe("POST /internal/update-title", () => {
  it("updates the session title", async () => {
    const { stub } = await initSession({ userId: "user-1" });

    const res = await stub.fetch("http://internal/internal/update-title", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: "user-1", title: "new title" }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { title: string };
    expect(body.title).toBe("new title");

    const stateRes = await stub.fetch("http://internal/internal/state");
    const state = (await stateRes.json()) as { title: string };
    expect(state.title).toBe("new title");
  });

  it("rejects empty title", async () => {
    const { stub } = await initSession({ userId: "user-1" });
    const res = await stub.fetch("http://internal/internal/update-title", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: "user-1", title: "" }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects title over 200 characters", async () => {
    const { stub } = await initSession({ userId: "user-1" });
    const res = await stub.fetch("http://internal/internal/update-title", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: "user-1", title: "a".repeat(201) }),
    });
    expect(res.status).toBe(400);
  });
});

describe("POST /internal/verify-sandbox-token", () => {
  it("validates token using hashed sandbox auth token", async () => {
    const { stub } = await initSession();

    const authToken = "test-sandbox-auth-token-hashed";
    await seedSandboxAuthHash(stub, { authToken, sandboxId: "sb-hashed-token" });

    const validRes = await stub.fetch("http://internal/internal/verify-sandbox-token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: authToken }),
    });
    expect(validRes.status).toBe(200);
    const validBody = await validRes.json<{ valid: boolean }>();
    expect(validBody.valid).toBe(true);

    const invalidRes = await stub.fetch("http://internal/internal/verify-sandbox-token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "wrong-token" }),
    });
    expect(invalidRes.status).toBe(401);
    const invalidBody = await invalidRes.json<{ valid: boolean; error: string }>();
    expect(invalidBody.valid).toBe(false);
  });

  it("validates correct token and rejects wrong token", async () => {
    const { stub } = await initSession();
    await waitForSandboxStatus(stub, "failed");

    // Seed auth_token on a live sandbox directly
    const authToken = "test-sandbox-auth-token-12345";
    await runInSessionDO(stub, (instance: SessionDO, state) => {
      state.storage.sql.exec(
        "UPDATE sandbox SET auth_token = ?, auth_token_hash = NULL, status = 'ready' WHERE id = (SELECT id FROM sandbox LIMIT 1)",
        authToken
      );
    });

    // Correct token
    const validRes = await stub.fetch("http://internal/internal/verify-sandbox-token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: authToken }),
    });
    expect(validRes.status).toBe(200);
    const validBody = await validRes.json<{ valid: boolean }>();
    expect(validBody.valid).toBe(true);

    // Wrong token
    const invalidRes = await stub.fetch("http://internal/internal/verify-sandbox-token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "wrong-token" }),
    });
    expect(invalidRes.status).toBe(401);
    const invalidBody = await invalidRes.json<{ valid: boolean; error: string }>();
    expect(invalidBody.valid).toBe(false);
  });
});
