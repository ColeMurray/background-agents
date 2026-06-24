import { describe, expect, it } from "vitest";
import type { SlackEnvelope, SlackUser } from "./client";
import { resolveUserNames } from "./resolve-users";

type GetUserInfo = (token: string, userId: string) => Promise<SlackEnvelope<{ user: SlackUser }>>;

describe("resolveUserNames", () => {
  it("resolves display_name when available", async () => {
    const fakeGetUserInfo: GetUserInfo = async (_token, _userId) => ({
      ok: true,
      user: { id: "U1", name: "alice", profile: { display_name: "Alice S" } },
    });

    const result = await resolveUserNames("token", ["U1"], { getUserInfo: fakeGetUserInfo });
    expect(result.get("U1")).toBe("Alice S");
  });

  it("falls back to name when display_name is empty", async () => {
    const fakeGetUserInfo: GetUserInfo = async (_token, _userId) => ({
      ok: true,
      user: { id: "U2", name: "bob.jones", profile: { display_name: "" } },
    });

    const result = await resolveUserNames("token", ["U2"], { getUserInfo: fakeGetUserInfo });
    expect(result.get("U2")).toBe("bob.jones");
  });

  it("falls back to user ID when API fails", async () => {
    const fakeGetUserInfo: GetUserInfo = async (_token, _userId) => {
      throw new Error("network error");
    };

    const result = await resolveUserNames("token", ["U3"], { getUserInfo: fakeGetUserInfo });
    // Promise.allSettled catches the rejection — ID is not in the map
    expect(result.has("U3")).toBe(false);
  });

  it("falls back to user ID when user info is missing", async () => {
    const fakeGetUserInfo: GetUserInfo = async (_token, _userId) => ({
      ok: false,
      error: "user_not_found",
    });

    const result = await resolveUserNames("token", ["U4"], { getUserInfo: fakeGetUserInfo });
    expect(result.get("U4")).toBe("U4");
  });

  it("resolves multiple users in parallel", async () => {
    const responses: Record<string, SlackEnvelope<{ user: SlackUser }>> = {
      U1: { ok: true, user: { id: "U1", name: "alice", profile: { display_name: "Alice" } } },
      U2: { ok: true, user: { id: "U2", name: "bob", profile: { display_name: "Bob" } } },
    };
    const fakeGetUserInfo: GetUserInfo = async (_token, userId) => responses[userId]!;

    const result = await resolveUserNames("token", ["U1", "U2"], { getUserInfo: fakeGetUserInfo });
    expect(result.get("U1")).toBe("Alice");
    expect(result.get("U2")).toBe("Bob");
    expect(result.size).toBe(2);
  });

  it("does not include real_name in fallback chain", async () => {
    const fakeGetUserInfo: GetUserInfo = async (_token, _userId) => ({
      ok: true,
      user: {
        id: "U5",
        name: "jdoe",
        real_name: "John Doe",
        profile: { display_name: "", real_name: "John Doe" },
      },
    });

    const result = await resolveUserNames("token", ["U5"], { getUserInfo: fakeGetUserInfo });
    // Should use name (jdoe), not real_name (John Doe)
    expect(result.get("U5")).toBe("jdoe");
  });

  it("returns empty map for empty input", async () => {
    let callCount = 0;
    const fakeGetUserInfo: GetUserInfo = async (_token, _userId) => {
      callCount++;
      return { ok: true, user: { id: "X", name: "x" } };
    };

    const result = await resolveUserNames("token", [], { getUserInfo: fakeGetUserInfo });
    expect(result.size).toBe(0);
    expect(callCount).toBe(0);
  });
});
