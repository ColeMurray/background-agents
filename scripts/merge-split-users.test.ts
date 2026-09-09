import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { WranglerD1Database, type WranglerRunner } from "./merge-split-users.ts";

function result(results: Record<string, unknown>[], changes = 0): string {
  return JSON.stringify([{ success: true, results, meta: { changes } }]);
}

describe("Wrangler user-merge database adapter", () => {
  for (const malformed of [
    null,
    {},
    [null],
    [{ success: "true", results: [] }],
    [{ success: true }],
    [{ success: true, results: {} }],
    [{ success: true, results: [{ count: 1 }, null] }],
    [{ success: true, results: [42] }],
    [{ success: true, results: [[]] }],
    [{ success: true, results: [], meta: null }],
    [{ success: true, results: [], meta: { changes: "1" } }],
    [{ success: true, results: [], meta: { changes: -1 } }],
    [{ success: true, results: [], meta: { changes: 1.5 } }],
  ]) {
    it(`rejects malformed query data: ${JSON.stringify(malformed)}`, async () => {
      const database = new WranglerD1Database("workspace", true, false, () => ({
        status: 0,
        stderr: "",
        stdout: JSON.stringify(malformed),
      }));
      await assert.rejects(
        database.prepare("SELECT count(*) AS count FROM users").first(),
        /malformed/
      );
    });
  }

  it("does not report an omitted verification result as an empty table", async () => {
    const database = new WranglerD1Database("workspace", true, false, () => ({
      status: 0,
      stderr: "",
      stdout: "[]",
    }));
    await assert.rejects(
      database.prepare("SELECT count(*) AS count FROM users").first(),
      /returned 0 results/
    );
  });

  it("preserves failure diagnostics even when an error has no rows", async () => {
    const database = new WranglerD1Database("workspace", true, false, () => ({
      status: 0,
      stderr: "",
      stdout: JSON.stringify([{ success: false, error: "query failed" }]),
    }));
    await assert.rejects(database.prepare("SELECT 1").first(), /Statement failed:.*query failed/);
  });

  it("preserves empty rows and optional metadata on successful queries", async () => {
    const database = new WranglerD1Database("workspace", true, false, () => ({
      status: 0,
      stderr: "",
      stdout: JSON.stringify([{ success: true, results: [] }]),
    }));
    assert.deepEqual(await database.prepare("SELECT 1 WHERE 0").all(), {
      results: [],
      meta: { changes: 0 },
    });
  });

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
