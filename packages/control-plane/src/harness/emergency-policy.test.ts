import type { HookApi, ToolHookCall } from "@earendil-works/pi-durable";
import { describe, expect, it, vi } from "vitest";
import type { FeatureCapabilityMode } from "@open-inspect/shared/capability-modes";
import type { ToolEffectRegistration } from "@open-inspect/shared/tool-effects";
import { createDeploymentEmergencyPolicy } from "./emergency-policy";

const context = { abortSignal: undefined, value: () => undefined, toString: () => "test" };

function call(name: string): ToolHookCall {
  return { type: "toolCall", id: `call:${name}`, name, arguments: {} };
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

/**
 * The mechanism, with a vocabulary of its own: the policy asks which feature
 * a call needs, and checks the deployment's current capability for it.
 */
describe("the deployment emergency policy", () => {
  it("denies a call whose feature the deployment has closed", async () => {
    const current = vi.fn(async (): Promise<Record<string, FeatureCapabilityMode>> => ({
      scratch: "off",
    }));
    const policy = createDeploymentEmergencyPolicy({
      currentCapabilities: current,
      requirementFor: (toolCall) =>
        toolCall.name === "write"
          ? { feature: "scratch", reason: "Scratch writes are closed" }
          : undefined,
    });

    await expect(
      policy.beforeFeatureDelegates(
        call("write"),
        declaration("write", "local_mutation"),
        api,
        context
      )
    ).resolves.toEqual({ block: "Scratch writes are closed" });
  });

  it("allows a call whose feature is still enabled", async () => {
    const current = vi.fn(async (): Promise<Record<string, FeatureCapabilityMode>> => ({
      scratch: "enabled",
    }));
    const policy = createDeploymentEmergencyPolicy({
      currentCapabilities: current,
      requirementFor: () => ({ feature: "scratch", reason: "Scratch writes are closed" }),
    });

    await expect(
      policy.beforeFeatureDelegates(
        call("write"),
        declaration("write", "local_mutation"),
        api,
        context
      )
    ).resolves.toBeUndefined();
  });

  it("leaves a call it does not govern alone, without consulting the deployment", async () => {
    const current = vi.fn(async (): Promise<Record<string, FeatureCapabilityMode>> => ({
      scratch: "off",
    }));
    const policy = createDeploymentEmergencyPolicy({
      currentCapabilities: current,
      requirementFor: () => undefined,
    });

    await expect(
      policy.beforeFeatureDelegates(call("read"), declaration("read", "local_read"), api, context)
    ).resolves.toBeUndefined();
    expect(current).not.toHaveBeenCalled();
  });

  it("passes the tool's abort signal to the current-policy lookup", async () => {
    const abort = new AbortController();
    const current = vi.fn(async (): Promise<Record<string, FeatureCapabilityMode>> => ({
      scratch: "enabled",
    }));
    const policy = createDeploymentEmergencyPolicy({
      currentCapabilities: current,
      requirementFor: () => ({ feature: "scratch", reason: "Scratch writes are closed" }),
    });

    await expect(
      policy.beforeFeatureDelegates(call("write"), declaration("write", "local_mutation"), api, {
        ...context,
        abortSignal: abort.signal,
      })
    ).resolves.toBeUndefined();
    expect(current).toHaveBeenCalledWith(abort.signal);
  });
});
