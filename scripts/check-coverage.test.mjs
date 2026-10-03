import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { checkCoverage } from "./check-coverage.mjs";
import { coverageBaseline, coverageExclusions, coverageThresholds } from "./coverage-policy.ts";

test("all package floors preserve the production-only three-point budget", () => {
  for (const [name, baseline] of Object.entries(coverageBaseline.packages)) {
    const floors = coverageThresholds(name);
    for (const [metric, { covered, total }] of Object.entries(baseline.metrics)) {
      const minimum =
        (total === 0 ? 100 : (100 * covered) / total) -
        coverageBaseline.maximumDropPercentagePoints;
      assert.ok(floors[metric] >= minimum);
      assert.ok(floors[metric] < minimum + 0.01);
    }
  }
  assert.ok(coverageExclusions("web").includes("src/**/*.{test,spec}.{ts,tsx}"));
  assert.ok(coverageExclusions("shared").includes("src/triggers/testing.ts"));
});

test("each TypeScript metric is enforced independently", () => {
  const baseline = coverageBaseline.packages.web.metrics;
  assert.ok(checkCoverage("web", { total: baseline }).every((result) => result.passed));
  for (const metric of Object.keys(baseline)) {
    const report = {
      total: { ...baseline, [metric]: { covered: 0, total: baseline[metric].total } },
    };
    const failures = checkCoverage("web", report).filter((result) => !result.passed);
    assert.deepEqual(
      failures.map((result) => result.metric),
      [metric]
    );
  }
});

test("Python branches cannot be masked by high statement or combined coverage", () => {
  const report = {
    totals: {
      covered_lines: 10000,
      num_statements: 10000,
      covered_branches: 50,
      num_branches: 100,
      percent_covered: 99.5,
    },
  };
  assert.deepEqual(
    checkCoverage("sandbox-runtime", report).map((result) => result.passed),
    [true, false]
  );
  report.totals.covered_lines = 5000;
  report.totals.covered_branches = 100;
  assert.deepEqual(
    checkCoverage("sandbox-runtime", report).map((result) => result.passed),
    [false, true]
  );
});

test("missing, malformed, and impossible counts fail closed", () => {
  assert.throws(() => checkCoverage("unknown", {}), /Unknown coverage package/);
  for (const counts of [
    undefined,
    { covered: "1", total: 2 },
    { covered: -1, total: 2 },
    { covered: 3, total: 2 },
  ]) {
    assert.throws(
      () =>
        checkCoverage("web", {
          total: { ...coverageBaseline.packages.web.metrics, statements: counts },
        }),
      /Missing or invalid web statements/
    );
  }
  assert.throws(
    () => checkCoverage("sandbox-runtime", { totals: { covered_lines: 100, num_statements: 100 } }),
    /branches/
  );
});

test("zero branch denominator is fully covered", () => {
  const report = {
    totals: { covered_lines: 100, num_statements: 100, covered_branches: 0, num_branches: 0 },
  };
  assert.ok(checkCoverage("modal-infra", report).every((result) => result.passed));
});

test("the CLI exits nonzero when only Python branches breach their floor", () => {
  const directory = mkdtempSync(join(tmpdir(), "coverage-gate-"));
  try {
    const reportPath = join(directory, "report.json");
    writeFileSync(
      reportPath,
      JSON.stringify({
        totals: { covered_lines: 100, num_statements: 100, covered_branches: 0, num_branches: 100 },
      })
    );
    const result = spawnSync(
      process.execPath,
      [
        fileURLToPath(new URL("./check-coverage.mjs", import.meta.url)),
        "sandbox-runtime",
        reportPath,
      ],
      { encoding: "utf8" }
    );
    assert.equal(result.status, 1);
    assert.match(result.stdout, /statements:.*PASS/);
    assert.match(result.stdout, /branches:.*FAIL/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
