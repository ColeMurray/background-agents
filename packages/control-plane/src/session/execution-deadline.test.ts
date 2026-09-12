import { describe, expect, it } from "vitest";
import { resolveExecutionBudget, resolveExecutionPolicy } from "./execution-deadline";

const sandbox = { sandboxId: "sandbox-1", requiresStopEvidence: true };

describe("execution deadline ownership", () => {
  it("retains the environment watchdog as a turn cap without subtracting another reserve", () => {
    const policy = resolveExecutionPolicy(undefined, "3600000");
    expect(policy.turnAllowanceMs).toBe(3_600_000);
    expect(policy.sandboxDurationMs).toBe(7_200_000);
    expect(policy.source).toBe("execution_timeout_env");
  });

  it("preserves session-setting precedence and rejects invalid environment overrides", () => {
    expect(resolveExecutionPolicy(3_600_000, "60000").turnAllowanceMs).toBe(2_700_000);
    for (const override of [undefined, "", "nope", "0", "-1", "Infinity"]) {
      expect(resolveExecutionPolicy(undefined, override).turnAllowanceMs).toBe(6_300_000);
    }
    expect(resolveExecutionPolicy(undefined, "14400000").turnAllowanceMs).toBe(6_300_000);
  });

  it("reserves one cleanup interval without inventing an unknown provider expiry", () => {
    expect(resolveExecutionBudget(10_000, 7_200_000, sandbox)).toEqual({
      ...sandbox,
      executionDeadlineMs: 6_310_000,
      cleanupDeadlineMs: 7_210_000,
      cleanupReserveMs: 900_000,
    });
  });

  it("caps a late turn before known provider expiry", () => {
    const budget = resolveExecutionBudget(5_000_000, 7_200_000, {
      ...sandbox,
      providerExpiresAtMs: 7_200_000,
    });
    expect(budget.executionDeadlineMs).toBe(6_300_000);
    expect(budget.cleanupDeadlineMs).toBe(7_200_000);
  });

  it("does not restart either deadline on delayed redelivery or provider renewal", () => {
    const persisted = { execution_deadline_ms: 6_300_000, cleanup_deadline_ms: 7_200_000 };
    const budget = resolveExecutionBudget(
      5_000_000,
      14_400_000,
      {
        ...sandbox,
        providerExpiresAtMs: 14_400_000,
      },
      persisted
    );
    expect(budget.executionDeadlineMs).toBe(persisted.execution_deadline_ms);
    expect(budget.cleanupDeadlineMs).toBe(persisted.cleanup_deadline_ms);
  });

  it("can tighten an existing deadline when a shorter provider bound becomes known", () => {
    const budget = resolveExecutionBudget(
      5_000_000,
      7_200_000,
      {
        ...sandbox,
        providerExpiresAtMs: 6_000_000,
      },
      { execution_deadline_ms: 6_300_000, cleanup_deadline_ms: 7_200_000 }
    );
    expect(budget.executionDeadlineMs).toBe(5_100_000);
    expect(budget.cleanupDeadlineMs).toBe(6_000_000);
  });

  it("returns an exhausted budget instead of giving another turn a fresh allowance", () => {
    const now = 7_000_000;
    const budget = resolveExecutionBudget(now, 7_200_000, {
      ...sandbox,
      providerExpiresAtMs: 7_200_000,
    });
    expect(budget.executionDeadlineMs).toBeLessThan(now);
    expect(budget.cleanupDeadlineMs).toBe(7_200_000);
  });
});
