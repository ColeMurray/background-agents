import { describe, expect, it } from "vitest";
import { resolveSandboxExecution } from "./execution";
import { normalizeSandboxSettings } from "./settings";

const enabled = { ENABLE_MODAL_VM_SANDBOXES: "true", SANDBOX_PROVIDER: "modal" };

describe("resolveSandboxExecution", () => {
  it("leaves absent and explicitly disabled intent on the default path", () => {
    expect(resolveSandboxExecution({}, {}, true)).toEqual({ profile: "default" });
    expect(resolveSandboxExecution({}, { dockerEnabled: true }, false, false)).toEqual({
      profile: "default",
    });
  });

  it("resolves profile defaults and explicit overrides once", () => {
    expect(resolveSandboxExecution(enabled, { dockerEnabled: true }, true)).toEqual({
      profile: "docker-v1",
      provider: "modal",
      cpuCores: 2,
      memoryMib: 4096,
    });
    expect(resolveSandboxExecution(enabled, { cpuCores: 3, memoryMib: 8192 }, true, true)).toEqual({
      profile: "docker-v1",
      provider: "modal",
      cpuCores: 3,
      memoryMib: 8192,
    });
    expect(
      resolveSandboxExecution(enabled, { cpuCores: null, memoryMib: null }, true, true)
    ).toEqual({
      profile: "docker-v1",
      provider: "modal",
      cpuCores: 2,
      memoryMib: 4096,
    });
  });

  it("never downgrades unsupported, disabled, or disallowed intent", () => {
    expect(() => resolveSandboxExecution({}, {}, true, true)).toThrow("unavailable");
    expect(() =>
      resolveSandboxExecution({ ...enabled, SANDBOX_PROVIDER: "e2b" }, {}, true, true)
    ).toThrow("unavailable");
    expect(() => resolveSandboxExecution(enabled, {}, false, true)).toThrow("not allowed");
  });

  it("inherits a frozen child profile/resources but rechecks admission", () => {
    const parent = {
      profile: "docker-v1" as const,
      provider: "modal" as const,
      cpuCores: 4,
      memoryMib: 6144,
    };
    expect(
      resolveSandboxExecution(
        enabled,
        { dockerEnabled: false, cpuCores: 1 },
        true,
        undefined,
        parent
      )
    ).toEqual(parent);
    expect(
      resolveSandboxExecution(enabled, { dockerEnabled: true }, true, undefined, {
        profile: "default",
      })
    ).toEqual({ profile: "default" });
    expect(() => resolveSandboxExecution({}, {}, true, undefined, parent)).toThrow("unavailable");
  });

  it("does not erase invalid execution intent in omit-mode normalization", () => {
    for (const dockerEnabled of [null, "true", 1]) {
      expect(() => normalizeSandboxSettings({ dockerEnabled }, { invalid: "omit" })).toThrow();
    }
    expect(() =>
      normalizeSandboxSettings({ cpuCores: -1 }, { invalid: "omit", strictExecution: true })
    ).toThrow();
    expect(
      normalizeSandboxSettings(
        { terminalPort: -1, dockerEnabled: false },
        { invalid: "omit", strictExecution: true }
      )
    ).toEqual({ dockerEnabled: false });
  });
});
