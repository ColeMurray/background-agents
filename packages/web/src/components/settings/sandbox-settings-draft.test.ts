import { describe, expect, it } from "vitest";
import {
  DEFAULT_CODE_SERVER_PORT,
  DEFAULT_MAX_CONCURRENT_CHILD_SESSIONS,
  DEFAULT_MAX_TOTAL_CHILD_SESSIONS,
  DEFAULT_TERMINAL_PORT,
  DEFAULT_VNC_PORT,
  INTERNAL_TTYD_PORT,
  INTERNAL_VNC_PORT,
  MAX_BUILD_TIMEOUT_SECONDS,
  type SandboxSettings,
} from "@open-inspect/shared/types/integrations";
import { resolveSandboxSettingsDraft, type SandboxSettingsDraft } from "./sandbox-settings-draft";

const baseDefaults: SandboxSettings = {
  tunnelPorts: [3000, 5173],
  terminalEnabled: true,
  codeServerPort: 8081,
  vncPort: 6081,
  terminalPort: 7682,
  buildTimeoutSeconds: 1200,
  sandboxTimeoutMs: 123_000,
  maxConcurrentChildSessions: 3,
  maxTotalChildSessions: 12,
  cpuCores: 0.5,
  memoryMib: 1024,
};

function resolve(draft: SandboxSettingsDraft = {}, ownSettings?: SandboxSettings) {
  return resolveSandboxSettingsDraft({ isGlobal: false, baseDefaults, ownSettings, draft });
}

