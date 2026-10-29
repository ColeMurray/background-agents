// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as matchers from "@testing-library/jest-dom/matchers";
import type { ComponentProps } from "react";
import {
  DEFAULT_AUTOMATION_MAX_CONCURRENT_RUNS,
  type AutomationListItem,
} from "@open-inspect/shared/types/automations";
import { AutomationsList } from "./automations-list";

expect.extend(matchers);
afterEach(() => {
  cleanup();
  window.getSelection()?.removeAllRanges();
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
const CURRENT_USER_ID = "11111111111111111111111111111111";
const NO_CAPABILITIES = { canRead: false, canManage: false, canTrigger: false };

function makeAutomation(overrides: Partial<AutomationListItem> = {}): AutomationListItem {
  return {
    id: "auto-1",
    name: "Nightly review",
    instructions: "Review the repo.",
    harness: "opencode",
    triggerType: "schedule",
    scheduleCron: "0 9 * * *",
    scheduleOnceAt: null,
    scheduleTz: "UTC",
    model: "openai/gpt-5.4",
    reasoningEffort: null,
    enabled: true,
    maxConcurrentRuns: DEFAULT_AUTOMATION_MAX_CONCURRENT_RUNS,
    nextRunAt: null,
    consecutiveFailures: 0,
    maxRetries: 0,
    createdBy: "user-1",
    userId: CURRENT_USER_ID,
    ownerTeamId: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    deletedAt: null,
    eventType: null,
    triggerConfig: null,
    repositories: [{ repoOwner: "acme", repoName: "web-app", repoId: 1, baseBranch: "main" }],
    environmentIds: [],
    providerSelections: {},
    recentExecutions: [],
    capabilities: { canRead: true, canManage: true, canTrigger: true },
    ...overrides,
  };
}

describe("AutomationsList navigation", () => {
  it.each([
    ["acme/web-app", false, 1],
    ["acme/web-app", true, 1],
    ["acme/web-app", false, 0],
    ["acme/web-app", true, 0],
    ["Enabled", false, 1],
    ["Enabled", true, 1],
    ["Enabled", false, 0],
    ["Enabled", true, 0],
    ["No runs", false, 1],
    ["No runs", true, 1],
    ["No runs", false, 0],
    ["No runs", true, 0],
  ] as const)(
    "preserves native navigation for %s (selected=%s, click detail=%s)",
    (text, hasSelection, detail) => {
      render(
        <AutomationsList
          canCreate
          automations={[makeAutomation()]}
          emptyState={{ kind: "no-automations" }}
          onPause={noop}
          onResume={noop}
          onTrigger={noop}
          onDelete={noop}
        />
      );

      const content = screen.getByText(text);
      const link = content.closest("a")!;
      expect(link).toHaveAttribute("href", "/automations/auto-1");
      expect(link).toHaveAttribute("draggable", "false");
      if (hasSelection) {
        const range = document.createRange();
        range.selectNodeContents(content);
        window.getSelection()!.addRange(range);
      }

      let navigationPrevented: boolean | undefined;
      window.addEventListener(
        "click",
        (event) => {
          navigationPrevented = event.defaultPrevented;
          event.preventDefault();
        },
        { once: true }
      );
      fireEvent.click(link, { detail });
      expect(navigationPrevented).toBe(hasSelection && detail > 0);
    }
  );

  it.each([undefined, "team/one"])(
    "provides independent native row and title links with team scope %s",
    (teamId) => {
      render(
        <AutomationsList
          teamId={teamId}
          canCreate
          automations={[makeAutomation({ id: "auto/1" })]}
          emptyState={{ kind: "no-automations" }}
          onPause={noop}
          onResume={noop}
          onTrigger={noop}
          onDelete={noop}
        />
      );

      const rowLink = screen.getByRole("link", { name: "View Nightly review" });
      const titleLink = screen.getByRole("link", { name: "Nightly review" });
      const href = `/automations/auto%2F1${teamId ? "?teamId=team%2Fone" : ""}`;
      expect(rowLink).toHaveAttribute("href", href);
      expect(titleLink).toHaveAttribute("href", href);
      expect(rowLink).not.toContainElement(titleLink);
      expect(rowLink).not.toContainElement(screen.getByRole("button", { name: "Pause" }));

      const onRowClick = vi.fn();
      rowLink.addEventListener("click", onRowClick);
      titleLink.addEventListener("click", (event) => event.preventDefault(), { once: true });
      fireEvent.click(titleLink);
      expect(onRowClick).not.toHaveBeenCalled();
    }
  );
});

describe("AutomationsList repository labels", () => {
  const renderList = (automations: AutomationListItem[]) =>
    render(
      <AutomationsList
        canCreate
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
  it.each(["UTC", "America/Los_Angeles"])(
    "describes a one-shot in its configured %s timezone with a zone label",
    (scheduleTz) => {
      const at = new Date("2099-01-01T09:00:00Z").getTime();
      render(
        <AutomationsList
          canCreate
          automations={[
            makeAutomation({ scheduleCron: null, scheduleOnceAt: at, nextRunAt: at, scheduleTz }),
          ]}
          emptyState={{ kind: "no-automations" }}
          onPause={noop}
          onResume={noop}
          onTrigger={noop}
          onDelete={noop}
        />
      );
      const expectedTime = new Date(at).toLocaleString(undefined, {
        timeZone: scheduleTz,
        timeZoneName: "short",
      });
      expect(screen.getAllByText(`Once at ${expectedTime}`).length).toBeGreaterThan(0);
    }
  );

  it("shows how long remains until the next scheduled run", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-09T12:00:00Z"));

    render(
      <AutomationsList
        canCreate
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
  const renderListWithActions = (automation: AutomationListItem) =>
    render(
      <AutomationsList
        canCreate
        automations={[automation]}
        emptyState={{ kind: "no-automations" }}
        onPause={noop}
        onResume={noop}
        onTrigger={noop}
        onDelete={noop}
      />
    );

  it("disables controls without capabilities, regardless of ownership", () => {
    render(
      <AutomationsList
        canCreate
        automations={[
          makeAutomation({
            createdBy: CURRENT_USER_ID,
            userId: "22222222222222222222222222222222",
            capabilities: NO_CAPABILITIES,
          }),
        ]}
        emptyState={{ kind: "no-automations" }}
        onPause={noop}
        onResume={noop}
        onTrigger={noop}
        onDelete={noop}
      />
    );

    expect(screen.queryByRole("button", { name: "Pause" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Trigger" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Delete" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /actions for/i })).not.toBeInTheDocument();
  });

  it("gates manage and trigger controls independently", () => {
    renderListWithActions(
      makeAutomation({
        userId: null,
        capabilities: { canRead: true, canManage: true, canTrigger: false },
      })
    );

    expect(screen.getByRole("button", { name: "Pause" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Trigger" })).not.toBeInTheDocument();
  });

  it("offers row actions from the compact menu", async () => {
    const onTrigger = vi.fn();
    render(
      <AutomationsList
        canCreate
        automations={[makeAutomation()]}
        emptyState={{ kind: "no-automations" }}
        onPause={noop}
        onResume={noop}
        onTrigger={onTrigger}
        onDelete={noop}
      />
    );

    const onRowClick = vi.fn();
    screen.getByRole("link", { name: "View Nightly review" }).addEventListener("click", onRowClick);
    fireEvent.pointerDown(screen.getByRole("button", { name: "Actions for Nightly review" }), {
      button: 0,
      ctrlKey: false,
    });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Trigger now" }));

    expect(onTrigger).toHaveBeenCalledWith("auto-1");
    expect(onRowClick).not.toHaveBeenCalled();
  });

  it.each([true, false])("keeps desktop actions independent when enabled is %s", (enabled) => {
    const onPause = vi.fn();
    const onResume = vi.fn();
    const onTrigger = vi.fn();
    const onDelete = vi.fn();
    render(
      <AutomationsList
        canCreate
        automations={[makeAutomation({ enabled })]}
        emptyState={{ kind: "no-automations" }}
        onPause={onPause}
        onResume={onResume}
        onTrigger={onTrigger}
        onDelete={onDelete}
      />
    );

    const onRowClick = vi.fn();
    screen.getByRole("link", { name: "View Nightly review" }).addEventListener("click", onRowClick);
    fireEvent.click(screen.getByRole("button", { name: enabled ? "Pause" : "Resume" }));
    fireEvent.click(screen.getByRole("button", { name: "Trigger" }).querySelector("svg")!);
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    expect(enabled ? onPause : onResume).toHaveBeenCalledWith("auto-1");
    expect(onTrigger).toHaveBeenCalledWith("auto-1");
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    expect(onDelete).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(onDelete).not.toHaveBeenCalled();
    expect(onRowClick).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    fireEvent.click(
      within(screen.getByRole("alertdialog")).getByRole("button", { name: "Delete" })
    );
    expect(onDelete).toHaveBeenCalledExactlyOnceWith("auto-1");
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(onRowClick).not.toHaveBeenCalled();
  });

  it("confirms deletion selected from the compact menu", async () => {
    const onDelete = vi.fn();
    render(
      <AutomationsList
        canCreate
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
  it.each([false, true])("names each automation's activity links (history=%s)", (hasHistory) => {
    const recentExecutions: AutomationListItem["recentExecutions"] = hasHistory
      ? [{ id: "inv-1", status: "completed", createdAt: 100 }]
      : [];
    const automations = [
      makeAutomation({ recentExecutions }),
      makeAutomation({ id: "auto-2", name: "Release checks", recentExecutions }),
    ];
    render(
      <AutomationsList
        canCreate
        automations={automations}
        emptyState={{ kind: "no-automations" }}
        onPause={noop}
        onResume={noop}
        onTrigger={noop}
        onDelete={noop}
      />
    );

    for (const automation of automations) {
      const name = hasHistory
        ? `Completed, ${new Date(100).toLocaleString()}, ${automation.name}`
        : `No runs for ${automation.name}`;
      expect(screen.getByRole("link", { name })).toHaveAttribute(
        "href",
        `/automations/${automation.id}`
      );
    }
  });

  it.each([
    [undefined, false],
    [undefined, true],
    ["team/one & two", false],
    ["team/one & two", true],
  ] as const)("links activity to the detail page (team=%s, history=%s)", (teamId, hasHistory) => {
    render(
      <AutomationsList
        teamId={teamId}
        canCreate
        automations={[
          makeAutomation({
            id: "auto/1 ?",
            recentExecutions: hasHistory
              ? [
                  { id: "inv-new", status: "failed", createdAt: 200 },
                  { id: "inv-old", status: "completed", createdAt: 100 },
                ]
              : [],
          }),
        ]}
        emptyState={{ kind: "no-automations" }}
        onPause={noop}
        onResume={noop}
        onTrigger={noop}
        onDelete={noop}
      />
    );

    const links = hasHistory
      ? within(screen.getByRole("list")).getAllByRole("link")
      : [screen.getByRole("link", { name: "No runs for Nightly review" })];
    expect(links).toHaveLength(hasHistory ? 2 : 1);
    const href = `/automations/auto%2F1%20%3F${teamId ? "?teamId=team%2Fone+%26+two" : ""}`;
    const rowLink = screen.getByRole("link", { name: "View Nightly review" });
    expect(rowLink).toHaveAttribute("href", href);
    for (const link of links) {
      expect(link).toHaveAttribute("href", href);
      expect(link).toHaveAttribute("draggable", "false");
      expect(link.tabIndex).toBe(0);
      expect(link.querySelector("a, button, [tabindex]")).toBeNull();
      expect(rowLink).not.toContainElement(link);
    }
    if (hasHistory) {
      expect(links[0]).toHaveAccessibleName(/^Completed,/);
      expect(links[1]).toHaveAccessibleName(/^Failed,/);
      expect(screen.getByRole("list").querySelector("li[tabindex]")).toBeNull();
    }
  });

  it.each([
    [false, 1],
    [true, 1],
    [false, 0],
    [true, 0],
  ] as const)(
    "preserves native marker navigation (selected=%s, click detail=%s)",
    (hasSelection, detail) => {
      render(
        <AutomationsList
          canCreate
          automations={[
            makeAutomation({
              recentExecutions: [{ id: "inv-1", status: "completed", createdAt: 100 }],
            }),
          ]}
          emptyState={{ kind: "no-automations" }}
          onPause={noop}
          onResume={noop}
          onTrigger={noop}
          onDelete={noop}
        />
      );
      if (hasSelection) {
        const range = document.createRange();
        range.selectNodeContents(screen.getByText("Nightly review"));
        window.getSelection()!.addRange(range);
      }
      let navigationPrevented: boolean | undefined;
      window.addEventListener(
        "click",
        (event) => {
          navigationPrevented = event.defaultPrevented;
          event.preventDefault();
        },
        { once: true }
      );
      const link = screen.getByRole("link", { name: /^Completed,/ });
      fireEvent.click(link.firstElementChild!, { detail, ctrlKey: true });
      expect(navigationPrevented).toBe(hasSelection && detail > 0);
    }
  );

  it("tabs directly between marker links and activates a focused marker with Enter", async () => {
    const user = userEvent.setup();
    render(
      <AutomationsList
        canCreate
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
    screen.getByRole("link", { name: "Enabled" }).focus();
    await user.tab();
    expect(screen.getByRole("link", { name: /^Completed,/ })).toHaveFocus();
    await user.tab();
    const failedLink = screen.getByRole("link", { name: /^Failed,/ });
    expect(failedLink).toHaveFocus();
    const onNavigate = vi.fn((event: Event) => {
      expect(event.defaultPrevented).toBe(false);
      event.preventDefault();
    });
    window.addEventListener("click", onNavigate, { once: true });
    await user.keyboard("{Enter}");
    expect(onNavigate).toHaveBeenCalledOnce();
    expect(onNavigate.mock.calls[0][0].target).toBe(failedLink);
  });

  it("renders an unauthorized execution as a terminal denial with an accessible label", () => {
    render(
      <AutomationsList
        canCreate
        automations={[
          makeAutomation({
            recentExecutions: [{ id: "inv-denied", status: "unauthorized", createdAt: 100 }],
          }),
        ]}
        emptyState={{ kind: "no-automations" }}
        onPause={noop}
        onResume={noop}
        onTrigger={noop}
        onDelete={noop}
      />
    );

    const execution = screen.getByRole("listitem");
    const link = within(execution).getByRole("link", { name: /^Unauthorized,/ });
    expect(execution).not.toHaveAccessibleName();
    expect(link).toHaveAttribute("title", expect.stringContaining("Unauthorized"));
    expect(execution).toHaveAttribute("data-status-shape", "unauthorized");
    expect(link.firstElementChild).toHaveAttribute("class", "h-px w-2 bg-current");
    expect(execution).not.toHaveAttribute("tabindex");
  });

  it("shows recent execution statuses from oldest to newest", () => {
    render(
      <AutomationsList
        canCreate
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
    const executions = within(activity).getAllByRole("listitem");
    expect(executions[0]).not.toHaveAccessibleName();
    expect(executions[1]).not.toHaveAccessibleName();
    const occurredAt = new Date(100).toLocaleString();
    expect(within(executions[0]).getByRole("link")).toHaveAccessibleName(
      `Completed, ${occurredAt}, Nightly review`
    );
    expect(within(executions[1]).getByRole("link")).toHaveAccessibleName(
      `Failed, ${new Date(200).toLocaleString()}, Nightly review`
    );
    expect(activity.children[0]).toHaveAttribute("data-status-shape", "completed");
    expect(activity.children[1]).toHaveAttribute("data-status-shape", "failed");
    expect(activity.children[0]).not.toHaveAttribute("tabindex");
  });

  it("shows an explicit empty history state", () => {
    render(
      <AutomationsList
        canCreate
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
        canCreate
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

  it("hides creation entry points when creation is not allowed", () => {
    render(
      <AutomationsList
        canCreate={false}
        automations={[]}
        emptyState={{ kind: "no-automations" }}
        onPause={noop}
        onResume={noop}
        onTrigger={noop}
        onDelete={noop}
      />
    );

    expect(screen.queryByRole("link", { name: /template/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /create automation/i })).not.toBeInTheDocument();
  });

  it("describes an empty name search without showing creation prompts", () => {
    render(
      <AutomationsList
        canCreate
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
