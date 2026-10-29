import { describe, expect, expectTypeOf, it } from "vitest";
import type { SandboxProviderName } from "@open-inspect/shared/types/integrations";
import {
  INHERIT_SANDBOX_SETTING,
  resolveSandboxSettingsDraft,
  type SandboxSettingsDraft,
} from "./sandbox-settings-draft";

describe("sandbox resource limit drafts", () => {
  it.each([
    { provider: "modal-vm", draft: { cpuLimitCores: "0.25" } },
    { provider: "modal-vm", draft: { memoryLimitMib: "1024" } },
    { provider: "modal", draft: { cpuLimitCores: "0.0625" } },
    { provider: "modal", draft: { memoryLimitMib: "64" } },
  ] as const)(
    "validates cap-only drafts against $provider request defaults",
    ({ provider, draft }) => {
      expect(
        resolveSandboxSettingsDraft({ isGlobal: true, provider, draft }).result.error
      ).toBeDefined();
      expect(
        resolveSandboxSettingsDraft({
          isGlobal: false,
          provider,
          draft,
          baseDefaults: { cpuCores: 4, memoryMib: 8192 },
          ownSettings: { cpuCores: null, memoryMib: null },
        }).result.error
      ).toBeDefined();
    }
  );

  it("uses VM defaults when request drafts are cleared to null, not inherited requests", () => {
    const resolved = resolveSandboxSettingsDraft({
      isGlobal: false,
      provider: "modal-vm",
      baseDefaults: { cpuCores: 0.125, memoryMib: 128, cpuLimitCores: 0.25, memoryLimitMib: 1024 },
      draft: { cpuCores: "", memoryMib: "" },
    });
    expect(resolved.result.error).toContain("cpuLimitCores");
  });

  it("accepts VM null requests with matching default caps without pinning inherited requests", () => {
    const resolved = resolveSandboxSettingsDraft({
      isGlobal: false,
      provider: "modal-vm",
      baseDefaults: { cpuCores: 4, memoryMib: 8192 },
      ownSettings: { cpuCores: null, memoryMib: null },
      draft: { cpuLimitCores: "0.5", memoryLimitMib: "2048" },
    });
    expect(resolved.result).toEqual({
      settings: {
        cpuCores: null,
        memoryMib: null,
        cpuLimitCores: 0.5,
        memoryLimitMib: 2048,
      },
    });
  });

  it("preserves unsupported caps while editing Vercel requests", () => {
    const resolved = resolveSandboxSettingsDraft({
      isGlobal: false,
      provider: "vercel",
      ownSettings: { cpuCores: 4, cpuLimitCores: 2, memoryMib: 8192, memoryLimitMib: 4096 },
      draft: { cpuCores: "8" },
    });
    expect(resolved.result).toEqual({
      settings: {
        cpuCores: 8,
        cpuLimitCores: 2,
        memoryMib: 8192,
        memoryLimitMib: 4096,
      },
    });
  });
  it("displays inherited caps without pinning them on an unrelated scoped edit", () => {
    const resolved = resolveSandboxSettingsDraft({
      isGlobal: false,
      provider: "modal",
      baseDefaults: { cpuLimitCores: 2, memoryLimitMib: 4096 },
      draft: { cpuCores: "0.5" },
    });
    expect(resolved.values.cpuLimitCores).toBe("2");
    expect(resolved.values.memoryLimitMib).toBe("4096");
    expect(resolved.result).toEqual({ settings: { cpuCores: 0.5 } });
  });

  it("clears scoped caps with explicit nulls and keeps existing null resets blank", () => {
    const resolved = resolveSandboxSettingsDraft({
      isGlobal: false,
      provider: "modal",
      baseDefaults: { cpuLimitCores: 2, memoryLimitMib: 4096 },
      ownSettings: { cpuLimitCores: null },
      draft: { memoryLimitMib: "" },
    });
    expect(resolved.values.cpuLimitCores).toBe("");
    expect(resolved.hasChanges).toBe(true);
    expect(resolved.result).toEqual({ settings: { cpuLimitCores: null, memoryLimitMib: null } });
  });

  it("omits cleared global caps instead of storing null overrides", () => {
    const resolved = resolveSandboxSettingsDraft({
      isGlobal: true,
      provider: "modal",
      ownSettings: { cpuLimitCores: 2, memoryLimitMib: 4096 },
      draft: { cpuLimitCores: "", memoryLimitMib: "" },
    });
    expect(resolved.result.settings).not.toHaveProperty("cpuLimitCores");
    expect(resolved.result.settings).not.toHaveProperty("memoryLimitMib");
  });

  it.each([
    { cpuLimitCores: "0" },
    { cpuLimitCores: "Infinity" },
    { memoryLimitMib: "2048.5" },
    { memoryLimitMib: "9".repeat(400) },
  ])("rejects invalid caps %j", (draft) => {
    expect(
      resolveSandboxSettingsDraft({ isGlobal: true, provider: "modal", draft }).result.error
    ).toBeDefined();
  });

  it.each([
    { baseDefaults: { cpuCores: 4 }, draft: { cpuLimitCores: "2" } },
    { baseDefaults: { memoryLimitMib: 4096 }, draft: { memoryMib: "8192" } },
  ])("validates caps against the effective inherited request and vice versa", (settings) => {
    expect(
      resolveSandboxSettingsDraft({ isGlobal: false, provider: "modal", ...settings }).result.error
    ).toBeDefined();
  });

  it("requires a known provider in the resolution contract", () => {
    type Options = Parameters<typeof resolveSandboxSettingsDraft>[0];
    expectTypeOf<Options["provider"]>().toEqualTypeOf<SandboxProviderName>();
    expectTypeOf<{ isGlobal: false; draft: SandboxSettingsDraft }>().not.toExtend<Options>();
    expectTypeOf<{
      isGlobal: false;
      draft: SandboxSettingsDraft;
      provider: "unknown";
    }>().not.toExtend<Options>();
  });

  it("preserves hidden stored caps without validating them or applying hidden edits", () => {
    const draft = { cpuLimitCores: "bad", memoryLimitMib: "0", cpuCores: "8" };
    const resolved = resolveSandboxSettingsDraft({
      isGlobal: false,
      ownSettings: { cpuLimitCores: -1, memoryLimitMib: null },
      baseDefaults: { cpuCores: 4 },
      draft,
      provider: "vercel",
    });
    expect(resolved.result).toEqual({
      settings: { cpuCores: 8, cpuLimitCores: -1, memoryLimitMib: null },
    });
    expect(resolved.values.cpuLimitCores).toBe("bad");
    const visibleAgain = resolveSandboxSettingsDraft({
      isGlobal: false,
      provider: "modal",
      draft,
    });
    expect(visibleAgain.result.error).toBeDefined();
  });

  it.each([true, false])("preserves unsupported Daytona fields at global=%s", (isGlobal) => {
    const ownSettings = {
      cpuCores: -1,
      memoryMib: null,
      cpuLimitCores: -2,
      memoryLimitMib: null,
      sandboxTimeoutMs: 1,
    };
    const resolved = resolveSandboxSettingsDraft({
      isGlobal,
      provider: "daytona",
      ownSettings,
      draft: {
        cpuCores: "bad",
        memoryMib: "0",
        cpuLimitCores: INHERIT_SANDBOX_SETTING,
        memoryLimitMib: "bad",
        sandboxTimeoutMinutes: "bad",
        terminalEnabled: true,
      },
    });
    expect(resolved.result.error).toBeUndefined();
    expect(resolved.result.settings).toMatchObject({ ...ownSettings, terminalEnabled: true });
    expect(resolved.hasChanges).toBe(true);
    expect(
      resolveSandboxSettingsDraft({
        isGlobal,
        provider: "daytona",
        draft: { cpuCores: "bad", cpuLimitCores: "bad", sandboxTimeoutMinutes: "bad" },
      })
    ).toMatchObject({ hasChanges: false });
  });

  it.each([
    { cpuLimitCores: 8, memoryLimitMib: 16384 },
    { cpuLimitCores: null, memoryLimitMib: null },
    { cpuLimitCores: 2, memoryLimitMib: 4096 },
  ])("removes numeric or null cap overrides with inherit: %j", (ownSettings) => {
    const baseDefaults = { cpuLimitCores: 2, memoryLimitMib: 4096 };
    const resolved = resolveSandboxSettingsDraft({
      isGlobal: false,
      provider: "modal-vm",
      ownSettings: { ...ownSettings, terminalEnabled: true },
      baseDefaults,
      draft: {
        cpuLimitCores: INHERIT_SANDBOX_SETTING,
        memoryLimitMib: INHERIT_SANDBOX_SETTING,
      },
    });
    expect(resolved.hasChanges).toBe(true);
    expect(resolved.values).toMatchObject({ cpuLimitCores: "2", memoryLimitMib: "4096" });
    expect(resolved.result).toEqual({ settings: { terminalEnabled: true } });

    const afterParentChange = resolveSandboxSettingsDraft({
      isGlobal: false,
      provider: "modal-vm",
      ownSettings: resolved.result.settings,
      baseDefaults: { cpuLimitCores: 4, memoryLimitMib: 8192 },
      draft: {},
    });
    expect(afterParentChange.values).toMatchObject({ cpuLimitCores: "4", memoryLimitMib: "8192" });
    expect(afterParentChange.result).toEqual({ settings: { terminalEnabled: true } });
    expect(afterParentChange.hasChanges).toBe(false);
  });

  it("validates inherited caps against retained request overrides", () => {
    const resolved = resolveSandboxSettingsDraft({
      isGlobal: false,
      provider: "modal",
      ownSettings: { cpuCores: 4, cpuLimitCores: 8 },
      baseDefaults: { cpuLimitCores: 2 },
      draft: { cpuLimitCores: INHERIT_SANDBOX_SETTING },
    });
    expect(resolved.result.error).toContain("cpuLimitCores");
  });

  it("inherits absent or null parent caps without creating overrides", () => {
    const resolved = resolveSandboxSettingsDraft({
      isGlobal: false,
      provider: "modal-vm",
      ownSettings: { cpuLimitCores: 8, memoryLimitMib: 16384 },
      baseDefaults: { memoryLimitMib: null },
      draft: {
        cpuLimitCores: INHERIT_SANDBOX_SETTING,
        memoryLimitMib: INHERIT_SANDBOX_SETTING,
      },
    });
    expect(resolved.values).toMatchObject({ cpuLimitCores: "", memoryLimitMib: "" });
    expect(resolved.result).toEqual({ settings: {} });
  });

  it("distinguishes unedited, provider-default, and inherit intent with identical blank displays", () => {
    const options = {
      isGlobal: false,
      provider: "modal-vm" as const,
      ownSettings: { cpuLimitCores: null, memoryLimitMib: null },
    };
    const unedited = resolveSandboxSettingsDraft({ ...options, draft: {} });
    const inherit = resolveSandboxSettingsDraft({
      ...options,
      draft: {
        cpuLimitCores: INHERIT_SANDBOX_SETTING,
        memoryLimitMib: INHERIT_SANDBOX_SETTING,
      },
    });
    const providerDefault = resolveSandboxSettingsDraft({
      ...options,
      ownSettings: {},
      draft: { cpuLimitCores: "", memoryLimitMib: "" },
    });
    expect(unedited.result).toEqual({ settings: options.ownSettings });
    expect(unedited.hasChanges).toBe(false);
    expect(inherit.result).toEqual({ settings: {} });
    expect(inherit.hasChanges).toBe(true);
    expect(providerDefault.result).toEqual({ settings: options.ownSettings });
    expect(providerDefault.hasChanges).toBe(true);
    expect(inherit.values).toEqual(unedited.values);
    expect(providerDefault.values).toEqual(unedited.values);
  });
});
