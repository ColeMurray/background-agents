import {
  PI_CODEMODE_TOOL_EFFECT_REGISTRATIONS,
  resolvePiFeatureCapabilities,
  type ToolCaller,
  type ToolEffectRegistration,
  type ToolReplayPolicy,
} from "@open-inspect/shared";
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import {
  EXTENSION_SLOTS,
  assembleExtensions,
  type ExtensionContribution,
} from "../harness/extension-assembler";
import { createToolPolicyExtension } from "../pi/tool-policy-extension";

const capabilities = resolvePiFeatureCapabilities({
  scratchWorkspace: "enabled",
  repositoryEditing: "enabled",
  codeMode: "enabled",
  sandboxExecution: "enabled",
  mcp: "enabled",
});

function tool(
  name: string,
  options: { callers?: readonly ToolCaller[]; replay?: ToolReplayPolicy } = {}
) {
  return defineTool({
    name,
    description: name,
    parameters: Type.Object({}),
    ...options,
    execute: async () => ({ output: [{ type: "text" as const, text: "ok" }] }),
  });
}

function effect(
  name: string,
  options: Partial<Omit<ToolEffectRegistration, "name">> = {}
): ToolEffectRegistration {
  return {
    name,
    effect: "local_read",
    callers: ["model", "tools"],
    replay: "safe",
    ...options,
  };
}

function contribution(slot: ExtensionContribution["slot"], name: string): ExtensionContribution {
  return { slot, extension: defineExtension({ name }), effects: [] };
}

function policy(capture?: (effects: ReadonlyMap<string, ToolEffectRegistration>) => void) {
  return {
    slot: "policy",
    effects: [],
    createExtension: (effects: ReadonlyMap<string, ToolEffectRegistration>) => {
      capture?.(effects);
      return createToolPolicyExtension({ effects });
    },
  } as const satisfies ExtensionContribution;
}

