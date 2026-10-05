import { describe, expect, it } from "vitest";
import { resolveSandboxSettingsDraft } from "./sandbox-settings-draft";

describe("sandbox resource limit drafts", () => {
  it.each([
    { provider: "modal-vm", draft: { cpuLimitCores: "0.25" } },
    { provider: "modal-vm", draft: { memoryLimitMib: "1024" } },
    { provider: "modal", draft: { cpuLimitCores: "0.0625" } },
    { provider: "modal", draft: { memoryLimitMib: "64" } },
  ])("validates cap-only drafts against $provider request defaults", ({ provider, draft }) => {
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
  });

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

  it("does not compare conflicting request/cap pairs for non-Modal saves", () => {
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
    expect(resolveSandboxSettingsDraft({ isGlobal: true, draft }).result.error).toBeDefined();
  });

  it.each([
    { baseDefaults: { cpuCores: 4 }, draft: { cpuLimitCores: "2" } },
    { baseDefaults: { memoryLimitMib: 4096 }, draft: { memoryMib: "8192" } },
  ])("validates caps against the effective inherited request and vice versa", (settings) => {
    expect(
      resolveSandboxSettingsDraft({ isGlobal: false, ...settings }).result.error
    ).toBeDefined();
  });

  it("compares explicit pairs only when no provider is given", () => {
    const resolved = resolveSandboxSettingsDraft({
      isGlobal: false,
      baseDefaults: { cpuCores: 4 },
      ownSettings: { cpuCores: null },
      draft: { cpuLimitCores: "0.25", memoryLimitMib: "64" },
    });
    expect(resolved.result).toEqual({
      settings: { cpuCores: null, cpuLimitCores: 0.25, memoryLimitMib: 64 },
    });
  });

  it("preserves hidden stored caps without validating them or applying hidden edits", () => {
    const draft = { cpuLimitCores: "bad", memoryLimitMib: "0", cpuCores: "8" };
    const resolved = resolveSandboxSettingsDraft({
      isGlobal: false,
      ownSettings: { cpuLimitCores: -1, memoryLimitMib: null },
      baseDefaults: { cpuCores: 4 },
      draft,
      hiddenFields: new Set(["cpuLimitCores", "memoryLimitMib"]),
      provider: "vercel",
    });
    expect(resolved.result).toEqual({
      settings: { cpuCores: 8, cpuLimitCores: -1, memoryLimitMib: null },
    });
    expect(resolved.values.cpuLimitCores).toBe("bad");
    const visibleAgain = resolveSandboxSettingsDraft({
      isGlobal: false,
      draft,
    });
    expect(visibleAgain.result.error).toBeDefined();
  });
});