describe("resolveSandboxSettingsDraft", () => {
  it("displays inherited values without pinning untouched fields", () => {
    expect(resolve()).toEqual({
      values: {
        tunnelPorts: ["3000", "5173"],
        terminalEnabled: true,
        maxSessionCostUsd: "",
        codeServerPort: "8081",
        vncPort: "6081",
        terminalPort: "7682",
        buildTimeoutSeconds: "1200",
        sandboxTimeoutMinutes: "2.05",
        maxConcurrentChildSessions: "3",
        maxTotalChildSessions: "12",
        cpuCores: "0.5",
        memoryMib: "1024",
      },
      hasChanges: false,
      result: { settings: {} },
    });
    expect(resolve({ terminalEnabled: false }).result).toEqual({
      settings: { terminalEnabled: false },
    });
  });

  it("preserves existing overrides, including false, empty arrays and resource nulls", () => {
    const ownSettings = {
      ...baseDefaults,
      tunnelPorts: [],
      terminalEnabled: false,
      cpuCores: null,
      memoryMib: null,
    };
    const resolved = resolve({}, ownSettings);
    expect(resolved.result).toEqual({ settings: ownSettings });
    expect(resolved.values).toMatchObject({
      tunnelPorts: [],
      terminalEnabled: false,
      cpuCores: "",
      memoryMib: "",
    });
    expect(resolved.hasChanges).toBe(false);
  });

  it("clears optional numbers to inheritance and resources to explicit null", () => {
    const draft = {
      codeServerPort: "",
      vncPort: " ",
      terminalPort: "",
      buildTimeoutSeconds: "",
      sandboxTimeoutMinutes: "",
      cpuCores: "",
      memoryMib: " ",
    };
    expect(resolve(draft).result).toEqual({ settings: { cpuCores: null, memoryMib: null } });
    expect(resolve(draft, baseDefaults).result).toEqual({
      settings: {
        tunnelPorts: [3000, 5173],
        terminalEnabled: true,
        maxConcurrentChildSessions: 3,
        maxTotalChildSessions: 12,
        cpuCores: null,
        memoryMib: null,
      },
    });
    expect(resolve(draft).hasChanges).toBe(true);
  });

  it("parses edited numbers and tunnel rows", () => {
    expect(
      resolve({
        tunnelPorts: [" 4000 ", "04000", "", "5000"],
        codeServerPort: " 9000 ",
        vncPort: "9001",
        terminalPort: "9002",
        buildTimeoutSeconds: " 60 ",
        sandboxTimeoutMinutes: " 2.05 ",
        maxConcurrentChildSessions: "02",
        maxTotalChildSessions: "10",
        maxSessionCostUsd: " 2.50 ",
        cpuCores: " .25 ",
        memoryMib: " 2048 ",
      }).result
    ).toEqual({
      settings: {
        tunnelPorts: [4000, 5000],
        codeServerPort: 9000,
        vncPort: 9001,
        terminalPort: 9002,
        buildTimeoutSeconds: 60,
        sandboxTimeoutMs: 123_000,
        maxConcurrentChildSessions: 2,
        maxTotalChildSessions: 10,
        maxSessionCostUsd: 2.5,
        cpuCores: 0.25,
        memoryMib: 2048,
      },
    });
  });

  it("saves global form defaults but leaves optional number placeholders unset", () => {
    const resolved = resolveSandboxSettingsDraft({ isGlobal: true, draft: {} });
    expect(resolved.result).toEqual({
      settings: {
        tunnelPorts: [],
        terminalEnabled: false,
        maxConcurrentChildSessions: DEFAULT_MAX_CONCURRENT_CHILD_SESSIONS,
        maxTotalChildSessions: DEFAULT_MAX_TOTAL_CHILD_SESSIONS,
      },
    });
    expect(resolved.values).toMatchObject({
      codeServerPort: "",
      vncPort: "",
      terminalPort: "",
      buildTimeoutSeconds: "",
      sandboxTimeoutMinutes: "",
      cpuCores: "",
      memoryMib: "",
    });
    expect(resolved.hasChanges).toBe(false);
    const expected = { ...baseDefaults };
    delete expected.cpuCores;
    delete expected.memoryMib;
    expect(
      resolveSandboxSettingsDraft({
        isGlobal: true,
        ownSettings: baseDefaults,
        draft: { cpuCores: "", memoryMib: "" },
      }).result
    ).toStrictEqual({ settings: expected });
  });

  it("keeps inherited resource nulls blank without persisting them", () => {
    const resolved = resolveSandboxSettingsDraft({
      isGlobal: false,
      baseDefaults: { cpuCores: null, memoryMib: null },
      draft: {},
    });
    expect(resolved.values).toMatchObject({ cpuCores: "", memoryMib: "" });
    expect(resolved.result).toStrictEqual({ settings: {} });
  });

  it("validates default ports after clearing global overrides", () => {
    expect(
      resolveSandboxSettingsDraft({
        isGlobal: true,
        ownSettings: { codeServerPort: 9000 },
        draft: { codeServerPort: "", tunnelPorts: [String(DEFAULT_CODE_SERVER_PORT)] },
      }).result
    ).toEqual({ error: "Code server, VNC, terminal, and tunnel ports must all be different." });
  });

  it("normalizes dirty whitespace and tunnel rows, and resets with an empty draft", () => {
    expect(
      resolve({
        cpuCores: " 0.5 ",
        memoryMib: "1024 ",
        codeServerPort: " 8081",
        vncPort: "6081 ",
        terminalPort: "7682 ",
        buildTimeoutSeconds: "1200 ",
        sandboxTimeoutMinutes: "2.05 ",
        tunnelPorts: ["03000", " 5173 ", "3000", ""],
      }).hasChanges
    ).toBe(false);
    expect(resolve({ tunnelPorts: ["5173", "3000"] }).hasChanges).toBe(true);
    expect(resolve({ cpuCores: "0.50" }).hasChanges).toBe(true);
    expect(resolve({ maxConcurrentChildSessions: "03" }).hasChanges).toBe(true);
    expect(resolve({ maxTotalChildSessions: "12 " }).hasChanges).toBe(true);
    expect(resolve({ terminalEnabled: false }).hasChanges).toBe(true);
    expect(resolve({}).hasChanges).toBe(false);
  });

  it("marks invalid edited tunnel rows dirty even when valid ports are unchanged", () => {
    const resolved = resolve({ tunnelPorts: ["3000", "5173", "bad"] });
    expect(resolved.hasChanges).toBe(true);
    expect(resolved.result).toEqual({ error: "Invalid port numbers: bad" });
  });

  it("marks an invalid-only tunnel edit dirty", () => {
    const resolved = resolveSandboxSettingsDraft({
      isGlobal: true,
      draft: { tunnelPorts: ["bad"] },
    });
    expect(resolved.hasChanges).toBe(true);
    expect(resolved.result).toEqual({ error: "Invalid port numbers: bad" });
  });

  it.each([
    { isGlobal: true, draft: { maxConcurrentChildSessions: "5", maxTotalChildSessions: "2" } },
    {
      isGlobal: false,
      baseDefaults: { maxConcurrentChildSessions: 5 },
      draft: { maxTotalChildSessions: "2" },
    },
    {
      isGlobal: false,
      ownSettings: { maxConcurrentChildSessions: 5 },
      draft: { maxTotalChildSessions: "2" },
    },
    {
      isGlobal: false,
      baseDefaults: { maxTotalChildSessions: 2 },
      draft: { maxConcurrentChildSessions: "5" },
    },
  ])("rejects conflicting effective child limits: %j", (input) => {
    expect(resolveSandboxSettingsDraft(input).result).toEqual({
      error: "maxConcurrentChildSessions must be less than or equal to maxTotalChildSessions",
    });
  });

  it("accepts equal effective child limits without pinning inheritance", () => {
    expect(
      resolveSandboxSettingsDraft({
        isGlobal: false,
        baseDefaults: { maxConcurrentChildSessions: 5 },
        draft: { maxTotalChildSessions: "5" },
      }).result
    ).toEqual({ settings: { maxTotalChildSessions: 5 } });
  });

  it.each<[SandboxSettingsDraft, string]>([
    [{ tunnelPorts: ["0", "65536", " 1.5 "] }, "Invalid port numbers: 0, 65536,  1.5 "],
    [{ maxConcurrentChildSessions: "" }, "Child session limits must be positive whole numbers."],
    [{ maxTotalChildSessions: " 2 " }, "Child session limits must be positive whole numbers."],
    [{ maxTotalChildSessions: "1.5" }, "Child session limits must be positive whole numbers."],
    [{ cpuCores: "0" }, "CPU cores must be a positive number."],
    [{ cpuCores: "1e2" }, "CPU cores must be a positive number."],
    [{ memoryMib: "1.5" }, "Memory must be a positive whole number of MiB."],
    [{ codeServerPort: "65536" }, "Code server port must be a whole number between 1 and 65535."],
    [{ vncPort: "0" }, "VNC port must be a whole number between 1 and 65535."],
    [{ terminalPort: "abc" }, "Terminal port must be a whole number between 1 and 65535."],
    [
      { buildTimeoutSeconds: String(MAX_BUILD_TIMEOUT_SECONDS + 1) },
      `Build timeout must be a whole number of seconds, at most ${MAX_BUILD_TIMEOUT_SECONDS}.`,
    ],
  ])("validates %j", (draft, error) => {
    expect(resolve(draft).result).toEqual({ error });
  });

  it.each(["0", "-1", "0.001", "2.051", "1e2", "99999999999999999999"])(
    "rejects invalid timeout %s",
    (sandboxTimeoutMinutes) => {
      expect(resolve({ sandboxTimeoutMinutes }).result).toEqual({
        error: "Session timeout must be at least one second, in one-second increments.",
      });
    }
  );

  it.each([1000, 31_000, 123_000, 246_000])(
    "round-trips a %i ms timeout through the existing helper",
    (sandboxTimeoutMs) => {
      const ownSettings = { sandboxTimeoutMs };
      const { values } = resolve({}, ownSettings);
      expect(resolve({ sandboxTimeoutMinutes: values.sandboxTimeoutMinutes }).result).toEqual({
        settings: ownSettings,
      });
      expect(resolve({}, ownSettings).result).toEqual({ settings: ownSettings });
    }
  );

  it.each([DEFAULT_CODE_SERVER_PORT, DEFAULT_VNC_PORT, DEFAULT_TERMINAL_PORT])(
    "validates default service port %i even with terminal disabled",
    (port) => {
      expect(
        resolveSandboxSettingsDraft({
          isGlobal: true,
          draft: { tunnelPorts: [String(port)], terminalEnabled: false },
        }).result
      ).toEqual({ error: "Code server, VNC, terminal, and tunnel ports must all be different." });
    }
  );

  it.each(["codeServerPort", "vncPort", "terminalPort"] as const)(
    "validates inherited and cleared %s",
    (key) => {
      const port = String(baseDefaults[key]);
      const error = "Code server, VNC, terminal, and tunnel ports must all be different.";
      expect(resolve({ tunnelPorts: [port] }).result).toEqual({ error });
      expect(resolve({ tunnelPorts: [port], [key]: "" }, { [key]: 9000 }).result).toEqual({
        error,
      });
      expect(resolve({ tunnelPorts: [port], [key]: "9000" }).result.error).toBeUndefined();
    }
  );

  it("validates inherited tunnels and service-to-service conflicts", () => {
    expect(resolve({ codeServerPort: "3000" }).result.error).toBe(
      "Code server, VNC, terminal, and tunnel ports must all be different."
    );
    expect(resolve({ codeServerPort: "6081" }).result.error).toBe(
      "Code server, VNC, terminal, and tunnel ports must all be different."
    );
  });

  it.each([INTERNAL_TTYD_PORT, INTERNAL_VNC_PORT])(
    "rejects reserved port %i in tunnels and services",
    (port) => {
      for (const draft of [{ tunnelPorts: [String(port)] }, { vncPort: String(port) }]) {
        expect(resolve(draft).result).toEqual({
          error: `Port ${port} is reserved for an internal sandbox service and cannot be used.`,
        });
      }
    }
  );
});
