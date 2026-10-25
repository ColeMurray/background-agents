/**
 * Deployment timeout knobs for the sandbox lifecycle.
 *
 * Each knob resolves through one parser and one rejection log, so a malformed
 * value never takes every session down at construction the way a missing
 * provider does: it falls back to its default and says so.
 */

import type { Logger } from "../../logger";
import {
  DEFAULT_BOOT_BUDGET_CONFIG,
  DEFAULT_CONNECTING_TIMEOUT_CONFIG,
  DEFAULT_INACTIVITY_CONFIG,
  MIN_UNATTENDED_INACTIVITY_TIMEOUT_MS,
  type BootBudgetConfig,
  type InactivityPolicyConfig,
} from "./decisions";

/** A timeout knob's default and the smallest value it accepts, in ms. */
export interface TimeoutSetting {
  defaultMs: number;
  minMs: number;
}

const LIFECYCLE_TIMEOUT_SETTINGS = {
  SANDBOX_INACTIVITY_TIMEOUT_MS: { defaultMs: DEFAULT_INACTIVITY_CONFIG.timeoutMs, minMs: 1 },
  SANDBOX_UNATTENDED_INACTIVITY_TIMEOUT_MS: {
    defaultMs: DEFAULT_INACTIVITY_CONFIG.unattendedTimeoutMs,
    minMs: MIN_UNATTENDED_INACTIVITY_TIMEOUT_MS,
  },
  // Both the boot budget and the connect watchdog are measured from the
  // reservation; a budget at or below the watchdog would fail a generation
  // that has not yet had its chance to connect.
  SANDBOX_BOOT_TIMEOUT_MS: {
    defaultMs: DEFAULT_BOOT_BUDGET_CONFIG.timeoutMs,
    minMs: DEFAULT_CONNECTING_TIMEOUT_CONFIG.timeoutMs + 1,
  },
} satisfies Record<string, TimeoutSetting>;

export type LifecycleTimeoutEnv = Readonly<
  Partial<Record<keyof typeof LIFECYCLE_TIMEOUT_SETTINGS, string>>
>;

export interface LifecycleTimeouts {
  inactivity: Pick<InactivityPolicyConfig, "timeoutMs" | "unattendedTimeoutMs">;
  bootBudget: BootBudgetConfig;
}

/**
 * Parse a timeout knob. The value must be a whole number of milliseconds at or
 * above `minMs`. Anything else (including `parseInt`-tolerant forms like
 * `1000junk` or `1.5`) resolves to the default and is reported through
 * `rejectedValue`, so a typo weakens nothing silently. An unset knob is not a
 * rejection.
 *
 * Pure function: no side effects.
 */
export function parseTimeoutMsSetting(
  raw: string | undefined,
  setting: TimeoutSetting
): { timeoutMs: number; rejectedValue: string | null } {
  if (raw === undefined || raw === "") {
    return { timeoutMs: setting.defaultMs, rejectedValue: null };
  }
  const parsed = /^[1-9]\d*$/.test(raw) ? Number(raw) : Number.NaN;
  if (Number.isSafeInteger(parsed) && parsed >= setting.minMs) {
    return { timeoutMs: parsed, rejectedValue: null };
  }
  return { timeoutMs: setting.defaultMs, rejectedValue: raw };
}

/**
 * Resolve every lifecycle timeout knob, warning once per rejected value. The
 * unattended timeout is capped by the regular one here, so the lifecycle never
 * re-derives the cap and an unattended value at or above the regular timeout
 * disables the shorter window.
 */
export function resolveLifecycleTimeouts(env: LifecycleTimeoutEnv, log: Logger): LifecycleTimeouts {
  const resolve = (name: keyof typeof LIFECYCLE_TIMEOUT_SETTINGS): number => {
    const setting = LIFECYCLE_TIMEOUT_SETTINGS[name];
    const { timeoutMs, rejectedValue } = parseTimeoutMsSetting(env[name], setting);
    if (rejectedValue !== null) {
      log.warn(`Ignoring ${name}; using its default`, {
        event: "config.invalid",
        setting: name,
        rejected_value: rejectedValue,
        minimum_ms: setting.minMs,
        timeout_ms: timeoutMs,
      });
    }
    return timeoutMs;
  };

  const inactivityTimeoutMs = resolve("SANDBOX_INACTIVITY_TIMEOUT_MS");
  return {
    inactivity: {
      timeoutMs: inactivityTimeoutMs,
      unattendedTimeoutMs: Math.min(
        resolve("SANDBOX_UNATTENDED_INACTIVITY_TIMEOUT_MS"),
        inactivityTimeoutMs
      ),
    },
    bootBudget: { timeoutMs: resolve("SANDBOX_BOOT_TIMEOUT_MS") },
  };
}
