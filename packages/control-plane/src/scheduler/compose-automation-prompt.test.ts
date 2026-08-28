import { describe, expect, it } from "vitest";
import { composeAutomationPrompt } from "./scheduler";
import type { Env } from "../types";

const env = (value?: string) => ({ AUTOMATION_INSTRUCTIONS_FIRST: value }) as unknown as Env;

describe("composeAutomationPrompt", () => {
  it("puts instructions first by default", () => {
    expect(composeAutomationPrompt(env(undefined), "CTX", "INSTRUCTIONS")).toBe(
      "INSTRUCTIONS\n---\n\nCTX"
    );
  });

  it("keeps the same leading span when only the context changes", () => {
    const a = composeAutomationPrompt(env(undefined), "event one", "INSTRUCTIONS");
    const b = composeAutomationPrompt(env(undefined), "event two", "INSTRUCTIONS");
    const shared = "INSTRUCTIONS\n---\n\n".length;
    expect(a.slice(0, shared)).toBe(b.slice(0, shared));
  });

  it('restores context-first ordering when the flag is "false"', () => {
    expect(composeAutomationPrompt(env("false"), "CTX", "INSTRUCTIONS")).toBe(
      "CTX\n---\n\nINSTRUCTIONS"
    );
  });

  it("treats any other value as the default", () => {
    expect(composeAutomationPrompt(env("true"), "CTX", "INSTRUCTIONS")).toBe(
      "INSTRUCTIONS\n---\n\nCTX"
    );
    expect(composeAutomationPrompt(env(""), "CTX", "INSTRUCTIONS")).toBe(
      "INSTRUCTIONS\n---\n\nCTX"
    );
  });
});
