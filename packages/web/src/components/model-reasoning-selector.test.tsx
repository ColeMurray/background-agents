// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
import type { ModelCategory } from "@open-inspect/shared/models";
import { ModelReasoningSelector } from "./model-reasoning-selector";

const mocks = vi.hoisted(() => ({ isMobile: false }));

vi.mock("@/hooks/use-media-query", () => ({ useIsMobile: () => mocks.isMobile }));

expect.extend(matchers);

afterEach(() => {
  cleanup();
  mocks.isMobile = false;
});

const items = [
  {
    category: "Anthropic",
    models: [
      {
        id: "anthropic/claude-sonnet-4-6",
        name: "Claude Sonnet 4.6",
        description: "Balanced, fast coding",
      },
    ],
  },
  {
    category: "Other",
    models: [
      {
        id: "xai/grok-build-0.1",
        name: "Grok Build 0.1",
        description: "Coding model",
      },
    ],
  },
] satisfies ModelCategory[];

describe("ModelReasoningSelector", () => {
  it("combines the selected model and effort in one trigger", () => {
    render(
      <ModelReasoningSelector
        selectedModel="anthropic/claude-sonnet-4-6"
        reasoningEffort="high"
        items={items}
        onModelChange={vi.fn()}
        onReasoningEffortChange={vi.fn()}
      />
    );

    const trigger = screen.getByRole("button", { name: /model and effort/i });
    expect(trigger).toHaveTextContent("claude sonnet 4.6High");
    expect(trigger.querySelectorAll("svg")).toHaveLength(1);
  });

  it("selects model and effort through nested menus", async () => {
    const onModelChange = vi.fn();
    const onReasoningEffortChange = vi.fn();
    render(
      <ModelReasoningSelector
        selectedModel="anthropic/claude-sonnet-4-6"
        reasoningEffort="high"
        items={items}
        onModelChange={onModelChange}
        onReasoningEffortChange={onReasoningEffortChange}
      />
    );

    const trigger = screen.getByRole("button", { name: /model and effort/i });
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
    const modelMenu = await screen.findByRole("menuitem", { name: /model/i });
    modelMenu.focus();
    fireEvent.keyDown(modelMenu, { key: "ArrowRight" });
    const grokOption = await screen.findByRole("menuitemradio", { name: /grok build/i });
    expect(grokOption.closest('[role="menu"]')).toHaveClass("max-h-56", "overflow-y-auto");
    expect(grokOption.closest('[role="menu"]')).toHaveAttribute("data-align", "end");
    fireEvent.click(grokOption);
    expect(onModelChange).toHaveBeenCalledWith("xai/grok-build-0.1");

    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
    const effortMenu = await screen.findByRole("menuitem", { name: /effort/i });
    effortMenu.focus();
    fireEvent.keyDown(effortMenu, { key: "ArrowRight" });
    const maxEffort = await screen.findByRole("menuitemradio", { name: "Max" });
    expect(maxEffort.closest('[role="menu"]')).toHaveAttribute("data-align", "end");
    fireEvent.click(maxEffort);
    expect(onReasoningEffortChange).toHaveBeenCalledWith("max");
  });

  it("drills into model options without a clipped side menu on mobile", async () => {
    mocks.isMobile = true;
    render(
      <ModelReasoningSelector
        selectedModel="anthropic/claude-sonnet-4-6"
        reasoningEffort="high"
        items={items}
        onModelChange={vi.fn()}
        onReasoningEffortChange={vi.fn()}
      />
    );

    const trigger = screen.getByRole("button", { name: /model and effort/i });
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole("menuitem", { name: /model/i }));

    expect(await screen.findByRole("menuitem", { name: "Back" })).toBeInTheDocument();
    expect(screen.getByRole("menu")).toHaveStyle({
      maxHeight: "min(14rem, var(--radix-dropdown-menu-content-available-height))",
    });
    expect(screen.getByRole("menuitemradio", { name: /claude sonnet 4.6/i })).toHaveAttribute(
      "aria-checked",
      "true"
    );
  });
});
