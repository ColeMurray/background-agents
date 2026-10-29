import { readFileSync } from "node:fs";
import { URL } from "node:url";

type Metric = "statements" | "branches" | "functions" | "lines";
type Counts = { covered: number; total: number };
interface PackageBaseline {
  provider: "v8" | "istanbul" | "coverage.py";
  exclude?: string[];
  metrics: Partial<Record<Metric, Counts>>;
}

export const coverageBaseline = JSON.parse(
  readFileSync(new URL("./coverage-baseline.json", import.meta.url), "utf8")
) as {
  sourceCommit: string;
  maximumDropPercentagePoints: number;
  exclude: string[];
  packages: Record<string, PackageBaseline>;
};

export function coverageExclusions(packageName: string): string[] {
  const baseline = coverageBaseline.packages[packageName];
  if (!baseline) throw new Error(`Unknown coverage package: ${packageName}`);
  return [...coverageBaseline.exclude, ...(baseline.exclude ?? [])];
}

export function coverageThresholds(packageName: string): Partial<Record<Metric, number>> {
  const baseline = coverageBaseline.packages[packageName];
  if (!baseline) throw new Error(`Unknown coverage package: ${packageName}`);
  return Object.fromEntries(
    Object.entries(baseline.metrics).map(([metric, counts]) => {
      const percent = counts.total === 0 ? 100 : (100 * counts.covered) / counts.total;
      // Round up so truncated report percentages cannot loosen the original budget.
      return [
        metric,
        Math.ceil((percent - coverageBaseline.maximumDropPercentagePoints) * 100) / 100,
      ];
    })
  );
}
