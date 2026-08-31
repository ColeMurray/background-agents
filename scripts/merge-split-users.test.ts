import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { WranglerD1Database, type WranglerRunner } from "./merge-split-users.ts";

function result(results: Record<string, unknown>[], changes = 0): string {
  return JSON.stringify([{ success: true, results, meta: { changes } }]);
}

describe("Wrangler user-merge database adapter", () => {
  it("uses the result-bearing command batch and preserves positional results", async () => {
    let invokedArgs: string[] = [];
    const runner: WranglerRunner = (args) => {
      invokedArgs = args;
      return {
        status: 0,
        stderr: "",
        stdout: JSON.stringify([
          { success: true, results: [{ role_id: "survivor-role" }], meta: { changes: 0 } },
          { success: true, results: [{ role_id: "loser-role" }], meta: { changes: 0 } },
        ]),
      };
    };
    const database = new WranglerD1Database("workspace", true, false, runner);

    const results = await database.batch([
      database.prepare("SELECT role_id FROM assignments WHERE user_id = ?").bind("survivor"),
      database.prepare("SELECT role_id FROM assignments WHERE user_id = ?").bind("loser"),
    ]);

    assert.deepEqual(
      results.map((entry) => entry.results[0]),
      [{ role_id: "survivor-role" }, { role_id: "loser-role" }]
    );
    assert.ok(invokedArgs.includes("--command"));
    assert.ok(!invokedArgs.includes("--file"));
  });

  it("fails loudly if Wrangler collapses a batch into one aggregate result", async () => {
    const runner: WranglerRunner = () => ({
      status: 0,
      stderr: "",
      stdout: result([{ "Total queries executed": 2 }]),
    });
    const database = new WranglerD1Database("workspace", true, false, runner);

    await assert.rejects(
      database.batch([database.prepare("SELECT 1"), database.prepare("SELECT 2")]),
      /returned 1 results for 2 batched statements/
    );
  });
});
