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
  PI_EXTENSION_SLOTS,
  assemblePiExtensions,
  type PiExtensionContribution,
} from "./extension-assembler";
import { createPiToolPolicyExtension } from "./tool-policy-extension";

const capabilities = resolvePiFeatureCapabilities({
  workspace: "enabled",
  repositoryEditing: "enabled",
  codeMode: "enabled",
  sandboxExecution: "enabled",
  externalActions: "enabled",
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

function contribution(
  slot: PiExtensionContribution["slot"],
  name: string
): PiExtensionContribution {
  return { slot, extension: defineExtension({ name }), effects: [] };
}

function policy(capture?: (effects: ReadonlyMap<string, ToolEffectRegistration>) => void) {
  return {
    slot: "policy",
    effects: [],
    createExtension: (effects: ReadonlyMap<string, ToolEffectRegistration>) => {
      capture?.(effects);
      return createPiToolPolicyExtension(effects);
    },
  } as const satisfies PiExtensionContribution;
}

describe("assemblePiExtensions", () => {
  it("uses one deterministic order and gives policy the exact global registry", () => {
    let policyEffects: ReadonlyMap<string, ToolEffectRegistration> | undefined;
    const assembled = assemblePiExtensions(
      [
        contribution("mcp", "mcp"),
        contribution("workspace", "workspace"),
        contribution("repository_editing", "repository-editing"),
        contribution("core", "core"),
        policy((effects) => (policyEffects = effects)),
        contribution("external_actions", "external-actions"),
        contribution("delegation", "delegation"),
        contribution("sandbox_execution", "sandbox"),
        contribution("skills", "skills"),
        contribution("code_mode", "code-mode"),
      ],
      capabilities
    );

    expect(PI_EXTENSION_SLOTS).toEqual([
      "policy",
      "core",
      "delegation",
      "skills",
      "workspace",
      "repository_editing",
      "code_mode",
      "sandbox_execution",
      "external_actions",
      "mcp",
    ]);
    expect(assembled.extensions.map(({ name }) => name)).toEqual([
      "open-inspect.tool-policy",
      "core",
      "delegation",
      "skills",
      "workspace",
      "repository-editing",
      "code-mode",
      "sandbox",
      "external-actions",
      "mcp",
    ]);
    expect(policyEffects).toBe(assembled.effects);
  });

  it("rejects two feature branches claiming the same slot", () => {
    expect(() =>
      assemblePiExtensions(
        [contribution("mcp", "mcp-static"), contribution("mcp", "mcp-oauth")],
        capabilities
      )
    ).toThrow('Duplicate Pi extension slot: "mcp"');
  });

  it("rejects duplicate extension names across different slots", () => {
    expect(() =>
      assemblePiExtensions(
        [contribution("core", "open-inspect"), contribution("policy", "open-inspect")],
        capabilities
      )
    ).toThrow('Duplicate Pi extension name: "open-inspect"');
  });

  it("rejects duplicate tool names across slots before exposure", () => {
    expect(() =>
      assemblePiExtensions(
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
    ).toThrow('Duplicate Pi tool name: "duplicate"');
  });

  it("rejects undeclared tools and declarations without tools", () => {
    expect(() =>
      assemblePiExtensions(
        [
          {
            slot: "core",
            extension: defineExtension({ name: "core", tools: [tool("undeclared")] }),
            effects: [],
          },
        ],
        capabilities
      )
    ).toThrow('Pi tool has no effect declaration: "undeclared"');

    expect(() =>
      assemblePiExtensions(
        [
          {
            slot: "core",
            extension: defineExtension({ name: "core" }),
            effects: [effect("missing")],
          },
        ],
        capabilities
      )
    ).toThrow('Pi tool effect declaration has no tool: "missing"');
  });

  it("rejects caller and replay declarations that differ from the actual tool", () => {
    expect(() =>
      assemblePiExtensions(
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
    ).toThrow('Pi tool callers do not match declaration: "wrong_callers"');

    expect(() =>
      assemblePiExtensions(
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
    ).toThrow('Pi tool replay does not match declaration: "wrong_replay"');
  });

  it("accepts discovered stable MCP tools only when declared before exposure", () => {
    const assembled = assemblePiExtensions(
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
    const assembled = assemblePiExtensions(
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
      assemblePiExtensions(
        [
          {
            slot: "external_actions",
            feature: "externalActions",
            minimumCapability: "enabled",
            extension: defineExtension({
              name: "external-actions",
              tools: [tool("publish", { replay: "safe" })],
            }),
            effects: [effect("publish", { effect: "external_mutation" })],
          },
        ],
        capabilities
      )
    ).toThrow("Mutating Pi tool contributions require the policy extension");
  });

  it("requires the one composite policy slot before read-only tools too", () => {
    expect(() =>
      assemblePiExtensions(
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
    ).toThrow("Pi tool contributions require the composite policy extension");
  });

  it("accepts Code Mode only with codemode and internal models declarations", () => {
    const assembled = assemblePiExtensions(
      [
        policy(),
        {
          slot: "code_mode",
          feature: "codeMode",
          minimumCapability: "enabled",
          extension: defineExtension({
            name: "codemode",
            tools: [
              tool("codemode", { callers: ["model"], replay: "safe" }),
              tool("pi.codemode.models.classify", { callers: ["tools"] }),
              tool("pi.codemode.models.generateImages", { callers: ["tools"] }),
            ],
          }),
          effects: PI_CODEMODE_TOOL_EFFECT_REGISTRATIONS,
        },
      ],
      capabilities
    );

    expect([...assembled.effects]).toHaveLength(3);
  });
});
