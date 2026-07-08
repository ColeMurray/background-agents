// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
import type { ComponentProps } from "react";
import type { Automation } from "@open-inspect/shared";
import { AutomationsList } from "./automations-list";

expect.extend(matchers);
afterEach(cleanup);

vi.mock("next/link", () => ({
  default: ({ children, ...props }: ComponentProps<"a">) => <a {...props}>{children}</a>,
}));

const noop = () => {};

function makeAutomation(overrides: Partial<Automation> = {}): Automation {
  return {
    id: "auto-1",
    name: "Nightly review",
    instructions: "Review the repo.",
    triggerType: "schedule",
    scheduleCron: "0 9 * * *",
    scheduleTz: "UTC",
    model: "openai/gpt-5.4",
    reasoningEffort: null,
    enabled: true,
    nextRunAt: null,
    consecutiveFailures: 0,
    createdBy: "user-1",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    deletedAt: null,
    eventType: null,
    triggerConfig: null,
    repositories: [{ repoOwner: "acme", repoName: "web-app", repoId: 1, baseBranch: "main" }],
    ...overrides,
  };
}

describe("AutomationsList repository labels", () => {
  const renderList = (automations: Automation[]) =>
    render(
      <AutomationsList
        automations={automations}
        onPause={noop}
        onResume={noop}
        onTrigger={noop}
        onDelete={noop}
      />
    );

  it("shows the repository name for a single-repository automation", () => {
    renderList([makeAutomation()]);
    expect(screen.getByText("acme/web-app")).toBeInTheDocument();
  });

  it("shows a count for a multi-repository automation", () => {
    renderList([
      makeAutomation({
        repositories: [
          { repoOwner: "acme", repoName: "web-app", repoId: 1, baseBranch: "main" },
          { repoOwner: "acme", repoName: "api", repoId: 2, baseBranch: "main" },
          { repoOwner: "acme", repoName: "docs", repoId: 3, baseBranch: "main" },
        ],
      }),
    ]);
    expect(screen.getByText("3 repositories")).toBeInTheDocument();
  });

  it("shows the repo-less label when no repository is selected", () => {
    renderList([
      makeAutomation({
        repositories: [],
      }),
    ]);
    expect(screen.getByText("No repository")).toBeInTheDocument();
  });
});

describe("AutomationsList empty state", () => {
  it("offers a template path and a from-scratch path when there are no automations", () => {
    render(
      <AutomationsList
        automations={[]}
        onPause={noop}
        onResume={noop}
        onTrigger={noop}
        onDelete={noop}
      />
    );

    expect(screen.getByRole("link", { name: /start from a template/i })).toHaveAttribute(
      "href",
      "/automations/templates"
    );
    expect(screen.getByRole("link", { name: /create automation/i })).toHaveAttribute(
      "href",
      "/automations/new"
    );
  });
});
