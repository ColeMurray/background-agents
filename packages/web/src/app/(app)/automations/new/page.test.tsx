// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
import type { ReactNode } from "react";
import { DEFAULT_MODEL } from "@open-inspect/shared";
import NewAutomationPage from "./page";

expect.extend(matchers);
afterEach(cleanup);

// Mutable per-test inputs (vi.mock factories are hoisted, so they close over these).
let search = "";
let enabledModelsValue: string[] = [DEFAULT_MODEL, "anthropic/claude-opus-4-8", "openai/gpt-5.5"];

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(search),
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock("@/components/sidebar-layout", () => ({
  useSidebarContext: () => ({ isOpen: true, toggle: vi.fn() }),
}));

vi.mock("@/hooks/use-repos", () => ({
  useRepos: () => ({ repos: [], loading: false }),
}));

vi.mock("@/hooks/use-branches", () => ({
  useBranches: () => ({ branches: [], loading: false }),
}));

vi.mock("@/hooks/use-enabled-models", () => ({
  useEnabledModels: () => ({
    enabledModels: enabledModelsValue,
    enabledModelOptions: [
      {
        category: "Anthropic",
        models: [{ id: DEFAULT_MODEL, name: "Claude Sonnet 4.6", description: "" }],
      },
    ],
    loading: false,
  }),
}));

// Mirror the form's own test: render the combobox trigger contents so we can
// read the displayed repository / model without driving the dropdown.
vi.mock("@/components/ui/combobox", () => ({
  Combobox: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

beforeEach(() => {
  search = "";
  enabledModelsValue = [DEFAULT_MODEL, "anthropic/claude-opus-4-8", "openai/gpt-5.5"];
});

describe("NewAutomationPage template pre-fill", () => {
  it("pre-fills the form from a known template and leaves the repository empty", () => {
    search = "template=find-bugs";
    render(<NewAutomationPage />);

    expect(screen.getByDisplayValue("Find bugs")).toBeInTheDocument();
    expect(screen.getByDisplayValue(/Review the most recent commits/)).toBeInTheDocument();
    // Repository is intentionally not pre-filled.
    expect(screen.getAllByText("No repository").length).toBeGreaterThan(0);
    expect(screen.getByText("Select one repository.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create Automation" })).toBeDisabled();
    // A hint tells the user the form was prefilled from a template.
    expect(screen.getByText(/prefilled from/i)).toBeInTheDocument();
  });

  it("renders the blank create form for an unknown template id", () => {
    search = "template=does-not-exist";
    render(<NewAutomationPage />);

    const nameInput = screen.getByPlaceholderText("Daily code review") as HTMLInputElement;
    expect(nameInput.value).toBe("");
    expect(screen.queryByDisplayValue("Find bugs")).not.toBeInTheDocument();
    expect(screen.queryByText(/prefilled from/i)).not.toBeInTheDocument();
  });

  it("renders the blank create form when no template param is present", () => {
    search = "";
    render(<NewAutomationPage />);

    const nameInput = screen.getByPlaceholderText("Daily code review") as HTMLInputElement;
    expect(nameInput.value).toBe("");
  });

  it("coerces an unenabled suggested model to an enabled one", () => {
    // scan-vulnerabilities suggests anthropic/claude-opus-4-8; exclude it.
    enabledModelsValue = [DEFAULT_MODEL];
    search = "template=scan-vulnerabilities";
    render(<NewAutomationPage />);

    expect(screen.getByDisplayValue("Scan codebase for vulnerabilities")).toBeInTheDocument();
    // Falls back to the enabled default model rather than the unenabled suggestion.
    expect(screen.getByText("claude sonnet 4.6")).toBeInTheDocument();
    expect(screen.queryByText("claude opus 4.8")).not.toBeInTheDocument();
  });
});
