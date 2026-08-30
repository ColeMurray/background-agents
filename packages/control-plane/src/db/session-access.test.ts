import { describe, expect, it, vi } from "vitest";
import { requireSessionAccess, sessionAccessPredicate } from "./session-access";

describe("session access", () => {
  it("builds one scoped access predicate", () => {
    expect(sessionAccessPredicate("sessions", "user-1", "any")).toEqual({
      sql: "1 = 1",
      params: [],
    });
    expect(sessionAccessPredicate("candidate", "user-1", "own")).toEqual({
      sql: expect.stringContaining("access.session_id = candidate.id"),
      params: ["user-1"],
    });
  });

  it("accepts participants for general access", async () => {
    const first = vi.fn(async () => ({ relation: "participant" as const }));
    const bind = vi.fn(() => ({ first }));
    const prepare = vi.fn(() => ({ bind }));

    await expect(
      requireSessionAccess({ prepare } as never, "session-1", "user-1", "access")
    ).resolves.toBeUndefined();
    expect(bind).toHaveBeenCalledWith("session-1", "user-1");
  });

  it("distinguishes missing access from a creator-only denial", async () => {
    const participantDb = {
      prepare: () => ({
        bind: () => ({ first: async () => ({ relation: "participant" as const }) }),
      }),
    };
    const missingDb = {
      prepare: () => ({ bind: () => ({ first: async () => null }) }),
    };

    await expect(
      requireSessionAccess(participantDb as never, "session-1", "user-1", "creator")
    ).rejects.toMatchObject({ code: "creator_required" });
    await expect(
      requireSessionAccess(missingDb as never, "session-1", "user-1", "access")
    ).rejects.toMatchObject({ code: "session_access_required" });
    await expect(
      requireSessionAccess(missingDb as never, "session-1", "user-1", "creator")
    ).rejects.toMatchObject({ code: "creator_required" });
  });
});
