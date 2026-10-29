import { describe, expect, it } from "vitest";
import { getReasoningConfig } from "@open-inspect/shared/models";
import { resolveModelPreference } from "./model-selection";
import { resolveHarnessModelSelection } from "./session-harness";

const MODEL = "openai/gpt-5.6-sol";

describe("harness-aware reasoning preference", () => {
  it("keeps a Codex-only effort that the generic catalog does not offer", () => {
    expect(getReasoningConfig(MODEL)?.efforts).not.toContain("max");
    expect(
      resolveModelPreference({ model: MODEL, reasoningEffort: "max" }, undefined, "codex")
        .reasoningEffort
    ).toBe("max");
  });

  it("still replaces an effort the harness cannot run with that harness's default", () => {
    expect(
      resolveModelPreference({ model: MODEL, reasoningEffort: "max" }, undefined, "opencode")
        .reasoningEffort
    ).toBe(getReasoningConfig(MODEL)?.default);
  });

  it("carries the Codex selection through the composer's model selection", () => {
    const selection = resolveHarnessModelSelection({
      harness: "codex",
      preference: { model: MODEL, reasoningEffort: "max" },
      enabledModels: [MODEL],
      enabledModelOptions: [],
      loading: false,
    });
    expect(selection.availability).toEqual({ status: "available" });
    expect(selection).toMatchObject({ model: MODEL, reasoningEffort: "max" });
  });
});
