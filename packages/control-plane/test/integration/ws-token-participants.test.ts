import { describe, it, expect } from "vitest";
import { initSession, queryDO } from "./helpers";

describe("POST /internal/ws-token", () => {
  it("generates WS token for existing owner", async () => {
    const { stub } = await initSession({ userId: "user-1", githubLogin: "testuser" });

    const res = await stub.fetch("http://internal/internal/ws-token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: "user-1" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json<{ token: string; participantId: string }>();
    expect(body.token).toEqual(expect.any(String));
    expect(body.token.length).toBeGreaterThan(0);
    expect(body.participantId).toEqual(expect.any(String));
  });

  it("creates new participant for unknown userId", async () => {
    const { stub } = await initSession({ userId: "user-1" });

    const res = await stub.fetch("http://internal/internal/ws-token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: "user-new", githubLogin: "newuser" }),
    });

    expect(res.status).toBe(200);

    const participants = await queryDO<{ user_id: string; role: string }>(
      stub,
      "SELECT user_id, role FROM participants ORDER BY joined_at"
    );
    expect(participants.length).toBeGreaterThanOrEqual(2);

    const newParticipant = participants.find((p) => p.user_id === "user-new");
    expect(newParticipant).toBeDefined();
    expect(newParticipant!.role).toBe("member");
  });

  it("stores token hash in participants table", async () => {
    const { stub } = await initSession({ userId: "user-1" });

    await stub.fetch("http://internal/internal/ws-token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: "user-1" }),
    });

    const participants = await queryDO<{
      ws_auth_token: string | null;
      ws_token_created_at: number | null;
    }>(
      stub,
      "SELECT ws_auth_token, ws_token_created_at FROM participants WHERE user_id = 'user-1'"
    );

    expect(participants[0].ws_auth_token).not.toBeNull();
    // SHA-256 hash is 64 hex characters
    expect(participants[0].ws_auth_token!.length).toBe(64);
    expect(participants[0].ws_token_created_at).toEqual(expect.any(Number));
  });

  it("rejects ws-token without userId", async () => {
    const { stub } = await initSession();

    const res = await stub.fetch("http://internal/internal/ws-token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);
    const body = await res.json<{ error: string }>();
    expect(body.error).toBe("userId is required");
  });

  it("ws-token updates GitHub info on existing participant", async () => {
    const { stub } = await initSession({ userId: "user-1" });

    await stub.fetch("http://internal/internal/ws-token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userId: "user-1",
        githubLogin: "updated-login",
        githubName: "Updated Name",
      }),
    });

    const participants = await queryDO<{
      github_login: string | null;
      github_name: string | null;
    }>(stub, "SELECT github_login, github_name FROM participants WHERE user_id = 'user-1'");

    expect(participants[0].github_login).toBe("updated-login");
    expect(participants[0].github_name).toBe("Updated Name");
  });
});

describe("GET /internal/participants", () => {
  it("lists participants", async () => {
    const { stub } = await initSession({ userId: "user-1", githubLogin: "testuser" });

    // Add a second participant
    await stub.fetch("http://internal/internal/participants", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: "user-2", githubLogin: "user2" }),
    });

    const res = await stub.fetch("http://internal/internal/participants");
    expect(res.status).toBe(200);

    const body = await res.json<{
      participants: Array<{
        id: string;
        userId: string;
        githubLogin: string | null;
        role: string;
      }>;
    }>();

    expect(body.participants.length).toBeGreaterThanOrEqual(2);
    const userIds = body.participants.map((p) => p.userId);
    expect(userIds).toContain("user-1");
    expect(userIds).toContain("user-2");
  });
});

describe("POST /internal/participants", () => {
  it("adds participant", async () => {
    const { stub } = await initSession({ userId: "user-1" });

    const res = await stub.fetch("http://internal/internal/participants", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: "user-added", githubLogin: "addeduser" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json<{ id: string; status: string }>();
    expect(body.id).toEqual(expect.any(String));
    expect(body.status).toBe("added");

    const participants = await queryDO<{ user_id: string; role: string }>(
      stub,
      "SELECT user_id, role FROM participants WHERE user_id = 'user-added'"
    );
    expect(participants).toHaveLength(1);
    expect(participants[0].role).toBe("member");
  });
});
