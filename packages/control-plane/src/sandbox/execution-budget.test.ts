import { describe, expect, it } from "vitest";

import { resolveExecutionBudgetMs } from "./execution-budget";
import { DEFAULT_SANDBOX_TIMEOUT_SECONDS } from "./provider";
import type { Env } from "../types";

const env = (executionTimeoutMs?: string) => ({ EXECUTION_TIMEOUT_MS: executionTimeoutMs }) as Env;

describe("resolveExecutionBudgetMs", () => {
  it("prefers the session's own sandbox timeout over the deployment default", () => {
    expect(resolveExecutionBudgetMs({ sandboxTimeoutMs: 28_800_000 }, env())).toBe(28_800_000);
  });

  it("keeps the sandbox timeout even when a deployment-wide default is configured", () => {
    expect(resolveExecutionBudgetMs({ sandboxTimeoutMs: 28_800_000 }, env("900000"))).toBe(
      28_800_000
    );
  });

  it("falls back to the deployment-wide default", () => {
    expect(resolveExecutionBudgetMs({}, env("900000"))).toBe(900_000);
  });

  it("falls back to the default sandbox lifetime when nothing is configured", () => {
    expect(resolveExecutionBudgetMs({}, env())).toBe(DEFAULT_SANDBOX_TIMEOUT_SECONDS * 1000);
  });

  it.each(["", "   ", "invalid", "0", "-900000", "1000ms", "1.5", "NaN", "Infinity"])(
    "treats a malformed deployment-wide value %j as unset",
    (raw) => {
      expect(resolveExecutionBudgetMs({}, env(raw))).toBe(DEFAULT_SANDBOX_TIMEOUT_SECONDS * 1000);
    }
  );
});
