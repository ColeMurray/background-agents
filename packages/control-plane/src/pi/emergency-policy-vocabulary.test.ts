import type { HookApi, ToolHookCall } from "@earendil-works/pi-durable";
import { describe, expect, it, vi } from "vitest";
import { resolvePiFeatureCapabilities } from "@open-inspect/shared/pi-runtime-feature-capabilities";
import type { ToolEffectRegistration } from "@open-inspect/shared/tool-effects";
import { createDeploymentEmergencyPolicy } from "../harness/emergency-policy";
import { piEmergencyRequirement } from "./emergency-policy-vocabulary";

const context = { abortSignal: undefined, value: () => undefined, toString: () => "test" };

function call(name: string, path?: string): ToolHookCall {
  return {
    type: "toolCall",
    id: `call:${name}`,
    name,
    arguments: path === undefined ? {} : { path },
  };
}

function declaration(
  name: string,
  effect: ToolEffectRegistration["effect"]
): ToolEffectRegistration {
  return {
    name,
    effect,
    callers: ["model"],
    replay: effect === "local_mutation" ? "unsafe" : "safe",
  };
}

const api = { memo: vi.fn() } as unknown as HookApi;

describe("the Pi harness emergency vocabulary", () => {
  it("denies new scratch and repository mutations independently", async () => {
    const current = vi.fn(async () => resolvePiFeatureCapabilities({}));
    const policy = createDeploymentEmergencyPolicy({
      currentCapabilities: current,
      requirementFor: piEmergencyRequirement,
    });
    await expect(
      policy.beforeFeatureDelegates(
        call("write", "/workspace/scratch/a.txt"),
        declaration("write", "local_mutation"),
        api,
        context
      )
    ).resolves.toEqual({ block: "Scratch workspace mutations are disabled by deployment policy" });
    await expect(
      policy.beforeFeatureDelegates(
        call("write", "/workspace/repos/0/a.txt"),
        declaration("write", "local_mutation"),
        api,
        context
      )
    ).resolves.toEqual({ block: "Repository mutations are disabled by deployment policy" });
  });

  it("leaves reads operable without consulting deployment policy", async () => {
    const current = vi.fn(async () => resolvePiFeatureCapabilities({}));
    const policy = createDeploymentEmergencyPolicy({
      currentCapabilities: current,
      requirementFor: piEmergencyRequirement,
    });

    await expect(
      policy.beforeFeatureDelegates(
        call("read", "/workspace/scratch/a.txt"),
        declaration("read", "local_read"),
        api,
        context
      )
    ).resolves.toBeUndefined();
    expect(current).not.toHaveBeenCalled();
  });

  it("always consults current policy for a Code Mode call that reaches beforeTool", async () => {
    const current = vi.fn(async () => resolvePiFeatureCapabilities({ codeMode: "off" }));
    const policy = createDeploymentEmergencyPolicy({
      currentCapabilities: current,
      requirementFor: piEmergencyRequirement,
    });

    await expect(
      policy.beforeFeatureDelegates(
        call("codemode"),
        declaration("codemode", "sandbox_execution"),
        api,
        context
      )
    ).resolves.toEqual({ block: "Code Mode is disabled for new calls by deployment policy" });
    expect(current).toHaveBeenCalledWith(undefined);
    expect(api.memo).not.toHaveBeenCalled();
  });

  it("passes the tool abort signal to the current-policy lookup", async () => {
    const abort = new AbortController();
    const current = vi.fn(async () => resolvePiFeatureCapabilities({ codeMode: "enabled" }));
    const policy = createDeploymentEmergencyPolicy({
      currentCapabilities: current,
      requirementFor: piEmergencyRequirement,
    });
    const abortContext = { ...context, abortSignal: abort.signal };

    await expect(
      policy.beforeFeatureDelegates(
        call("codemode"),
        declaration("codemode", "sandbox_execution"),
        api,
        abortContext
      )
    ).resolves.toBeUndefined();
    expect(current).toHaveBeenCalledWith(abort.signal);
  });

  it("dynamically denies new run, build, and test calls without affecting Code Mode", async () => {
    const current = vi.fn(async () =>
      resolvePiFeatureCapabilities({ codeMode: "enabled", sandboxExecution: "off" })
    );
    const policy = createDeploymentEmergencyPolicy({
      currentCapabilities: current,
      requirementFor: piEmergencyRequirement,
    });

    for (const name of ["run_shell", "run_build", "run_tests"]) {
      await expect(
        policy.beforeFeatureDelegates(
          call(name),
          declaration(name, "sandbox_execution"),
          api,
          context
        )
      ).resolves.toEqual({ block: "Sandbox execution is disabled by deployment policy" });
    }
    await expect(
      policy.beforeFeatureDelegates(
        call("codemode"),
        declaration("codemode", "sandbox_execution"),
        api,
        context
      )
    ).resolves.toBeUndefined();
  });
});
