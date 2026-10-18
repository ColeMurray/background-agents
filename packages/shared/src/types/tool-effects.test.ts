import { describe, expect, it } from "vitest";
import { classifyToolEffect, LOCAL_MUTATION_TOOL_NAMES } from "./tool-effects";

describe("tool effect classification", () => {
  it("shares one local_mutation classification for generic file tools", () => {
    expect(LOCAL_MUTATION_TOOL_NAMES).toEqual(["write", "edit", "delete"]);
    expect(LOCAL_MUTATION_TOOL_NAMES.map(classifyToolEffect)).toEqual([
      "local_mutation",
      "local_mutation",
      "local_mutation",
    ]);
  });

  it("does not classify unknown tools by naming convention", () => {
    expect(classifyToolEffect("write_network")).toBeNull();
  });
});
