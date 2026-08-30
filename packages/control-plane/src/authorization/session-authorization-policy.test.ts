import { describe, expect, it } from "vitest";
import { sessionPermission, verifySessionAuthorization } from "./session-authorization-policy";

describe("session authorization policy", () => {
  it("maps each operation to one workspace permission", () => {
    expect(sessionPermission("read")).toBe("sessions.read");
    expect(sessionPermission("collaborate")).toBe("sessions.collaborate");
    expect(sessionPermission("lifecycle")).toBe("sessions.lifecycle");
    expect(sessionPermission("sandbox_access")).toBe("sessions.sandbox_access");
    expect(sessionPermission("delete")).toBe("sessions.delete");
  });

  it("verifies workspace permission without querying a session relationship", async () => {
    const database = (roleKey: "member" | "viewer", suspendedAt: number | null = null) => ({
      prepare: (query: string) => {
        if (!query.includes("FROM users u")) throw new Error(`Unexpected query: ${query}`);
        return {
          bind: () => ({
            first: async () => ({
              user_id: "user-1",
              suspended_at: suspendedAt,
              role_id: `role_builtin_${roleKey}`,
              role_key: roleKey,
              role_name: roleKey === "member" ? "Member" : "Viewer",
            }),
          }),
        };
      },
    });

    await expect(
      verifySessionAuthorization(database("member") as never, "user-1", "collaborate")
    ).resolves.toBe("valid");
    await expect(
      verifySessionAuthorization(database("viewer") as never, "user-1", "collaborate")
    ).resolves.toBe("rejected");
    await expect(
      verifySessionAuthorization(database("member", 1) as never, "user-1", "collaborate")
    ).resolves.toBe("rejected");
  });
});
