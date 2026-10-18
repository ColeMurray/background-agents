import { describe, expect, it } from "vitest";
import { indexPiToolEffects, type PiToolEffectMetadata } from "./tool-effects";

describe("indexPiToolEffects", () => {
  it("indexes shared local and external classifications", () => {
    const metadata: PiToolEffectMetadata[] = [
      { tool: "write", effect: "local_mutation", owner: "workspace", operation: "write" },
      {
        tool: "publish_pr",
        effect: "external_mutation",
        owner: "external-actions",
        operation: "publish",
      },
    ];

    expect(indexPiToolEffects(metadata)).toEqual(
      new Map(metadata.map((entry) => [entry.tool, entry]))
    );
  });

  it("rejects conflicting ownership of one tool name", () => {
    expect(() =>
      indexPiToolEffects([
        { tool: "write", effect: "local_mutation", owner: "workspace", operation: "write" },
        {
          tool: "write",
          effect: "external_mutation",
          owner: "external-actions",
          operation: "publish",
        },
      ])
    ).toThrow("Duplicate Pi tool effect metadata: write");
  });
});
