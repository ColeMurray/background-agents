// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { useState, type KeyboardEvent } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as matchers from "@testing-library/jest-dom/matchers";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { PromptSkillTextarea } from "./prompt-skill-autocomplete";

expect.extend(matchers);

const skills = [
  { skillId: "review", name: "review-pr", description: "Review a pull request" },
  { skillId: "release", name: "release-notes", description: "Draft release notes" },
];

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(cleanup);

function Harness({
  onFallbackKeyDown = vi.fn<(event: KeyboardEvent<HTMLTextAreaElement>) => void>(),
  loadState = "ready",
  availableSkills = skills,
  maxLength,
}: {
  onFallbackKeyDown?: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  loadState?: "ready" | "loading" | "error";
  availableSkills?: typeof skills;
  maxLength?: number;
}) {
  const [value, setValue] = useState("");
  const suggestions =
    loadState === "ready"
      ? ({ status: "ready", skills: availableSkills } as const)
      : ({ status: loadState } as const);
  return (
    <div className="relative">
      <PromptSkillTextarea
        value={value}
        suggestions={suggestions}
        onValueChange={setValue}
        onKeyDown={onFallbackKeyDown}
        maxLength={maxLength}
        aria-label="Prompt"
      />
    </div>
  );
}

describe("PromptSkillTextarea", () => {
  it("filters and selects a skill with the keyboard", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const input = screen.getByRole("textbox", { name: "Prompt" });

    await user.type(input, "$re");
    expect(screen.getByRole("listbox", { name: "Managed skills" })).toBeInTheDocument();
    expect(screen.getAllByRole("option")).toHaveLength(2);
    expect(screen.getAllByRole("option")[0]).toHaveAttribute("tabindex", "-1");
    expect(screen.getByTestId("prompt-skill-suggestions")).not.toHaveAttribute("role");
    expect(input).toHaveAttribute("aria-autocomplete", "list");
    expect(input).toHaveAttribute("aria-expanded", "true");

    await user.keyboard("{ArrowDown}{Enter}");
    expect(input).toHaveValue("$release-notes ");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(input).toHaveFocus();
  });

  it("dismisses without changing the draft", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const input = screen.getByRole("textbox", { name: "Prompt" });

    await user.type(input, "/rev");
    await user.keyboard("{Escape}");

    expect(input).toHaveValue("/rev");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();

    await user.type(input, "i");
    expect(screen.getByRole("listbox", { name: "Managed skills" })).toBeInTheDocument();
  });

  it("preserves the existing submission shortcut", async () => {
    const user = userEvent.setup();
    const onFallbackKeyDown = vi.fn();
    render(<Harness onFallbackKeyDown={onFallbackKeyDown} />);
    const input = screen.getByRole("textbox", { name: "Prompt" });

    await user.type(input, "$");
    await user.keyboard("{Control>}{Enter}{/Control}");

    expect(onFallbackKeyDown).toHaveBeenCalled();
    expect(input).toHaveValue("$");
  });

  it("shows explicit loading and no-match states above the composer", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<Harness loadState="loading" availableSkills={[]} />);
    const input = screen.getByRole("textbox", { name: "Prompt" });

    await user.type(input, "/");
    expect(screen.getByRole("listbox", { name: "Managed skills" })).toHaveAttribute(
      "aria-busy",
      "true"
    );
    expect(screen.getByText("Loading managed skills...")).toBeInTheDocument();

    rerender(<Harness availableSkills={[]} />);
    expect(screen.getByText("No managed skills match this session.")).toBeInTheDocument();
    expect(screen.getByTestId("prompt-skill-suggestions")).toHaveClass("bottom-full");

    rerender(<Harness loadState="error" availableSkills={[]} />);
    expect(
      screen.getByText("Managed skills could not be loaded. Try again shortly.")
    ).toBeInTheDocument();
  });

  it("does not insert a completion beyond the prompt limit", async () => {
    const user = userEvent.setup();
    render(<Harness maxLength={5} />);
    const input = screen.getByRole("textbox", { name: "Prompt" });

    await user.type(input, "$r");
    await user.keyboard("{Enter}");

    expect(input).toHaveValue("$r");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("selects with a pointer without blurring the textarea", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const input = screen.getByRole("textbox", { name: "Prompt" });

    await user.type(input, "/review");
    await user.pointer({
      target: screen.getByRole("option", { name: /review-pr/i }),
      keys: "[MouseLeft]",
    });

    expect(input).toHaveValue("/review-pr ");
    expect(input).toHaveFocus();
  });

  it("selects the active completion with Tab", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const input = screen.getByRole("textbox", { name: "Prompt" });

    await user.type(input, "/rev");
    await user.keyboard("{Tab}");

    expect(input).toHaveValue("/review-pr ");
    expect(input).toHaveFocus();
  });

  it("suppresses suggestions and selection while composing", async () => {
    const onFallbackKeyDown = vi.fn();
    render(<Harness onFallbackKeyDown={onFallbackKeyDown} />);
    const input = screen.getByRole("textbox", { name: "Prompt" });

    fireEvent.focus(input);
    fireEvent.compositionStart(input);
    fireEvent.change(input, { target: { value: "$re" } });
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });

    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(input).toHaveValue("$re");
    expect(onFallbackKeyDown).toHaveBeenCalled();

    fireEvent.compositionEnd(input, { target: { selectionStart: 3, selectionEnd: 3 } });
    expect(await screen.findByRole("option", { name: /review-pr/i })).toBeInTheDocument();
  });
});
