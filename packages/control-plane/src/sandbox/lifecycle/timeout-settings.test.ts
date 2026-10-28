import { describe, expect, it, vi } from "vitest";
import type { Logger } from "../../logger";
import {
  DEFAULT_BOOT_BUDGET_CONFIG,
  DEFAULT_CONNECTING_TIMEOUT_CONFIG,
  DEFAULT_INACTIVITY_CONFIG,
  MIN_UNATTENDED_INACTIVITY_TIMEOUT_MS,
} from "./decisions";
import { parseTimeoutMsSetting, resolveLifecycleTimeouts } from "./timeout-settings";

function createMockLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(() => createMockLogger()),
  };
}

describe("parseTimeoutMsSetting", () => {
  const setting = { defaultMs: 120_000, minMs: 60_000 };

  it.each([
    [undefined, 120_000],
    ["", 120_000],
    ["60000", 60_000],
    ["60001", 60_001],
    ["900000", 900_000],
    [String(Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER],
  ] as const)("accepts %j without a rejection", (raw, timeoutMs) => {
    expect(parseTimeoutMsSetting(raw, setting)).toEqual({ timeoutMs, rejectedValue: null });
  });

  it.each([
    "0",
    "-1",
    "59999",
    "060000",
    "60000.5",
    "60000ms",
    "6e4",
    "0xea60",
    "NaN",
    "Infinity",
    " 60000",
    "60000 ",
    " ",
    "9007199254740992",
  ])("rejects %j to the default without losing the rejected value", (raw) => {
    expect(parseTimeoutMsSetting(raw, setting)).toEqual({ timeoutMs: 120_000, rejectedValue: raw });
  });
});

describe("resolveLifecycleTimeouts", () => {
  it("uses every default when no knob is set", () => {
    const log = createMockLogger();

    expect(resolveLifecycleTimeouts({}, log)).toEqual({
      inactivity: {
        timeoutMs: DEFAULT_INACTIVITY_CONFIG.timeoutMs,
        unattendedTimeoutMs: DEFAULT_INACTIVITY_CONFIG.unattendedTimeoutMs,
      },
      bootBudget: { timeoutMs: DEFAULT_BOOT_BUDGET_CONFIG.timeoutMs },
    });
    expect(log.warn).not.toHaveBeenCalled();
  });

  it.each([
    { regular: "600000", unattended: "120000", effective: 120_000 },
    { regular: "600000", unattended: "600000", effective: 600_000 },
    { regular: "600000", unattended: "900000", effective: 600_000 },
    { regular: "60000", unattended: "120000", effective: 60_000 },
  ])(
    "caps unattended $unattended ms at the regular $regular ms timeout",
    ({ regular, unattended, effective }) => {
      const timeouts = resolveLifecycleTimeouts(
        {
          SANDBOX_INACTIVITY_TIMEOUT_MS: regular,
          SANDBOX_UNATTENDED_INACTIVITY_TIMEOUT_MS: unattended,
        },
        createMockLogger()
      );

      expect(timeouts.inactivity).toEqual({
        timeoutMs: Number(regular),
        unattendedTimeoutMs: effective,
      });
    }
  );

  it.each([
    ["SANDBOX_INACTIVITY_TIMEOUT_MS", "600000ms", 1, DEFAULT_INACTIVITY_CONFIG.timeoutMs],
    [
      "SANDBOX_UNATTENDED_INACTIVITY_TIMEOUT_MS",
      "59999",
      MIN_UNATTENDED_INACTIVITY_TIMEOUT_MS,
      DEFAULT_INACTIVITY_CONFIG.unattendedTimeoutMs,
    ],
    [
      "SANDBOX_BOOT_TIMEOUT_MS",
      String(DEFAULT_CONNECTING_TIMEOUT_CONFIG.timeoutMs),
      DEFAULT_CONNECTING_TIMEOUT_CONFIG.timeoutMs + 1,
      DEFAULT_BOOT_BUDGET_CONFIG.timeoutMs,
    ],
  ] as const)("warns once and defaults a rejected %s", (setting, raw, minimumMs, timeoutMs) => {
    const log = createMockLogger();

    resolveLifecycleTimeouts({ [setting]: raw }, log);

    expect(log.warn).toHaveBeenCalledExactlyOnceWith(`Ignoring ${setting}; using its default`, {
      event: "config.invalid",
      setting,
      rejected_value: raw,
      minimum_ms: minimumMs,
      timeout_ms: timeoutMs,
    });
  });
});
