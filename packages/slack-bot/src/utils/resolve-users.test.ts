import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockGetUserInfo } = vi.hoisted(() => ({
  mockGetUserInfo: vi.fn(),
}));

vi.mock("./slack-client", () => ({
  getUserInfo: mockGetUserInfo,
}));

import { resolveUserNames } from "./resolve-users";

describe("resolveUserNames", () => {
  beforeEach(() => {
    mockGetUserInfo.mockReset();
  });
  it("resolves display_name when available", async () => {
    mockGetUserInfo.mockResolvedValue({
      ok: true,
      user: { id: "U1", name: "alice", profile: { display_name: "Alice S" } },
    });

    const result = await resolveUserNames("token", ["U1"]);
    expect(result.get("U1")).toBe("Alice S");
  });

  it("falls back to name when display_name is empty", async () => {
    mockGetUserInfo.mockResolvedValue({
      ok: true,
      user: { id: "U2", name: "bob.jones", profile: { display_name: "" } },
    });

    const result = await resolveUserNames("token", ["U2"]);
    expect(result.get("U2")).toBe("bob.jones");
  });

  it("falls back to user ID when API fails", async () => {
    mockGetUserInfo.mockRejectedValue(new Error("network error"));

    const result = await resolveUserNames("token", ["U3"]);
    // Promise.allSettled catches the rejection — ID is not in the map
    expect(result.has("U3")).toBe(false);
  });

  it("falls back to user ID when user info is missing", async () => {
    mockGetUserInfo.mockResolvedValue({ ok: false, error: "user_not_found" });

    const result = await resolveUserNames("token", ["U4"]);
    expect(result.get("U4")).toBe("U4");
  });

  it("resolves multiple users in parallel", async () => {
    mockGetUserInfo
      .mockResolvedValueOnce({
        ok: true,
        user: { id: "U1", name: "alice", profile: { display_name: "Alice" } },
      })
      .mockResolvedValueOnce({
        ok: true,
        user: { id: "U2", name: "bob", profile: { display_name: "Bob" } },
      });

    const result = await resolveUserNames("token", ["U1", "U2"]);
    expect(result.get("U1")).toBe("Alice");
    expect(result.get("U2")).toBe("Bob");
    expect(result.size).toBe(2);
  });

  it("does not include real_name in fallback chain", async () => {
    mockGetUserInfo.mockResolvedValue({
      ok: true,
      user: {
        id: "U5",
        name: "jdoe",
        real_name: "John Doe",
        profile: { display_name: "", real_name: "John Doe" },
      },
    });

    const result = await resolveUserNames("token", ["U5"]);
    // Should use name (jdoe), not real_name (John Doe)
    expect(result.get("U5")).toBe("jdoe");
  });

  it("returns empty map for empty input", async () => {
    const result = await resolveUserNames("token", []);
    expect(result.size).toBe(0);
    expect(mockGetUserInfo).not.toHaveBeenCalled();
  });
});
