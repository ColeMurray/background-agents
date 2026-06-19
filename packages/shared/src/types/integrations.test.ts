import { describe, expect, it } from "vitest";
import {
  DEFAULT_BUILD_TIMEOUT_SECONDS,
  MAX_BUILD_TIMEOUT_SECONDS,
  resolveBuildTimeoutSeconds,
} from "./integrations";

describe("resolveBuildTimeoutSeconds", () => {
  it("defaults when no setting is present", () => {
    expect(resolveBuildTimeoutSeconds(undefined)).toBe(DEFAULT_BUILD_TIMEOUT_SECONDS);
    expect(resolveBuildTimeoutSeconds({})).toBe(DEFAULT_BUILD_TIMEOUT_SECONDS);
  });

  it("passes through values at or below the maximum, including short ones", () => {
    expect(resolveBuildTimeoutSeconds({ buildTimeoutSeconds: 2400 })).toBe(2400);
    expect(resolveBuildTimeoutSeconds({ buildTimeoutSeconds: 60 })).toBe(60);
  });

  it("caps above the maximum", () => {
    expect(resolveBuildTimeoutSeconds({ buildTimeoutSeconds: 99999 })).toBe(
      MAX_BUILD_TIMEOUT_SECONDS
    );
    expect(resolveBuildTimeoutSeconds({ buildTimeoutSeconds: MAX_BUILD_TIMEOUT_SECONDS })).toBe(
      MAX_BUILD_TIMEOUT_SECONDS
    );
  });

  it("falls back to the default for non-finite values", () => {
    expect(resolveBuildTimeoutSeconds({ buildTimeoutSeconds: NaN })).toBe(
      DEFAULT_BUILD_TIMEOUT_SECONDS
    );
  });

  it("rounds fractional values before capping", () => {
    expect(resolveBuildTimeoutSeconds({ buildTimeoutSeconds: 2400.4 })).toBe(2400);
  });

  it("keeps the default below the maximum", () => {
    expect(DEFAULT_BUILD_TIMEOUT_SECONDS).toBeLessThan(MAX_BUILD_TIMEOUT_SECONDS);
  });
});
