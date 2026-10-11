import { describe, expect, it } from "vitest";
import type { ValidModel } from "@open-inspect/shared/models";
import { applyInlineModelOverrides } from "../src/model-selection";

const defaults = { model: "anthropic/claude-sonnet-4-6", reasoningEffort: "low" };
const enabledModels = [
  "anthropic/claude-sonnet-4-6",
  "anthropic/claude-haiku-4-5",
  "openai/gpt-5.6-sol",
  "opencode/kimi-k3",
] satisfies ValidModel[];

describe("applyInlineModelOverrides", () => {
  it("applies a model and reasoning override together", () => {
    expect(
      applyInlineModelOverrides(
        { model: "openai/gpt-5.6-sol", reasoningEffort: "xhigh" },
        defaults,
        enabledModels
      )
    ).toEqual({
      ok: true,
      selection: { model: "openai/gpt-5.6-sol", reasoningEffort: "xhigh" },
    });
  });

  it("normalizes bare model ids and keeps a compatible configured effort", () => {
    expect(applyInlineModelOverrides({ model: "gpt-5.6-sol" }, defaults, enabledModels)).toEqual({
      ok: true,
      selection: { model: "openai/gpt-5.6-sol", reasoningEffort: "low" },
    });
  });

  it("drops a configured effort the override model does not support", () => {
    expect(
      applyInlineModelOverrides({ model: "anthropic/claude-haiku-4-5" }, defaults, enabledModels)
    ).toEqual({
      ok: true,
      selection: { model: "anthropic/claude-haiku-4-5", reasoningEffort: null },
    });
  });

  it("applies a reasoning-only override to the configured model", () => {
    expect(applyInlineModelOverrides({ reasoningEffort: "max" }, defaults, [])).toEqual({
      ok: true,
      selection: { model: "anthropic/claude-sonnet-4-6", reasoningEffort: "max" },
    });
  });

  it("rejects unknown and disabled models", () => {
    expect(applyInlineModelOverrides({ model: "gpt-9" }, defaults, enabledModels)).toEqual({
      ok: false,
      message: "Unknown model `gpt-9`.",
    });
    expect(
      applyInlineModelOverrides({ model: "anthropic/claude-sonnet-4-6" }, defaults, [
        "openai/gpt-5.6-sol",
      ])
    ).toEqual({
      ok: false,
      message:
        "Model `anthropic/claude-sonnet-4-6` is not enabled. Enable it under Settings › Models.",
    });
  });

  it("rejects reasoning the effective model does not support", () => {
    expect(applyInlineModelOverrides({ reasoningEffort: "xhigh" }, defaults, [])).toEqual({
      ok: false,
      message:
        "Reasoning effort `xhigh` is not valid for `anthropic/claude-sonnet-4-6`. Supported values: `low`, `medium`, `high`, `max`.",
    });
    expect(
      applyInlineModelOverrides(
        { model: "opencode/kimi-k3", reasoningEffort: "high" },
        defaults,
        enabledModels
      )
    ).toEqual({
      ok: false,
      message:
        "Reasoning effort `high` is not valid for `opencode/kimi-k3`. This model does not support reasoning controls.",
    });
  });

  it("keeps backticks in user-supplied values inside the code span", () => {
    expect(applyInlineModelOverrides({ model: "a`b" }, defaults, enabledModels)).toEqual({
      ok: false,
      message: "Unknown model `` a`b ``.",
    });
  });
});
