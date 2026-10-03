import { describe, expect, it, vi } from "vitest";
import type { SessionAccessRow } from "@open-inspect/shared";
import type { SqlDatabase } from "../db/sql-database";
import { auditSocketShadowDenied } from "./session-socket-audit";

describe("auditSocketShadowDenied", () => {
  it("uses a stable primary key for the connection/session/reason and the existing SQL envelope", async () => {
    const statement = {
      bind: vi.fn(),
      run: vi.fn().mockResolvedValue({ results: [], meta: { changes: 1 } }),
    };
    statement.bind.mockReturnValue(statement);
    const prepare = vi.fn(() => statement);
    const db = { prepare } as unknown as SqlDatabase;
    const row: SessionAccessRow = {
      id: "session",
      ownerUserId: "owner",
      ownerTeamId: "team",
      visibility: "team",
      collaboratorIds: [],
    };

    await auditSocketShadowDenied(db, "canonical-user", row, "not_member", "ws-1");
    await auditSocketShadowDenied(db, "canonical-user", row, "not_member", "ws-1");
    await auditSocketShadowDenied(db, "canonical-user", row, "private", "ws-1");
    await auditSocketShadowDenied(
      db,
      "canonical-user",
      { ...row, id: "other-session" },
      "not_member",
      "ws-1"
    );
    await auditSocketShadowDenied(db, "canonical-user", row, "not_member", "ws-2");

    const ids = statement.bind.mock.calls.map((args) => args[0]);
    expect(ids[0]).toBe(ids[1]);
    expect(new Set(ids)).toHaveProperty("size", 4);
    expect(prepare).toHaveBeenCalledWith(expect.stringContaining("ON CONFLICT (id) DO NOTHING"));
    expect(statement.bind.mock.calls[0]).toEqual([
      expect.stringMatching(/^ws-shadow-/),
      expect.any(Number),
      "ws-1",
      "canonical-user",
      "session",
      "team",
      "shadow_denied:not_member",
      JSON.stringify({ before: {}, requested: {}, after: {}, channel: "ws" }),
    ]);
  });
});
