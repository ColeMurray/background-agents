// What `scripts/d1-migrate.sh` does when the ledger disagrees with the files.
//
// The postcondition is the part nobody exercises by hand: it only matters when
// a migration has already failed to record, which is exactly when the deploy
// is about to be marked successful over a half-migrated database. So `npx` is
// replaced with a stub whose ledger is set per case, letting the two
// divergence directions be driven deterministically.
//
// The stub answers step 2's ordered read with an empty ledger, so every
// migration on disk is treated as pending and applied; the ledger it reports
// at the postcondition is whatever the case asked for. That isolates the
// postcondition from the apply loop: a case fails only because the final
// ledger disagrees with the files, never because a migration was skipped.
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const SCRIPT = fileURLToPath(new URL("./d1-migrate.sh", import.meta.url));

// Stand-in for `npx wrangler`. Only the calls d1-migrate.sh makes: the
// CREATE TABLE, step 2's ordered ledger read, each migration's --file apply,
// and the postcondition's unordered ledger read.
const NPX_STUB = `#!/bin/bash
set -uo pipefail
args="$*"
echo "$args" >>"$STUB_DIR/calls"

# Step 2 reads the ledger ordered by version to decide what is pending.
# Report it empty so every file on disk is applied.
if [[ "$args" == *"ORDER BY version"* ]]; then
  echo '[{"results":[]}]'
  exit 0
fi

# The postcondition re-reads the ledger. Serve the case's final state.
if [[ "$args" == *"SELECT version, name FROM _schema_migrations"* ]]; then
  cat "$STUB_DIR/final_ledger"
  exit 0
fi

exit 0
`;

/**
 * Run d1-migrate.sh against `files` on disk, with the postcondition's ledger
 * read answering `ledger` (an array of [version, name] pairs).
 */
function run(files, ledger) {
  const dir = mkdtempSync(join(tmpdir(), "d1-migrate-"));
  const migrations = join(dir, "migrations");
  const stubDir = join(dir, "stub");
  mkdirSync(migrations);
  mkdirSync(stubDir);

  for (const name of files) {
    writeFileSync(join(migrations, name), "CREATE TABLE example (id INTEGER);\n");
  }
  writeFileSync(
    join(stubDir, "final_ledger"),
    `${JSON.stringify([{ results: ledger.map(([version, name]) => ({ version, name })) }])}\n`
  );

  const npx = join(stubDir, "npx");
  writeFileSync(npx, NPX_STUB);
  chmodSync(npx, 0o755);

  return spawnSync("bash", [SCRIPT, "example-db", migrations], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${stubDir}:${process.env.PATH}`, STUB_DIR: stubDir },
  });
}

test("accepts a ledger that records exactly the migrations on disk", () => {
  const result = run(
    ["0001_alpha.sql", "0002_beta.sql"],
    [
      ["0001", "0001_alpha.sql"],
      ["0002", "0002_beta.sql"],
    ]
  );

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Verified: ledger matches all 2 migration file\(s\)\./);
});

test("counts zero migrations when both the directory and the ledger are empty", () => {
  const result = run([], []);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Verified: ledger matches all 0 migration file\(s\)\./);
});

test("lists no phantom missing entry when the directory is empty", () => {
  const result = run([], [["0001", "0001_alpha.sql"]]);

  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /Missing from the database \(expected but not recorded\):\nUnexpected in the database/
  );
  assert.match(result.stderr, /Unexpected in the database[^]*?0001\s+0001_alpha\.sql/);
});

test("fails when a migration it just applied is not recorded", () => {
  // The silent-partial case: the apply loop reported success for both files,
  // so without the postcondition the script exits 0 over a database missing
  // one migration.
  const result = run(["0001_alpha.sql", "0002_beta.sql"], [["0001", "0001_alpha.sql"]]);

  assert.equal(result.status, 1);
  assert.match(result.stdout, /Done\. Applied 2 migration\(s\)\./);
  assert.match(result.stderr, /migration ledger does not match/);
  assert.match(result.stderr, /Missing from the database[^]*?0002\s+0002_beta\.sql/);
});

test("fails when the ledger records a migration with no file", () => {
  const result = run(
    ["0001_alpha.sql"],
    [
      ["0001", "0001_alpha.sql"],
      ["0003", "0003_removed.sql"],
    ]
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /migration ledger does not match/);
  assert.match(result.stderr, /Unexpected in the database[^]*?0003\s+0003_removed\.sql/);
});

test("reports a version recorded under a different filename in both directions", () => {
  // A renumbered migration that was never reconciled: the version is present
  // but names a different file, so it is simultaneously missing and unexpected.
  const result = run(["0001_alpha.sql"], [["0001", "0001_renamed.sql"]]);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Missing from the database[^]*?0001\s+0001_alpha\.sql/);
  assert.match(result.stderr, /Unexpected in the database[^]*?0001\s+0001_renamed\.sql/);
});
