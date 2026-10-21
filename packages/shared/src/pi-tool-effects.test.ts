import { describe, expect, it } from "vitest";
import { MEMORY_TOOL_NAMES, harnessMemoryToolName } from "./memory-tools";
import {
  PI_CODEMODE_TOOL_EFFECT_REGISTRATIONS,
  PI_MEMORY_TOOL_EFFECT_REGISTRATIONS,
  PI_SANDBOX_EXECUTION_TOOL_EFFECT_REGISTRATIONS,
  PI_TOOL_EFFECT_REGISTRY,
} from "./pi-tool-effects";
import {
  SANDBOX_EXECUTION_TOOL_EFFECT,
  TOOL_CALLERS,
  TOOL_EFFECT_KINDS,
  TOOL_REPLAY_POLICIES,
  createToolEffectRegistry,
} from "./tool-effects";

describe("Pi tool effect registry", () => {
  it("publishes the complete effect, caller, and replay vocabularies", () => {
    expect(TOOL_EFFECT_KINDS).toEqual([
      "local_read",
      "local_mutation",
      "external_read",
      "external_mutation",
      "sandbox_execution",
      "control",
    ]);
    expect(TOOL_CALLERS).toEqual(["model", "tools"]);
    expect(TOOL_REPLAY_POLICIES).toEqual(["safe", "unsafe"]);
    expect(SANDBOX_EXECUTION_TOOL_EFFECT).toBe("sandbox_execution");
  });

  it("classifies every existing stable Pi tool with explicit callers and replay metadata", () => {
    expect(PI_TOOL_EFFECT_REGISTRY.get("repository_read")).toEqual({
      name: "repository_read",
      effect: "external_read",
      callers: ["model", "tools"],
      replay: "safe",
    });
    expect(PI_TOOL_EFFECT_REGISTRY.get("subagent")).toEqual({
      name: "subagent",
      effect: "control",
      callers: ["model"],
      replay: "safe",
    });
    expect(PI_TOOL_EFFECT_REGISTRY.get("read")?.effect).toBe("local_read");
    expect(PI_TOOL_EFFECT_REGISTRY.get("activate_skill")).toMatchObject({
      effect: "control",
      callers: ["model", "tools"],
      replay: "safe",
    });
    expect(PI_TOOL_EFFECT_REGISTRY.get("read_skill_resource")?.effect).toBe("local_read");
  });

  it("rejects duplicate tool names across feature extension registrations", () => {
    expect(() =>
      createToolEffectRegistry(
        [{ name: "publish", effect: "external_mutation", callers: ["model"], replay: "unsafe" }],
        [{ name: "publish", effect: "control", callers: ["tools"], replay: "safe" }]
      )
    ).toThrow('Duplicate tool effect registration: "publish"');
  });

  it("declares Code Mode and no model surface at all", () => {
    // A script gets no model catalog and no model-call tools: sending
    // model-written context to the provider with the session's credential is
    // what a capability must never do. The tools are therefore not declared
    // here either.
    expect(PI_CODEMODE_TOOL_EFFECT_REGISTRATIONS).toEqual([
      {
        name: "codemode",
        effect: "sandbox_execution",
        callers: ["model"],
        replay: "safe",
      },
    ]);
  });

  it("classifies run, build, and test equally as model-only sandbox execution", () => {
    expect(PI_SANDBOX_EXECUTION_TOOL_EFFECT_REGISTRATIONS).toEqual(
      ["run_shell", "run_build", "run_tests"].map((name) => ({
        name,
        effect: "sandbox_execution",
        callers: ["model"],
        replay: "safe",
      }))
    );
  });

  it("declares the memory tools under the shared contract's canonical names", () => {
    const names = PI_MEMORY_TOOL_EFFECT_REGISTRATIONS.map((registration) => registration.name);
    expect([...names].sort()).toEqual([...MEMORY_TOOL_NAMES].sort());
    for (const name of MEMORY_TOOL_NAMES) {
      expect(harnessMemoryToolName("pi", name)).toBe(name);
    }
  });

  it("reads memory and writes it under the effect each one has", () => {
    const byName = new Map(
      PI_MEMORY_TOOL_EFFECT_REGISTRATIONS.map((registration) => [registration.name, registration])
    );
    expect(byName.get("memory_read")).toMatchObject({
      effect: "external_read",
      callers: ["model"],
      replay: "safe",
    });
    expect(byName.get("memory_search")).toMatchObject({ effect: "external_read" });
    // The write changes something outside the model, so it is owned by a policy
    // delegate, and an interrupted write must not run again.
    expect(byName.get("memory_write")).toMatchObject({
      effect: "external_mutation",
      replay: "unsafe",
    });
  });
});
