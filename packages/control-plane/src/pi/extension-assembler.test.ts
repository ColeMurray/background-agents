import { defineExtension } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { PI_EXTENSION_SLOTS, assemblePiExtensions } from "./extension-assembler";

const extension = (name: string) => defineExtension({ name });

describe("assemblePiExtensions", () => {
  it("uses one deterministic order regardless of contribution order", () => {
    const assembled = assemblePiExtensions([
      { slot: "mcp", extension: extension("mcp") },
      { slot: "workspace", extension: extension("workspace") },
      { slot: "core", extension: extension("core") },
      { slot: "policy", extension: extension("policy") },
      { slot: "external_actions", extension: extension("external-actions") },
      { slot: "delegation", extension: extension("delegation") },
      { slot: "sandbox_execution", extension: extension("sandbox") },
      { slot: "skills", extension: extension("skills") },
      { slot: "code_mode", extension: extension("code-mode") },
    ]);

    expect(PI_EXTENSION_SLOTS).toEqual([
      "policy",
      "core",
      "delegation",
      "skills",
      "workspace",
      "code_mode",
      "sandbox_execution",
      "external_actions",
      "mcp",
    ]);
    expect(assembled.map(({ name }) => name)).toEqual([
      "policy",
      "core",
      "delegation",
      "skills",
      "workspace",
      "code-mode",
      "sandbox",
      "external-actions",
      "mcp",
    ]);
  });

  it("rejects two feature branches claiming the same slot", () => {
    expect(() =>
      assemblePiExtensions([
        { slot: "mcp", extension: extension("mcp-static") },
        { slot: "mcp", extension: extension("mcp-oauth") },
      ])
    ).toThrow('Duplicate Pi extension slot: "mcp"');
  });

  it("rejects duplicate extension names across different slots", () => {
    expect(() =>
      assemblePiExtensions([
        { slot: "core", extension: extension("open-inspect") },
        { slot: "policy", extension: extension("open-inspect") },
      ])
    ).toThrow('Duplicate Pi extension name: "open-inspect"');
  });
});
