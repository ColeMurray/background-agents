// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
import type { ComponentProps } from "react";
import type { AutomationListItem } from "@open-inspect/shared/types/automations";
import { AutomationsList } from "./automations-list";

expect.extend(matchers);
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

vi.mock("next/link", () => ({
  default: ({ children, ...props }: ComponentProps<"a">) => <a {...props}>{children}</a>,
}));

vi.mock("@/hooks/use-environments", () => ({
  useEnvironments: () => ({
    environments: [{ id: "env_1", name: "Fullstack", repositories: [] }],
    loading: false,
  }),
}));

const noop = () => {};

function makeAutomation(overrides: Partial<AutomationListItem> = {}): AutomationListItem {
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
    environmentIds: [],
    providerSelections: {},
    recentExecutions: [],
    ...overrides,
  };
}

describe("AutomationsList repository labels", () => {
  const renderList = (automations: AutomationListItem[]) =>
    render(
      <AutomationsList
        automations={automations}
        emptyState={{ kind: "no-automations" }}
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

describe("AutomationsList schedule metadata", () => {
  it("shows how long remains until the next scheduled run", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-09T12:00:00Z"));

    render(
      <AutomationsList
        automations={[makeAutomation({ nextRunAt: Date.now() + 2 * 60 * 60 * 1000 })]}
        emptyState={{ kind: "no-automations" }}
        onPause={noop}
        onResume={noop}
        onTrigger={noop}
        onDelete={noop}
      />
    );

    expect(screen.getByText("Next: in 2h")).toBeInTheDocument();
    expect(screen.getByText("Daily at 9 AM (UTC)")).toBeInTheDocument();
  });
});

describe("AutomationsList actions", () => {
  it("offers row actions from the compact menu", async () => {
    const onTrigger = vi.fn();
    render(
      <AutomationsList
        automations={[makeAutomation()]}
        emptyState={{ kind: "no-automations" }}
        onPause={noop}
        onResume={noop}
        onTrigger={onTrigger}
        onDelete={noop}
      />
    );

    fireEvent.pointerDown(screen.getByRole("button", { name: "Actions for Nightly review" }), {
      button: 0,
      ctrlKey: false,
    });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Trigger now" }));

    expect(onTrigger).toHaveBeenCalledWith("auto-1");
  });

  it("confirms deletion selected from the compact menu", async () => {
    const onDelete = vi.fn();
    render(
      <AutomationsList
        automations={[makeAutomation()]}
        emptyState={{ kind: "no-automations" }}
        onPause={noop}
        onResume={noop}
        onTrigger={noop}
        onDelete={onDelete}
      />
    );

    fireEvent.pointerDown(screen.getByRole("button", { name: "Actions for Nightly review" }), {
      button: 0,
      ctrlKey: false,
    });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Delete" }));
    expect(await screen.findByRole("alertdialog")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(onDelete).toHaveBeenCalledWith("auto-1");
  });
});

describe("AutomationsList execution activity", () => {
  it("shows recent execution statuses from oldest to newest", () => {
    render(
      <AutomationsList
        automations={[
          makeAutomation({
            recentExecutions: [
              { id: "inv-new", status: "failed", createdAt: 200 },
              { id: "inv-old", status: "completed", createdAt: 100 },
            ],
          }),
        ]}
        emptyState={{ kind: "no-automations" }}
        onPause={noop}
        onResume={noop}
        onTrigger={noop}
        onDelete={noop}
      />
    );

    const activity = screen.getByRole("list", {
      name: "Last 2 executions, oldest to newest",
    });
    expect(activity.children[0]).toHaveAttribute(
      "aria-label",
      expect.stringContaining("Completed")
    );
    expect(activity.children[1]).toHaveAttribute("aria-label", expect.stringContaining("Failed"));
    expect(activity.children[0]).toHaveAttribute("data-status-shape", "completed");
    expect(activity.children[1]).toHaveAttribute("data-status-shape", "failed");
    expect(activity.children[0]).toHaveAttribute("tabindex", "0");
  });

  it("shows an explicit empty history state", () => {
    render(
      <AutomationsList
        automations={[makeAutomation()]}
        emptyState={{ kind: "no-automations" }}
        onPause={noop}
        onResume={noop}
        onTrigger={noop}
        onDelete={noop}
      />
    );

    expect(screen.getByText("No runs")).toBeInTheDocument();
  });
});

describe("AutomationsList empty state", () => {
  it("offers a template path and a from-scratch path when there are no automations", () => {
    render(
      <AutomationsList
        automations={[]}
        emptyState={{ kind: "no-automations" }}
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

  it("describes an empty name search without showing creation prompts", () => {
    render(
      <AutomationsList
        automations={[]}
        emptyState={{ kind: "no-search-results", nameSearch: "release" }}
        onPause={noop}
        onResume={noop}
        onTrigger={noop}
        onDelete={noop}
      />
    );

    expect(screen.getByText('No automations match "release".')).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /create automation/i })).not.toBeInTheDocument();
  });
});
