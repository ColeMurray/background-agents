import { describe, expect, it, vi } from "vitest";
import type { SqlDatabase, SqlStatement } from "./sql-database";
import { TeamChannelBindingConflictError, TeamChannelBindingStore } from "./team-channel-bindings";

const binding = {
  provider: "slack",
  externalId: "C123",
  teamId: "team_engineering",
  kind: "source",
} as const;
const actor = { requestId: "binding-request", actorUserId: "lead" };

function database(rows: unknown[] = []) {
  const prepare = vi.fn((_sql: string): SqlStatement => {
    const statement: SqlStatement = {
      bind: vi.fn(() => statement),
      first: async <T>() => (rows[0] as T | undefined) ?? null,
      all: async <T>() => ({ results: rows as T[], meta: { changes: 0 } }),
      run: vi.fn().mockRejectedValue(new Error("Mutation must use an atomic batch")),
    };
    return statement;
  });
  const batch = vi.fn(async (statements: SqlStatement[]) =>
    statements.map(() => ({ results: [], meta: { changes: 1 } }))
  );
  const db: SqlDatabase = { prepare, batch };
  return { db, prepare, batch };
}

describe("TeamChannelBindingStore", () => {
  it("keys lookup by provider and external ID and validates stored rows", async () => {
    const { db, prepare } = database([binding]);
    expect(await new TeamChannelBindingStore(db).get("slack", "C123")).toEqual(binding);
    expect(prepare.mock.results[0]!.value.bind).toHaveBeenCalledWith("slack", "C123");
    expect(await new TeamChannelBindingStore(database().db).get("linear", "C123")).toBeNull();
    await expect(
      new TeamChannelBindingStore(database([{ ...binding, kind: "unknown" }]).db).get(
        "slack",
        "C123"
      )
    ).rejects.toThrow();
  });

  it("validates lists and scopes reads to the requested team ID", async () => {
    const { db, prepare } = database([{ ...binding, created_at: 1 }]);
    await expect(new TeamChannelBindingStore(db).listByTeam(binding.teamId)).rejects.toThrow();
    expect(prepare.mock.results[0]!.value.bind).toHaveBeenCalledWith(binding.teamId);
    expect(
      await new TeamChannelBindingStore(database([binding]).db).listByTeam(binding.teamId)
    ).toEqual([binding]);
  });

  it("batches predicate-gated audit and mutation SQL without engine-specific functions", async () => {
    const { db, prepare, batch } = database();
    expect(await new TeamChannelBindingStore(db).put(binding, actor)).toEqual(binding);
    expect(batch).toHaveBeenCalledOnce();
    const sql = prepare.mock.calls.map(([query]) => query).join("\n");
    expect(sql).toContain("NOT EXISTS");
    expect(sql).toContain("ON CONFLICT (provider, external_id)");
    expect(sql).not.toMatch(/changes\(|json_|INSERT OR IGNORE/i);
    expect(batch.mock.calls[0]![0]).toEqual(prepare.mock.results.map(({ value }) => value));
  });

  it("maps uniqueness failures to conflicts but preserves storage failures", async () => {
    const { db, batch } = database();
    batch.mockRejectedValueOnce(
      new Error("UNIQUE constraint failed: team_channel_bindings.team_id")
    );
    const store = new TeamChannelBindingStore(db);
    await expect(store.put(binding, actor)).rejects.toBeInstanceOf(TeamChannelBindingConflictError);
    const failure = new Error("storage unavailable");
    batch.mockRejectedValueOnce(failure);
    await expect(store.put(binding, actor)).rejects.toBe(failure);
  });
});
