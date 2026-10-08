import { describe, expect, it } from "vitest";
import type { HarnessId } from "@open-inspect/shared/harnesses";
import type { RepoConfig } from "@open-inspect/shared/types/repository-catalog";
import { buildAppHomeIntroText, buildAppHomeView } from "./app-home";

describe("buildAppHomeIntroText", () => {
  it("uses the configured app name", () => {
    expect(buildAppHomeIntroText("Acme Bot")).toBe("Configure your Acme Bot preferences below.");
  });

  it("works with the default Open-Inspect name", () => {
    expect(buildAppHomeIntroText("Open-Inspect")).toBe(
      "Configure your Open-Inspect preferences below."
    );
  });
});

describe("buildAppHomeView", () => {
  it("caps model select option labels at Slack's 75-character limit", () => {
    const longLabel = "Long model label ".repeat(8);

    const view = buildAppHomeView({
      appName: "Open-Inspect",
      availableModels: [
        {
          label: longLabel,
          value: "anthropic/claude-haiku-4-5",
        },
      ],
      userHarness: undefined,
      workspaceHarness: "opencode",
      currentModel: "anthropic/claude-haiku-4-5",
      currentEffort: "max",
      currentBranch: undefined,
      repos: [],
      repoBranchPreferences: new Map(),
    });

    const modelActionsBlock = view.blocks.find(
      (block) => block.type === "actions" && block.block_id === "model_selection"
    );
    expect(modelActionsBlock?.type).toBe("actions");
    if (modelActionsBlock?.type !== "actions") {
      throw new Error("Missing model actions block");
    }

    const modelSelect = modelActionsBlock.elements[0];
    expect(modelSelect.type).toBe("static_select");
    if (modelSelect.type !== "static_select" || !("options" in modelSelect)) {
      throw new Error("Missing model static select with flat options");
    }

    expect(modelSelect.options[0].text.text).toHaveLength(75);
    expect(modelSelect.options[0].text.text).toMatch(/…$/);
    expect(modelSelect.initial_option?.text.text).toHaveLength(75);
    expect(modelSelect.initial_option?.text.text).toMatch(/…$/);
  });

  it("caps the repo-override list under Slack's 100-block limit", () => {
    const repos: RepoConfig[] = Array.from({ length: 60 }, (_, idx) => {
      const number = String(idx + 1).padStart(3, "0");
      return {
        id: `acme/repo-${number}`,
        owner: "acme",
        name: `repo-${number}`,
        fullName: `acme/repo-${number}`,
        displayName: `acme/repo-${number}`,
        description: "",
        defaultBranch: "main",
        private: true,
      };
    });
    const repoBranchPreferences = new Map(repos.map((repo) => [repo.id, "staging"]));

    const view = buildAppHomeView({
      appName: "Open-Inspect",
      availableModels: [
        {
          label: "Claude Haiku",
          value: "anthropic/claude-haiku-4-5",
        },
      ],
      userHarness: undefined,
      workspaceHarness: "opencode",
      currentModel: "anthropic/claude-haiku-4-5",
      currentEffort: "max",
      currentBranch: undefined,
      repos,
      repoBranchPreferences,
    });

    expect(view.blocks.length).toBeLessThanOrEqual(100);

    const overrideRows = view.blocks.filter(
      (block) => block.type === "section" && block.text.text.includes("→")
    );
    expect(overrideRows.length).toBe(50);

    const hasMoreNote = view.blocks.some(
      (block) =>
        block.type === "context" &&
        block.elements.some((element) => element.text.includes("10 more overrides"))
    );
    expect(hasMoreNote).toBe(true);
  });

  describe("agent harness", () => {
    const models = [
      { label: "Claude Haiku", value: "anthropic/claude-haiku-4-5" },
      { label: "GPT 5.4", value: "openai/gpt-5.4" },
    ];

    function render(state: {
      userHarness: HarnessId | undefined;
      workspaceHarness: HarnessId;
      currentModel: string;
      availableModels?: typeof models;
    }) {
      const view = buildAppHomeView({
        appName: "Open-Inspect",
        availableModels: models,
        currentEffort: undefined,
        currentBranch: undefined,
        repos: [],
        repoBranchPreferences: new Map(),
        ...state,
      });
      const select = (blockId: string) => {
        const block = view.blocks.find(
          (candidate) => candidate.type === "actions" && candidate.block_id === blockId
        );
        if (block?.type !== "actions") return undefined;
        const element = block.elements[0];
        return element.type === "static_select" && "options" in element ? element : undefined;
      };
      const texts = view.blocks.flatMap((block) =>
        block.type === "context"
          ? block.elements.map((element) => element.text)
          : block.type === "section"
            ? [block.text.text]
            : []
      );
      return {
        harness: select("harness_selection"),
        model: select("model_selection"),
        reasoning: select("reasoning_selection"),
        texts,
      };
    }

    it("offers the workspace default and every harness, selecting the workspace by default", () => {
      const { harness } = render({
        userHarness: undefined,
        workspaceHarness: "claude",
        currentModel: "anthropic/claude-haiku-4-5",
      });

      expect(harness?.options.map((option) => option.text.text)).toEqual([
        "Workspace default (Claude Agent)",
        "OpenCode",
        "Claude Agent",
      ]);
      expect(harness?.initial_option?.value).toBe("__workspace__");
    });

    it("lists only the models the user's harness can run", () => {
      const { harness, model, texts } = render({
        userHarness: "claude",
        workspaceHarness: "opencode",
        currentModel: "anthropic/claude-haiku-4-5",
      });

      expect(harness?.initial_option?.value).toBe("claude");
      expect(model?.options.map((option) => option.value)).toEqual(["anthropic/claude-haiku-4-5"]);
      expect(model?.initial_option?.value).toBe("anthropic/claude-haiku-4-5");
      expect(texts.at(-1)).toBe("Currently using: *Claude Haiku* · max · Claude Agent");
    });

    it("asks for a compatible model instead of selecting one the harness cannot run", () => {
      const { model, texts } = render({
        userHarness: "claude",
        workspaceHarness: "opencode",
        currentModel: "openai/gpt-5.4",
      });

      expect(model?.initial_option).toBeUndefined();
      expect(model?.placeholder?.text).toBe("Choose a model");
      expect(texts).toContain(
        "Your model `openai/gpt-5.4` can't run on Claude Agent, so new requests are refused until you choose a model above."
      );
    });

    it.each(["opencode", "claude"] as const)(
      "asks to replace a disabled model on %s instead of selecting another model",
      (userHarness) => {
        const { model, texts, reasoning } = render({
          userHarness,
          workspaceHarness: "opencode",
          currentModel: "anthropic/claude-sonnet-4-6",
        });

        expect(model?.initial_option).toBeUndefined();
        expect(model?.placeholder?.text).toBe("Choose a model");
        expect(reasoning).toBeUndefined();
        expect(texts).toContain(
          "Your model `anthropic/claude-sonnet-4-6` is no longer enabled, so new requests are refused until you choose a model above."
        );
        expect(texts.at(-1)).toContain("model needs replacement");
      }
    );

    it("explains disablement even when the harness has no enabled models", () => {
      const { model, texts, reasoning } = render({
        userHarness: "claude",
        workspaceHarness: "opencode",
        currentModel: "anthropic/claude-sonnet-4-6",
        availableModels: [models[1]],
      });

      expect(model).toBeUndefined();
      expect(reasoning).toBeUndefined();
      expect(texts).toContain(
        "*Model*\nYour model `anthropic/claude-sonnet-4-6` is no longer enabled. No enabled model can run on Claude Agent. Choose another agent harness, or ask an admin to enable a model it can run."
      );
    });
  });
});
