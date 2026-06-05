import { describe, expect, it } from "vitest";
import { normalizeSandboxSettings, SandboxSettingsValidationError } from "./settings";

class CustomSettingsValidationError extends Error {}

describe("normalizeSandboxSettings", () => {
  it("throws for invalid settings by default", () => {
    expect(() => normalizeSandboxSettings({ cpuCores: 0 })).toThrow(SandboxSettingsValidationError);
    expect(() => normalizeSandboxSettings({ memoryMib: 256.5 })).toThrow(
      SandboxSettingsValidationError
    );
  });

  it("preserves null resource overrides as explicit provider defaults", () => {
    expect(normalizeSandboxSettings({ cpuCores: null, memoryMib: null })).toEqual({
      cpuCores: null,
      memoryMib: null,
    });
  });

  it("can throw caller-provided validation errors", () => {
    expect(() =>
      normalizeSandboxSettings(
        { memoryMib: 0 },
        {
          createError: (message) => new CustomSettingsValidationError(message),
        }
      )
    ).toThrow(CustomSettingsValidationError);
  });

  it("omits invalid stored values while preserving valid fields", () => {
    expect(
      normalizeSandboxSettings(
        {
          tunnelPorts: ["bad", 3000, 3000, 99999],
          terminalEnabled: true,
          maxConcurrentChildSessions: 6,
          maxTotalChildSessions: 5,
          cpuCores: -1,
          memoryMib: 2048,
        },
        { invalid: "omit" }
      )
    ).toEqual({
      tunnelPorts: [3000],
      terminalEnabled: true,
      maxTotalChildSessions: 5,
      memoryMib: 2048,
    });
  });
});
