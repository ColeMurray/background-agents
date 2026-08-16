// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { useRef, useState, type KeyboardEvent } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as matchers from "@testing-library/jest-dom/matchers";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { PromptSkillAutocomplete } from "./prompt-skill-autocomplete";

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
  const inputRef = useRef<HTMLTextAreaElement>(null);
  return (
    <div className="relative">
      <PromptSkillAutocomplete
        value={value}
        skills={availableSkills}
        inputRef={inputRef}
        onValueChange={setValue}
        onKeyDown={onFallbackKeyDown}
        loadState={loadState}
        maxLength={maxLength}
      >
        {(props) => <textarea {...props} ref={inputRef} aria-label="Prompt" value={value} />}
      </PromptSkillAutocomplete>
    </div>
  );
}

describe("PromptSkillAutocomplete", () => {
  it("filters and selects a skill with the keyboard", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const input = screen.getByRole("textbox", { name: "Prompt" });

    await user.type(input, "$re");
    expect(screen.getByRole("listbox", { name: "Managed skills" })).toBeInTheDocument();
    expect(screen.getAllByRole("option")).toHaveLength(2);
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
});
