import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_ENABLED_MODELS } from "@open-inspect/shared/models";
import { publishView } from "@open-inspect/shared/slack";
import type * as SlackModule from "@open-inspect/shared/slack";
import type * as BranchPreferencesModule from "../branch-preferences";
import type { Env } from "../types";
import type { AppHomeView } from "./slack-types";
import { publishAppHome } from "./publisher";

vi.mock("@open-inspect/shared/slack", async (importOriginal) => ({
  ...(await importOriginal<typeof SlackModule>()),
  publishView: vi.fn(),
}));
vi.mock("../branch-preferences", async (importOriginal) => ({
  ...(await importOriginal<typeof BranchPreferencesModule>()),
  getUserRepoBranchPreferences: vi.fn(async () => new Map()),
}));
vi.mock("../classifier/repos", () => ({ getAvailableRepos: vi.fn(async () => []) }));
vi.mock("../slack-settings", () => ({
  getSlackSettings: vi.fn(async () => ({ harness: "opencode" })),
}));

describe("publishAppHome model availability", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(publishView).mockResolvedValue({ ok: true });
  });

  it.each(["enabled", "disabled", "HTTP error", "non-strict fallback"])(
    "renders an opt-in preference with %s model preferences",
    async (state) => {
      const preferences = {
        userId: "U123",
        model: "xai/grok-4.6",
        reasoningEffort: "high",
        updatedAt: 1,
      };
      const fetch = vi.fn(async (input: RequestInfo | URL) => {
        if (state === "non-strict fallback" && !String(input).includes("strict=true")) {
          return Response.json({ enabledModels: DEFAULT_ENABLED_MODELS });
        }
        if (state === "HTTP error" || state === "non-strict fallback") {
          return new Response("unavailable", { status: 503 });
        }
        return Response.json({
          enabledModels: state === "enabled" ? [preferences.model] : ["anthropic/claude-haiku-4-5"],
        });
      });
      const env = {
        SLACK_BOT_TOKEN: "xoxb-test",
        SERVICE_AUTH_SECRET: "test-secret",
        CONTROL_PLANE: { fetch },
        SLACK_KV: { get: vi.fn(async () => preferences) },
      } as unknown as Env;

      await publishAppHome(env, "U123");

      expect(fetch).toHaveBeenCalledOnce();
      expect(String(fetch.mock.calls[0][0])).toBe("https://internal/model-preferences?strict=true");
      const view = vi.mocked(publishView).mock.calls[0][2] as AppHomeView;
      const texts = view.blocks
        .flatMap((block) =>
          block.type === "section"
            ? [block.text.text]
            : block.type === "context"
              ? block.elements.map((element) => element.text)
              : []
        )
        .join(" ");
      const reasoning = view.blocks.find(
        (block) => block.type === "actions" && block.block_id === "reasoning_selection"
      );
      const model = view.blocks.find(
        (block) => block.type === "actions" && block.block_id === "model_selection"
      );

      if (state === "disabled") {
        expect(texts).toContain("Your model `xai/grok-4.6` is no longer enabled");
        expect(texts).toContain("model needs replacement");
        expect(reasoning).toBeUndefined();
      } else {
        expect(texts).not.toContain("is no longer enabled");
        expect(texts).not.toContain("model needs replacement");
        expect(texts).toContain("Grok");
        expect(reasoning).toBeDefined();
        if (state === "enabled") {
          expect(model).toEqual(
            expect.objectContaining({
              elements: [
                expect.objectContaining({
                  initial_option: expect.objectContaining({ value: preferences.model }),
                }),
              ],
            })
          );
          expect(texts).not.toContain("Model preferences are temporarily unavailable");
        } else {
          expect(model).toBeUndefined();
          expect(texts).toContain("Model preferences are temporarily unavailable");
          expect(texts).toContain("Your model `xai/grok-4.6` has not been changed");
        }
      }
    }
  );
});
