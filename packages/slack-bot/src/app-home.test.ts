import { describe, expect, it } from "vitest";
import { buildAppHomeIntroText, buildAppHomeView } from "./app-home";
import type { RepoConfig } from "./types";

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
    if (modelSelect.type !== "static_select") {
      throw new Error("Missing model static select");
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
});
