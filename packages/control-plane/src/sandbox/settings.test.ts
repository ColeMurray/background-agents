import { describe, expect, it } from "vitest";
import { INTERNAL_TTYD_PORT } from "@open-inspect/shared";
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

  it("accepts valid codeServerPort and terminalPort", () => {
    expect(normalizeSandboxSettings({ codeServerPort: 8081, terminalPort: 7000 })).toEqual({
      codeServerPort: 8081,
      terminalPort: 7000,
    });
  });

  it("throws for out-of-range service ports", () => {
    expect(() => normalizeSandboxSettings({ codeServerPort: 0 })).toThrow(
      SandboxSettingsValidationError
    );
    expect(() => normalizeSandboxSettings({ terminalPort: 70000 })).toThrow(
      SandboxSettingsValidationError
    );
  });

  it("rejects the reserved internal terminal port", () => {
    expect(() => normalizeSandboxSettings({ codeServerPort: INTERNAL_TTYD_PORT })).toThrow(
      SandboxSettingsValidationError
    );
    expect(() => normalizeSandboxSettings({ tunnelPorts: [INTERNAL_TTYD_PORT] })).toThrow(
      SandboxSettingsValidationError
    );
  });

  it("rejects duplicate ports across code-server, terminal, and tunnels", () => {
    expect(() => normalizeSandboxSettings({ codeServerPort: 3000, tunnelPorts: [3000] })).toThrow(
      SandboxSettingsValidationError
    );
    expect(() => normalizeSandboxSettings({ codeServerPort: 9000, terminalPort: 9000 })).toThrow(
      SandboxSettingsValidationError
    );
  });

  it("frees the default port for a tunnel when code-server is moved", () => {
    expect(normalizeSandboxSettings({ codeServerPort: 8081, tunnelPorts: [8080] })).toEqual({
      codeServerPort: 8081,
      tunnelPorts: [8080],
    });
  });

  it("drops colliding ports in omit mode so the merged config stays conflict-free", () => {
    // Mirrors getResolvedConfig: a global service port and a repo tunnel port can
    // merge into a collision that must not survive omit-mode normalization (or it
    // would be silently dropped again at sandbox spawn).
    expect(
      normalizeSandboxSettings(
        { codeServerPort: 9000, tunnelPorts: [9000, 3000] },
        { invalid: "omit" }
      )
    ).toEqual({
      codeServerPort: 9000,
      tunnelPorts: [3000],
    });
  });

  it("drops the reserved internal terminal port from tunnels in omit mode", () => {
    expect(
      normalizeSandboxSettings({ tunnelPorts: [INTERNAL_TTYD_PORT, 3000] }, { invalid: "omit" })
    ).toEqual({
      tunnelPorts: [3000],
    });
  });
});
