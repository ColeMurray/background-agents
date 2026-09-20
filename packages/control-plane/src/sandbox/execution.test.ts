import { describe, expect, it } from "vitest";
import { resolveSandboxExecution, resolveSandboxLaunchSpec } from "./execution";
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

describe("resolveSandboxLaunchSpec", () => {
  it("uses empty effective settings for a disallowed standard launch", () => {
    expect(
      resolveSandboxLaunchSpec(
        {},
        {
          settings: { dockerEnabled: false, sandboxTimeoutMs: 3_600_000 },
          scopeAllowed: false,
          repository: "acme/web",
        }
      )
    ).toEqual({ settings: {}, execution: { profile: "default" } });
  });

  it("keeps global defaults for a repo-less standard launch but still denies Docker", () => {
    const snapshot = {
      settings: { dockerEnabled: false, tunnelPorts: [3000] },
      scopeAllowed: false,
      repository: null,
    };
    expect(resolveSandboxLaunchSpec({}, snapshot)).toEqual({
      settings: { tunnelPorts: [3000] },
      execution: { profile: "default" },
    });
    expect(() => resolveSandboxLaunchSpec(enabled, snapshot, { dockerEnabled: true })).toThrow(
      "not allowed"
    );
  });

  it("normalizes Docker resources and removes boolean intent", () => {
    expect(
      resolveSandboxLaunchSpec(enabled, {
        settings: { dockerEnabled: true, cpuCores: 3, memoryMib: 8192 },
        scopeAllowed: true,
        repository: "acme/web",
      })
    ).toEqual({
      settings: { cpuCores: 3, memoryMib: 8192 },
      execution: {
        profile: "docker-v1",
        provider: "modal",
        cpuCores: 3,
        memoryMib: 8192,
      },
    });
  });

  it("preserves frozen child Docker resources and replaces timeout with the parent's value", () => {
    const execution = {
      profile: "docker-v1" as const,
      provider: "modal" as const,
      cpuCores: 4,
      memoryMib: 6144,
    };
    expect(
      resolveSandboxLaunchSpec(
        enabled,
        {
          settings: { cpuCores: 1, memoryMib: 2048, sandboxTimeoutMs: 3_600_000 },
          scopeAllowed: true,
          repository: "acme/web",
        },
        { inherited: { execution } }
      )
    ).toEqual({ settings: { cpuCores: 4, memoryMib: 6144 }, execution });
  });

  it("keeps a frozen default child profile even when current settings request Docker", () => {
    expect(
      resolveSandboxLaunchSpec(
        enabled,
        {
          settings: { dockerEnabled: true, sandboxTimeoutMs: 3_600_000 },
          scopeAllowed: true,
          repository: "acme/web",
        },
        { inherited: { execution: { profile: "default" }, sandboxTimeoutMs: 7_200_000 } }
      )
    ).toEqual({
      settings: { sandboxTimeoutMs: 7_200_000 },
      execution: { profile: "default" },
    });
  });

  it("does not reintroduce an inherited timeout unsupported by the provider", () => {
    expect(
      resolveSandboxLaunchSpec(
        { SANDBOX_PROVIDER: "daytona" },
        {
          settings: { sandboxTimeoutMs: 3_600_000, buildTimeoutSeconds: 600 },
          scopeAllowed: true,
          repository: "acme/web",
        },
        { inherited: { execution: { profile: "default" }, sandboxTimeoutMs: 7_200_000 } }
      )
    ).toEqual({
      settings: { buildTimeoutSeconds: 600 },
      execution: { profile: "default" },
    });
  });

  it("renormalizes dependent settings after replacing the child timeout", () => {
    expect(
      resolveSandboxLaunchSpec(
        {},
        {
          settings: { sandboxTimeoutMs: 28_800_000, finalSnapshotBufferMs: 7_200_000 },
          scopeAllowed: true,
          repository: "acme/web",
        },
        { inherited: { execution: { profile: "default" }, sandboxTimeoutMs: 3_600_000 } }
      ).settings
    ).toEqual({ sandboxTimeoutMs: 3_600_000 });
  });
});
