import { describe, expect, it } from "vitest";
import {
  DEFAULT_CODE_SERVER_PORT,
  DEFAULT_TERMINAL_PORT,
  DEFAULT_VNC_PORT,
  INTERNAL_TTYD_PORT,
} from "@open-inspect/shared/types/integrations";
import {
  normalizeSandboxSettings,
  parsePersistedSandboxSettings,
  SandboxSettingsValidationError,
} from "./settings";

class CustomSettingsValidationError extends Error {}

describe("parsePersistedSandboxSettings", () => {
  it("returns empty settings when no snapshot is stored", () => {
    expect(parsePersistedSandboxSettings(null)).toEqual({});
  });

  it("parses and normalizes persisted settings", () => {
    expect(
      parsePersistedSandboxSettings('{"sandboxTimeoutMs":14400000,"tunnelPorts":[3000,"bad"]}')
    ).toEqual({ sandboxTimeoutMs: 14_400_000, tunnelPorts: [3000] });
  });

  it.each(["", "not-json"])("throws when persisted blob %j is not valid JSON", (settingsJson) => {
    expect(() => parsePersistedSandboxSettings(settingsJson)).toThrow(SyntaxError);
  });
});

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

  it("accepts a valid buildTimeoutSeconds", () => {
    expect(normalizeSandboxSettings({ buildTimeoutSeconds: 2400 })).toEqual({
      buildTimeoutSeconds: 2400,
    });
  });

  it("throws for a non-positive or non-integer buildTimeoutSeconds", () => {
    expect(() => normalizeSandboxSettings({ buildTimeoutSeconds: 0 })).toThrow(
      SandboxSettingsValidationError
    );
    expect(() => normalizeSandboxSettings({ buildTimeoutSeconds: 12.5 })).toThrow(
      SandboxSettingsValidationError
    );
  });

  it("omits an invalid buildTimeoutSeconds in omit mode while keeping valid fields", () => {
    expect(
      normalizeSandboxSettings(
        { buildTimeoutSeconds: -5, terminalEnabled: true },
        { invalid: "omit" }
      )
    ).toEqual({ terminalEnabled: true });
  });

  it("accepts a positive integer sandboxTimeoutMs", () => {
    expect(normalizeSandboxSettings({ sandboxTimeoutMs: 14_400_000 })).toEqual({
      sandboxTimeoutMs: 14_400_000,
    });
  });

  it("requires sandboxTimeoutMs to be a positive whole number of seconds", () => {
    expect(() => normalizeSandboxSettings({ sandboxTimeoutMs: 0 })).toThrow(
      SandboxSettingsValidationError
    );
    for (const sandboxTimeoutMs of [1, 999, 1500, 1000.5]) {
      expect(() => normalizeSandboxSettings({ sandboxTimeoutMs })).toThrow(
        SandboxSettingsValidationError
      );
    }
    expect(normalizeSandboxSettings({ sandboxTimeoutMs: 1000 })).toEqual({
      sandboxTimeoutMs: 1000,
    });
  });

  it("omits an invalid sandboxTimeoutMs while preserving valid fields", () => {
    expect(
      normalizeSandboxSettings({ sandboxTimeoutMs: -1, terminalEnabled: true }, { invalid: "omit" })
    ).toEqual({ terminalEnabled: true });
  });

  it("accepts valid service ports", () => {
    expect(
      normalizeSandboxSettings({ codeServerPort: 8081, vncPort: 6081, terminalPort: 7000 })
    ).toEqual({
      codeServerPort: 8081,
      vncPort: 6081,
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
    expect(() => normalizeSandboxSettings({ vncPort: 0 })).toThrow(SandboxSettingsValidationError);
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
    expect(() => normalizeSandboxSettings({ vncPort: 3000, tunnelPorts: [3000] })).toThrow(
      SandboxSettingsValidationError
    );
  });

  it("allows tunnels on default ports when the corresponding service is disabled", () => {
    const defaultPorts = [DEFAULT_CODE_SERVER_PORT, DEFAULT_VNC_PORT, DEFAULT_TERMINAL_PORT];
    expect(normalizeSandboxSettings({ tunnelPorts: defaultPorts })).toEqual({
      tunnelPorts: defaultPorts,
    });
  });

  it("frees the default port for a tunnel when code-server is moved", () => {
    const movedCodeServerPort = DEFAULT_CODE_SERVER_PORT + 1;
    expect(
      normalizeSandboxSettings({
        codeServerPort: movedCodeServerPort,
        tunnelPorts: [DEFAULT_CODE_SERVER_PORT],
      })
    ).toEqual({
      codeServerPort: movedCodeServerPort,
      tunnelPorts: [DEFAULT_CODE_SERVER_PORT],
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
    expect(normalizeSandboxSettings({ codeServerPort: 6080 }, { invalid: "omit" })).toEqual({
      codeServerPort: 6080,
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
