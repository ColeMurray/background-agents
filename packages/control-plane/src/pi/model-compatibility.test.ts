import { describe, expect, it } from "vitest";
import { filterModelsForHarness } from "@open-inspect/shared/harnesses";
import { isValidModel, VALID_MODELS } from "@open-inspect/shared/models";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";

describe("Pi model compatibility", () => {
  it("matches the pinned pi-ai openai-codex registry", () => {
    const runtimeModels = openaiCodexProvider()
      .getModels()
      .map((model) => `openai/${model.id}`)
      .filter(isValidModel);

    expect(new Set(filterModelsForHarness("pi", VALID_MODELS))).toEqual(new Set(runtimeModels));
  });
});
