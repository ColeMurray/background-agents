import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { coverageBaseline, coverageThresholds } from "./coverage-policy.ts";

export function checkCoverage(packageName, report) {
  const baseline = coverageBaseline.packages[packageName];
  if (!baseline) throw new Error(`Unknown coverage package: ${packageName}`);
  const thresholds = coverageThresholds(packageName);
  const counts =
    baseline.provider === "coverage.py"
      ? {
          statements: {
            covered: report.totals?.covered_lines,
            total: report.totals?.num_statements,
          },
          branches: {
            covered: report.totals?.covered_branches,
            total: report.totals?.num_branches,
          },
        }
      : report.total;
  return Object.entries(thresholds).map(([metric, floor]) => {
    const value = counts?.[metric];
    if (
      !value ||
      !Number.isSafeInteger(value.covered) ||
      !Number.isSafeInteger(value.total) ||
      value.covered < 0 ||
      value.total < 0 ||
      value.covered > value.total
    ) {
      throw new Error(`Missing or invalid ${packageName} ${metric} coverage counts`);
    }
    const percent = value.total === 0 ? 100 : (100 * value.covered) / value.total;
    return { metric, percent, floor, passed: percent >= floor };
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [packageName, reportPath] = process.argv.slice(2);
  if (!packageName || !reportPath)
    throw new Error("Usage: node scripts/check-coverage.mjs PACKAGE REPORT.json");
  const results = checkCoverage(packageName, JSON.parse(readFileSync(reportPath, "utf8")));
  for (const { metric, percent, floor, passed } of results) {
    console.log(
      `${packageName} ${metric}: ${percent.toFixed(2)}% >= ${floor.toFixed(2)}% ${passed ? "PASS" : "FAIL"}`
    );
  }
  if (results.some((result) => !result.passed)) process.exitCode = 1;
}
