import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

/**
 * The `9xxx` block belongs to the overlay.
 *
 * Upstream's migration sequence is dense and low (`0089` at the time of
 * writing), so a block that upstream will not reach for thousands of
 * migrations is safe. But "safe" is a claim, and a claim needs a check: if
 * upstream ever lands a `9xxx_` migration, the two would collide, and the
 * migration runner does not skip a collision — it **stops**, and the
 * deployment does not happen.
 *
 * So this check runs in CI, before the collision can reach a deployment.
 */

const MIGRATIONS = "terraform/d1/migrations";
const OVERLAY_BLOCK = /^9\d{3}_/;

function localMigrationNames() {
  return readdirSync(MIGRATIONS)
    .filter((name) => name.endsWith(".sql"))
    .sort();
}

function upstreamMigrationNames() {
  try {
    const out = execFileSync("git", ["ls-tree", "-r", "--name-only", "origin/main"], {
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    });
    return out
      .split("\n")
      .filter((line) => line.startsWith(`${MIGRATIONS}/`) && line.endsWith(".sql"))
      .map((line) => line.slice(MIGRATIONS.length + 1))
      .sort();
  } catch {
    // No upstream in this checkout: the check has nothing to compare against.
    return [];
  }
}

test("no two migrations share a numeric prefix", () => {
  const seen = new Map();
  for (const name of localMigrationNames()) {
    const prefix = name.match(/^(\d+)/)?.[1];
    assert.ok(prefix, `${name} has no numeric prefix`);
    const previous = seen.get(prefix);
    assert.equal(
      previous,
      undefined,
      `duplicate migration prefix ${prefix}: ${previous} and ${name}`
    );
    seen.set(prefix, name);
  }
});

test("the overlay's migration block is not one upstream can take", () => {
  const upstream = upstreamMigrationNames();
  if (upstream.length === 0) return;
  const collisions = upstream.filter((name) => OVERLAY_BLOCK.test(name));
  assert.deepEqual(
    collisions,
    [],
    `upstream has taken the overlay's 9xxx block: ${collisions.join(", ")}`
  );
});

test("every migration in the overlay's block declares the feature that owns it", () => {
  for (const name of localMigrationNames()) {
    if (!OVERLAY_BLOCK.test(name)) continue;
    const source = readFileSync(join(MIGRATIONS, name), "utf8");
    assert.match(
      source,
      /^-- feature: [a-zA-Z]+/m,
      `${name} does not declare the feature that owns it`
    );
  }
});
