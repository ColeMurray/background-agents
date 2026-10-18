import { describe, expect, it } from "vitest";
import {
  PI_TOOL_EFFECT_REGISTRY,
  TOOL_CALLERS,
  TOOL_EFFECT_KINDS,
  TOOL_REPLAY_POLICIES,
  createToolEffectRegistry,
} from "./pi-tool-effects";

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
  });

  it("rejects duplicate tool names across feature extension registrations", () => {
    expect(() =>
      createToolEffectRegistry(
        [{ name: "publish", effect: "external_mutation", callers: ["model"], replay: "unsafe" }],
        [{ name: "publish", effect: "control", callers: ["tools"], replay: "safe" }]
      )
    ).toThrow('Duplicate Pi tool effect registration: "publish"');
  });
});
