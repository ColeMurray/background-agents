import { describe, expect, it } from "vitest";
import { composeAutomationPrompt } from "./scheduler";

describe("composeAutomationPrompt", () => {
  it("puts instructions first", () => {
    expect(composeAutomationPrompt("CTX", "INSTRUCTIONS")).toBe("INSTRUCTIONS\n---\n\nCTX");
  });

  it("keeps the same leading span when only the context changes", () => {
    const a = composeAutomationPrompt("event one", "INSTRUCTIONS");
    const b = composeAutomationPrompt("event two", "INSTRUCTIONS");
    const shared = "INSTRUCTIONS\n---\n\n".length;
    expect(a.slice(0, shared)).toBe(b.slice(0, shared));
  });
});