describe("assembleExtensions", () => {
  it("uses one deterministic order and gives policy the exact global registry", () => {
    let policyEffects: ReadonlyMap<string, ToolEffectRegistration> | undefined;
    const assembled = assembleExtensions(
      [
        contribution("mcp", "mcp"),
        contribution("scratch_workspace", "scratchWorkspace"),
        contribution("repository_editing", "repository-editing"),
        contribution("core", "core"),
        policy((effects) => (policyEffects = effects)),
        contribution("delegation", "delegation"),
        contribution("sandbox_execution", "sandbox"),
        contribution("skills", "skills"),
        contribution("code_mode", "code-mode"),
      ],
      capabilities
    );

    expect(EXTENSION_SLOTS).toEqual([
      "policy",
      "core",
      "delegation",
      "agent_messaging",
      "skills",
      "scratch_workspace",
      "repository_editing",
      "code_mode",
      "sandbox_execution",
      "mcp",
      "browser",
      "memory",
    ]);
    expect(assembled.extensions.map(({ name }) => name)).toEqual([
      "open-inspect.tool-policy",
      "core",
      "delegation",
      "skills",
      "scratchWorkspace",
      "repository-editing",
      "code-mode",
      "sandbox",
      "mcp",
    ]);
    expect(policyEffects).toBe(assembled.effects);
  });

  it("rejects two feature branches claiming the same slot", () => {
    expect(() =>
      assembleExtensions(
        [contribution("mcp", "mcp-static"), contribution("mcp", "mcp-oauth")],
        capabilities
      )
    ).toThrow('Duplicate extension slot: "mcp"');
  });

  it("rejects duplicate extension names across different slots", () => {
    expect(() =>
      assembleExtensions(
        [contribution("core", "open-inspect"), contribution("policy", "open-inspect")],
        capabilities
      )
    ).toThrow('Duplicate extension name: "open-inspect"');
  });

  it("rejects duplicate tool names across slots before exposure", () => {
    expect(() =>
      assembleExtensions(
        [
          {
            slot: "core",
            extension: defineExtension({ name: "core", tools: [tool("duplicate")] }),
            effects: [effect("duplicate")],
          },
          {
            slot: "mcp",
            extension: defineExtension({ name: "mcp", tools: [tool("duplicate")] }),
            effects: [],
          },
        ],
        capabilities
      )
    ).toThrow('Duplicate tool name: "duplicate"');
  });

  it("rejects undeclared tools and declarations without tools", () => {
    expect(() =>
      assembleExtensions(
        [
          {
            slot: "core",
            extension: defineExtension({ name: "core", tools: [tool("undeclared")] }),
            effects: [],
          },
        ],
        capabilities
      )
    ).toThrow('Tool has no effect declaration: "undeclared"');

    expect(() =>
      assembleExtensions(
        [
          {
            slot: "core",
            extension: defineExtension({ name: "core" }),
            effects: [effect("missing")],
          },
        ],
        capabilities
      )
    ).toThrow('Tool effect declaration has no tool: "missing"');
  });

  it("rejects caller and replay declarations that differ from the actual tool", () => {
    expect(() =>
      assembleExtensions(
        [
          {
            slot: "core",
            extension: defineExtension({
              name: "core",
              tools: [tool("wrong_callers", { callers: ["model"] })],
            }),
            effects: [effect("wrong_callers", { callers: ["tools"] })],
          },
        ],
        capabilities
      )
    ).toThrow('Tool callers do not match declaration: "wrong_callers"');

    expect(() =>
      assembleExtensions(
        [
          {
            slot: "core",
            extension: defineExtension({
              name: "core",
              tools: [tool("wrong_replay", { replay: "unsafe" })],
            }),
            effects: [effect("wrong_replay", { replay: "safe" })],
          },
        ],
        capabilities
      )
    ).toThrow('Tool replay does not match declaration: "wrong_replay"');
  });

  it("accepts discovered stable MCP tools only when declared before exposure", () => {
    const assembled = assembleExtensions(
      [
        policy(),
        {
          slot: "mcp",
          feature: "mcp",
          minimumCapability: "read_only",
          extension: defineExtension({
            name: "mcp",
            tools: [tool("mcp.linear.search", { callers: ["tools"], replay: "safe" })],
          }),
          effects: [effect("mcp.linear.search", { effect: "external_read", callers: ["tools"] })],
        },
      ],
      { ...capabilities, mcp: "read_only" }
    );

    expect(assembled.effects.get("mcp.linear.search")?.effect).toBe("external_read");
    expect(assembled.extensions.map(({ name }) => name)).toEqual([
      "open-inspect.tool-policy",
      "mcp",
    ]);
  });

  it("drops off contributions before they add tools or declarations", () => {
    const assembled = assembleExtensions(
      [
        contribution("core", "core"),
        {
          slot: "mcp",
          feature: "mcp",
          minimumCapability: "read_only",
          createExtension: () => {
            throw new Error("off contribution must not be constructed");
          },
          effects: [effect("mcp.hidden", { effect: "external_read" })],
        },
      ],
      { ...capabilities, mcp: "off" }
    );

    expect(assembled.extensions.map(({ name }) => name)).toEqual(["core"]);
    expect(assembled.effects.has("mcp.hidden")).toBe(false);
  });

  it("requires a policy contribution whenever active tools can mutate or execute", () => {
    expect(() =>
      assembleExtensions(
        [
          {
            slot: "browser",
            extension: defineExtension({
              name: "browser-extension",
              tools: [tool("publish", { replay: "safe" })],
            }),
            effects: [effect("publish", { effect: "external_mutation" })],
          },
        ],
        capabilities
      )
    ).toThrow("Mutating tool contributions require the policy extension");
  });

  it("requires the one composite policy slot before read-only tools too", () => {
    expect(() =>
      assembleExtensions(
        [
          {
            slot: "mcp",
            extension: defineExtension({
              name: "mcp",
              tools: [tool("mcp.read", { replay: "safe" })],
            }),
            effects: [effect("mcp.read", { effect: "external_read" })],
          },
        ],
        capabilities
      )
    ).toThrow("Tool contributions require the composite policy extension");
  });

  it("accepts Code Mode with only the codemode tool", () => {
    const assembled = assembleExtensions(
      [
        policy(),
        {
          slot: "code_mode",
          feature: "codeMode",
          minimumCapability: "enabled",
          extension: defineExtension({
            name: "codemode",
            tools: [tool("codemode", { callers: ["model"], replay: "safe" })],
          }),
          effects: PI_CODEMODE_TOOL_EFFECT_REGISTRATIONS,
        },
      ],
      capabilities
    );

    // The model-call tools are not part of Pi's surface: a script has no
    // model catalog and no way to send model-written context to the provider
    // with the session's credential.
    expect([...assembled.effects]).toHaveLength(1);
  });

  it("refuses an external mutation that no delegate owns", () => {
    expect(() =>
      assembleExtensions(
        [
          policy(),
          {
            slot: "browser",
            extension: defineExtension({
              name: "browser-extension",
              tools: [tool("publish_comment", { replay: "safe" })],
            }),
            effects: [effect("publish_comment", { effect: "external_mutation" })],
          },
        ],
        capabilities
      )
    ).toThrow('Tool effect declaration has no owning policy delegate: "publish_comment"');
  });

  it("accepts an external mutation whose delegate names it", () => {
    const assembled = assembleExtensions(
      [
        policy(),
        {
          slot: "browser",
          extension: defineExtension({
            name: "browser-extension",
            tools: [tool("publish_comment", { replay: "safe" })],
          }),
          effects: [effect("publish_comment", { effect: "external_mutation" })],
          ownedToolNames: ["publish_comment"],
        },
      ],
      capabilities
    );

    expect([...assembled.effects.keys()]).toEqual(["publish_comment"]);
  });

  it("does not require an owner for the effects the policy extension owns itself", () => {
    const assembled = assembleExtensions(
      [
        policy(),
        {
          slot: "scratch_workspace",
          feature: "scratchWorkspace",
          minimumCapability: "enabled",
          extension: defineExtension({
            name: "scratch",
            tools: [tool("write", { replay: "safe" })],
          }),
          effects: [effect("write", { effect: "local_mutation" })],
        },
      ],
      capabilities
    );

    expect([...assembled.effects.keys()]).toEqual(["write"]);
  });
});
