import { MIN_SANDBOX_TIMEOUT_MS } from "@open-inspect/shared";

const MILLISECONDS_PER_MINUTE = 60_000;

export const MIN_SANDBOX_TIMEOUT_MINUTES = MIN_SANDBOX_TIMEOUT_MS / MILLISECONDS_PER_MINUTE;

export function sandboxTimeoutMsFromMinutes(value: string): number | undefined {
  if (value === "" || !/^\d+(?:\.\d+)?$/.test(value)) return undefined;

  const timeoutSeconds = Number(value) * 60;
  const roundedSeconds = Math.round(timeoutSeconds);
  const timeoutMs = roundedSeconds * 1000;
  const tolerance = Math.min(0.000001, Number.EPSILON * Math.max(1, Math.abs(timeoutSeconds)) * 4);
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < MIN_SANDBOX_TIMEOUT_MS ||
    Math.abs(timeoutSeconds - roundedSeconds) > tolerance
  ) {
    return undefined;
  }
  return timeoutMs;
}

export function sandboxTimeoutMinutesFromMs(timeoutMs: number | undefined): string {
  return timeoutMs === undefined ? "" : String(timeoutMs / MILLISECONDS_PER_MINUTE);
}
