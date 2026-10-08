import { describe, expect, it, vi } from "vitest";
import { parseInlinePromptFlags } from "@open-inspect/shared/inline-prompt-flags";
import type { ValidModel } from "@open-inspect/shared/models";
import { applyInlineModelOverrides, resolveModelSelection } from "../src/model-selection";
import type { Logger } from "../src/logger";
import type { Env } from "../src/types";

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

describe("resolveModelSelection compatibility", () => {
  const log: Logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };

  it.each(["Review this", "!reasoning:high Review this"])(
    "checks the configured canonical model without fetching enabled models (%s)",
    async (prompt) => {
      const fetch = vi.fn();
      const env = { CONTROL_PLANE: { fetch } } as unknown as Env;

      expect(
        await resolveModelSelection(
          env,
          log,
          "trace-compatibility",
          { model: "gpt-5.6-sol", harness: "claude", reasoningEffort: null },
          parseInlinePromptFlags(prompt)
        )
      ).toMatchObject({
        ok: false,
        reason: "harness_model_incompatible",
        message: expect.stringContaining(
          'Model "openai/gpt-5.6-sol" cannot run on the Claude Agent harness.'
        ),
      });
      expect(fetch).not.toHaveBeenCalled();
    }
  );

  it("allows a compatible inline override to repair incompatible defaults", async () => {
    const env = {
      SERVICE_AUTH_SECRET: "test-secret",
      CONTROL_PLANE: { fetch: vi.fn(async () => Response.json({ enabledModels })) },
    } as unknown as Env;

    expect(
      await resolveModelSelection(
        env,
        log,
        "trace-compatible-override",
        { model: "openai/gpt-5.6-sol", harness: "claude", reasoningEffort: "low" },
        parseInlinePromptFlags("!model:claude-sonnet-4-6 Review this")
      )
    ).toEqual({
      ok: true,
      overridden: true,
      selection: {
        model: "anthropic/claude-sonnet-4-6",
        harness: "claude",
        reasoningEffort: "low",
      },
    });
  });
});
