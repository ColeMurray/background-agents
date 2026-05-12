// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
import type { ReactNode } from "react";
import { AutomationForm } from "./automation-form";
import { CronPicker } from "./cron-picker";

expect.extend(matchers);

afterEach(cleanup);

vi.mock("@/hooks/use-repos", () => ({
  useRepos: () => ({
    repos: [
      {
        id: 1,
        fullName: "open-inspect/background-agents",
        owner: "open-inspect",
        name: "background-agents",
        description: null,
        private: false,
        defaultBranch: "main",
      },
    ],
    loading: false,
  }),
}));

vi.mock("@/hooks/use-branches", () => ({
  useBranches: () => ({
    branches: [{ name: "main" }],
    loading: false,
  }),
}));

vi.mock("@/hooks/use-enabled-models", () => ({
  useEnabledModels: () => ({
    enabledModelOptions: [
      {
        category: "OpenAI",
        models: [{ id: "openai/gpt-5.4", name: "GPT-5.4", description: "Test model" }],
      },
    ],
  }),
}));

vi.mock("@/components/ui/combobox", () => ({
  Combobox: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

describe("automation cron submission", () => {
  it("clears the propagated cron when custom input becomes invalid", () => {
    const onChange = vi.fn();

    render(<CronPicker value="0 9 * * *" onChange={onChange} timezone="UTC" />);

    fireEvent.click(screen.getByLabelText("Custom"));
    fireEvent.change(screen.getByPlaceholderText("0 9 * * 1-5"), {
      target: { value: "not a cron" },
    });

    expect(onChange).toHaveBeenLastCalledWith("");
  });

  it("blocks submit when the visible custom cron is invalid", () => {
    const onSubmit = vi.fn();
    const { container } = render(
      <AutomationForm
        mode="create"
        submitting={false}
        onSubmit={onSubmit}
        initialValues={{
          name: "Daily review",
          repoOwner: "open-inspect",
          repoName: "background-agents",
          baseBranch: "main",
          model: "openai/gpt-5.4",
          scheduleCron: "0 9 * * *",
          scheduleTz: "UTC",
          instructions: "Review the repo.",
        }}
      />
    );

    fireEvent.click(screen.getByLabelText("Custom"));
    fireEvent.change(screen.getByPlaceholderText("0 9 * * 1-5"), {
      target: { value: "not a cron" },
    });

    expect(screen.getByRole("button", { name: "Create Automation" })).toBeDisabled();

    fireEvent.submit(container.querySelector("form")!);

    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("requires event type when trigger source exposes event type selector", () => {
    const onSubmit = vi.fn();
    const { container } = render(
      <AutomationForm
        mode="create"
        submitting={false}
        onSubmit={onSubmit}
        initialValues={{
          name: "Review new PRs",
          repoOwner: "open-inspect",
          repoName: "background-agents",
          baseBranch: "main",
          model: "openai/gpt-5.4",
          instructions: "Review incoming PRs for regressions.",
          triggerType: "github_event",
        }}
      />
    );

    expect(screen.getByRole("button", { name: "Create Automation" })).toBeDisabled();

    fireEvent.submit(container.querySelector("form")!);

    expect(screen.getByText("Event type is required.")).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

describe("instructions character counter", () => {
  const baseInitialValues = {
    name: "Daily review",
    repoOwner: "open-inspect",
    repoName: "background-agents",
    baseBranch: "main",
    model: "openai/gpt-5.4",
    scheduleCron: "0 9 * * *",
    scheduleTz: "UTC",
  };

  const renderForm = (instructions: string) =>
    render(
      <AutomationForm
        mode="edit"
        submitting={false}
        onSubmit={vi.fn()}
        initialValues={{ ...baseInitialValues, instructions }}
      />
    );

  it("shows current length and the 15,000 cap", () => {
    renderForm("hello");
    expect(screen.getByText("5 / 15,000")).toBeInTheDocument();
  });

  it("uses muted color well below the warning threshold", () => {
    renderForm("hello");
    const counter = screen.getByText("5 / 15,000");
    expect(counter).toHaveClass("text-muted-foreground");
    expect(counter).not.toHaveClass("text-warning");
    expect(counter).not.toHaveClass("text-destructive");
  });

  it("switches to warning color at 90% of the cap", () => {
    renderForm("a".repeat(13500));
    const counter = screen.getByText("13,500 / 15,000");
    expect(counter).toHaveClass("text-warning");
    expect(counter).not.toHaveClass("text-destructive");
  });

  it("switches to destructive color and shows a notice at the cap", () => {
    renderForm("a".repeat(15000));
    const counter = screen.getByText(/15,000 \/ 15,000/);
    expect(counter).toHaveClass("text-destructive");
    expect(counter).toHaveTextContent("Maximum length reached.");
  });
});
