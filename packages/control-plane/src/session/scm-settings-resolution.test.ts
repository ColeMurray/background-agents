import { describe, expect, it } from "vitest";
import { resolveScmSettings } from "./scm-settings-resolution";
import type { SqlDatabase } from "../db/sql-database";

/**
 * Minimal D1 stub over the `prepare(sql).bind(...args).first()` shape the
 * settings store uses. `rows` is keyed by table name so a test can seed the
 * global row, the per-repo row, or neither.
 */
function fakeDb(rows: { global?: object; repo?: object } = {}): {
  db: SqlDatabase;
  bindings: unknown[][];
} {
  const bindings: unknown[][] = [];
  const db = {
    prepare: (sql: string) => ({
      bind: (...args: unknown[]) => {
        bindings.push(args);
        const row = sql.includes("integration_repo_settings") ? rows.repo : rows.global;
        return { first: async () => (row ? { settings: JSON.stringify(row) } : null) };
      },
    }),
  } as unknown as SqlDatabase;
  return { db, bindings };
}

describe("resolveScmSettings", () => {
  it("returns the built-in defaults when the deployment has no database", async () => {
    await expect(resolveScmSettings(null, { repoOwner: "acme", repoName: "web" })).resolves.toEqual(
      {}
    );
  });

  it("keys the per-repo lookup by owner/name", async () => {
    const { db, bindings } = fakeDb();

    await resolveScmSettings(db, { repoOwner: "Acme", repoName: "Web" });

    expect(bindings).toContainEqual(["scm", "acme/web"]);
  });

  it("merges global defaults with the per-repo override, override winning", async () => {
    const { db } = fakeDb({
      global: { defaults: { alwaysUseDraftMode: true, pullRequestLabel: "global" } },
      repo: { pullRequestLabel: "repo" },
    });

    await expect(resolveScmSettings(db, { repoOwner: "acme", repoName: "web" })).resolves.toEqual({
      alwaysUseDraftMode: true,
      pullRequestLabel: "repo",
    });
  });

  it("propagates storage failures so callers fail closed", async () => {
    const db = {
      prepare: () => {
        throw new Error("D1 unavailable");
      },
    } as unknown as SqlDatabase;

    await expect(resolveScmSettings(db, { repoOwner: "acme", repoName: "web" })).rejects.toThrow(
      "D1 unavailable"
    );
  });
});
