import path from "node:path";
import process from "node:process";

import { ESLint } from "eslint";

import { parseComplexityMessage } from "./lint-complexity-message.mjs";

const TARGET_GLOB = "packages/**/*.{ts,tsx}";
const HOTSPOT_THRESHOLD = 20;
const RESULT_LIMIT = 25;
const DISTRIBUTION_THRESHOLDS = [10, 15, 20, 30, 50];

function toRelativePath(filePath) {
  return path.relative(process.cwd(), filePath).split(path.sep).join("/");
}

function isTestFile(filePath) {
  return (
    /(?:^|\/)(?:__tests__|tests?)(?:\/|$)/u.test(filePath) ||
    /\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(filePath)
  );
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareFindings(left, right) {
  return (
    right.complexity - left.complexity ||
    compareText(left.file, right.file) ||
    left.line - right.line ||
    left.column - right.column ||
    compareText(left.description, right.description)
  );
}

function collectFindings(results) {
  const files = { total: results.length, production: 0, test: 0 };
  const findings = { production: [], test: [] };

  for (const result of results) {
    const file = toRelativePath(result.filePath);
    const category = isTestFile(file) ? "test" : "production";
    files[category] += 1;

    for (const message of result.messages) {
      if (message.fatal) {
        throw new Error(
          `ESLint could not analyze ${file}:${message.line ?? 0}:${message.column ?? 0}: ${message.message}`
        );
      }
      if (message.ruleId === "complexity") {
        findings[category].push(parseComplexityMessage(file, message));
      }
    }
  }

  findings.production.sort(compareFindings);
  findings.test.sort(compareFindings);
  return { files, findings };
}

function distribution(findings) {
  return Object.fromEntries(
    DISTRIBUTION_THRESHOLDS.map((threshold) => [
      `over${threshold}`,
      findings.filter(({ complexity }) => complexity > threshold).length,
    ])
  );
}

function buildReport(results) {
  const { files, findings } = collectFindings(results);
  const productionHotspots = findings.production.filter(
    ({ complexity }) => complexity > HOTSPOT_THRESHOLD
  );
  const testHotspots = findings.test.filter(({ complexity }) => complexity > HOTSPOT_THRESHOLD);

  return {
    analysis: {
      metric: "cyclomatic-complexity",
      eslintRule: "complexity",
      variant: "classic",
      targetGlob: TARGET_GLOB,
      hotspotThreshold: HOTSPOT_THRESHOLD,
      testFilesExcludedFromProductionHotspots: true,
    },
    summary: {
      files,
      functions: {
        total: findings.production.length + findings.test.length,
        production: findings.production.length,
        test: findings.test.length,
      },
      hotspots: {
        production: productionHotspots.length,
        test: testHotspots.length,
      },
    },
    distribution: {
      production: distribution(findings.production),
      test: distribution(findings.test),
    },
    productionHotspots,
    testHotspots,
  };
}

function formatDistribution(counts) {
  return DISTRIBUTION_THRESHOLDS.map(
    (threshold) => `>${threshold}: ${counts[`over${threshold}`]}`
  ).join(" | ");
}

function formatHotspots(hotspots) {
  if (hotspots.length === 0) {
    return "  None";
  }

  return hotspots
    .slice(0, RESULT_LIMIT)
    .map(
      ({ file, line, column, complexity, description }) =>
        `  ${String(complexity).padStart(3)}  ${file}:${line}:${column}  ${description}`
    )
    .join("\n");
}

function formatText(report) {
  const { analysis, summary, distribution: counts, productionHotspots } = report;
  const shown = Math.min(productionHotspots.length, RESULT_LIMIT);
  const resultCount =
    shown === productionHotspots.length
      ? `${shown} found`
      : `top ${shown} of ${productionHotspots.length}`;

  return `Cyclomatic complexity analysis (ESLint classic variant)

Files: ${summary.files.total} total (${summary.files.production} production, ${summary.files.test} test)
Functions: ${summary.functions.total} total (${summary.functions.production} production, ${summary.functions.test} test)
Production distribution: ${formatDistribution(counts.production)}
Test distribution: ${formatDistribution(counts.test)}

Production hotspots (complexity >${analysis.hotspotThreshold}; ${resultCount})
  Cx   Location  Function
${formatHotspots(productionHotspots)}

Tests are excluded from the hotspot table (${summary.hotspots.test} test hotspots over the configured threshold).
Complexity findings are report-only and do not affect the exit code.
`;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.some((argument) => argument !== "--json")) {
    throw new Error("Only the optional --json flag is supported");
  }

  const eslint = new ESLint({
    ruleFilter: ({ ruleId }) => ruleId === "complexity",
    overrideConfig: [
      {
        files: [TARGET_GLOB],
        rules: {
          complexity: ["warn", { max: 0, variant: "classic" }],
        },
      },
    ],
  });
  const report = buildReport(await eslint.lintFiles([TARGET_GLOB]));
  const output = args.includes("--json") ? JSON.stringify(report, null, 2) : formatText(report);
  process.stdout.write(`${output}\n`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Complexity analysis failed: ${message}\n`);
  process.exitCode = 1;
});
