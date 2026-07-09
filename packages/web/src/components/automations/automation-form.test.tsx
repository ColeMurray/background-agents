// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
import type { ReactNode } from "react";
import { DEFAULT_MODEL, MAX_AUTOMATION_REPOSITORIES } from "@open-inspect/shared";
import { AutomationForm, type AutomationFormValues } from "./automation-form";
import { CronPicker } from "./cron-picker";

expect.extend(matchers);

afterEach(cleanup);

interface MockRepo {
  id: number;
  fullName: string;
  owner: string;
  name: string;
  description: string | null;
  private: boolean;
  defaultBranch: string;
}

function mockRepo(id: number, owner: string, name: string, defaultBranch = "main"): MockRepo {
  return {
    id,
    fullName: `${owner}/${name}`,
    owner,
    name,
    description: null,
    private: false,
    defaultBranch,
  };
}

// Mutable per-test hook results; the hoisted mocks close over them.
let enabledModelsValue: string[] = ["openai/gpt-5.4"];
let loadingModelsValue = false;
let reposValue: MockRepo[] = [];
let environmentsValue: Array<{
  id: string;
  name: string;
  repositories: Array<{ repoOwner: string; repoName: string }>;
}> = [];
beforeEach(() => {
  enabledModelsValue = ["openai/gpt-5.4"];
  loadingModelsValue = false;
  environmentsValue = [];
  reposValue = [
    mockRepo(1, "open-inspect", "background-agents"),
    mockRepo(2, "open-inspect", "control-plane", "develop"),
    mockRepo(3, "Acme", "Web-App"),
  ];
});

vi.mock("@/hooks/use-repos", () => ({
  useRepos: () => ({
    repos: reposValue,
    loading: false,
  }),
}));

vi.mock("@/hooks/use-environments", () => ({
  useEnvironments: () => ({
    environments: environmentsValue,
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
    enabledModels: enabledModelsValue,
    enabledModelOptions: [
      {
        category: "OpenAI",
        models: [{ id: "openai/gpt-5.4", name: "GPT-5.4", description: "Test model" }],
      },
    ],
    loading: loadingModelsValue,
  }),
}));

// The SlackChannelPicker (rendered for slack_channel conditions) lists channels via
// useSession-backed SWR. The form tests don't exercise channel listing, so stub it out
// to avoid needing a SessionProvider.
vi.mock("@/hooks/use-slack-channels", () => ({
  useSlackChannels: () => ({ channels: [], loading: false }),
}));

vi.mock("@/components/ui/combobox", () => ({
  Combobox: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

const singleRepository = [
  { repoOwner: "open-inspect", repoName: "background-agents", baseBranch: "main" },
];

const openRepositoryPicker = () =>
  fireEvent.click(screen.getByRole("button", { name: "Repository selection" }));

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
          repositories: singleRepository,
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
          repositories: singleRepository,
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

  it("submits triggerConfig with empty conditions for non-schedule automations", () => {
    const onSubmit = vi.fn();
    const { container } = render(
      <AutomationForm
        mode="edit"
        submitting={false}
        onSubmit={onSubmit}
        initialValues={{
          name: "Review PRs",
          repositories: singleRepository,
          model: "openai/gpt-5.4",
          instructions: "Review incoming PRs.",
          triggerType: "github_event",
          eventType: "pull_request.opened",
          triggerConfig: { conditions: [] },
        }}
      />
    );

    fireEvent.submit(container.querySelector("form")!);

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0][0]).toMatchObject({
      triggerConfig: { conditions: [] },
    });
  });
});

describe("environment binding", () => {
  const scheduleBase = {
    name: "Workspace review",
    model: "openai/gpt-5.4",
    scheduleCron: "0 9 * * 1",
    scheduleTz: "UTC",
    instructions: "Review the workspace.",
  };
  const fullstackEnvironment = {
    id: "env_1",
    name: "Fullstack",
    repositories: [
      { repoOwner: "acme", repoName: "web-app" },
      { repoOwner: "acme", repoName: "api" },
    ],
  };

  it("submits the selected environment in single-select mode", () => {
    environmentsValue = [fullstackEnvironment];
    const onSubmit = vi.fn();
    const { container } = render(
      <AutomationForm
        mode="create"
        submitting={false}
        onSubmit={onSubmit}
        initialValues={scheduleBase}
      />
    );

    openRepositoryPicker();
    fireEvent.click(screen.getByRole("button", { name: /Fullstack/ }));
    fireEvent.submit(container.querySelector("form")!);

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0][0]).toMatchObject({
      environmentIds: ["env_1"],
      repositories: [],
    });
  });

  it("replaces an environment with a repository in single-select mode", () => {
    environmentsValue = [fullstackEnvironment];
    const onSubmit = vi.fn();
    const { container } = render(
      <AutomationForm
        mode="edit"
        submitting={false}
        onSubmit={onSubmit}
        initialValues={{ ...scheduleBase, environmentIds: ["env_1"] }}
      />
    );

    openRepositoryPicker();
    fireEvent.click(screen.getByRole("button", { name: "open-inspect/control-plane" }));
    fireEvent.submit(container.querySelector("form")!);

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0][0]).toMatchObject({
      environmentIds: [],
      repositories: [
        { repoOwner: "open-inspect", repoName: "control-plane", baseBranch: "develop" },
      ],
    });
  });

  it("fans out repositories and environments together in multi-select mode", () => {
    environmentsValue = [fullstackEnvironment];
    const onSubmit = vi.fn();
    const { container } = render(
      <AutomationForm
        mode="create"
        submitting={false}
        onSubmit={onSubmit}
        initialValues={scheduleBase}
      />
    );

    openRepositoryPicker();
    fireEvent.click(screen.getByRole("button", { name: "Select Multiple" }));
    fireEvent.click(screen.getByLabelText("open-inspect/background-agents"));
    fireEvent.click(screen.getByLabelText(/Fullstack/));
    fireEvent.submit(container.querySelector("form")!);

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0][0]).toMatchObject({
      environmentIds: ["env_1"],
      repositories: [{ repoOwner: "open-inspect", repoName: "background-agents" }],
    });
  });

  it("hides environments for repo-scoped triggers", () => {
    environmentsValue = [fullstackEnvironment];
    render(
      <AutomationForm
        mode="create"
        submitting={false}
        onSubmit={vi.fn()}
        initialValues={{
          ...scheduleBase,
          triggerType: "github_event",
          eventType: "pull_request.opened",
          repositories: singleRepository,
        }}
      />
    );

    openRepositoryPicker();
    expect(screen.queryByText("Environments")).not.toBeInTheDocument();
    expect(screen.queryByText(/Fullstack/)).not.toBeInTheDocument();
  });
});

describe("repository selection", () => {
  const scheduleBase = {
    name: "Weekly review",
    model: "openai/gpt-5.4",
    scheduleCron: "0 9 * * 1",
    scheduleTz: "UTC",
    instructions: "Review the repos.",
  };

  it("submits an empty repository selection for repo-less automations", () => {
    const onSubmit = vi.fn();
    const { container } = render(
      <AutomationForm
        mode="create"
        submitting={false}
        onSubmit={onSubmit}
        initialValues={scheduleBase}
      />
    );

    // The picker defaults to no repository, which is a valid schedule selection.
    expect(screen.getByText("No repository")).toBeInTheDocument();
    expect(
      screen.getByText("Select no repository, one repository, or one environment.")
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create Automation" })).toBeEnabled();

    fireEvent.submit(container.querySelector("form")!);

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0][0].repositories).toEqual([]);
  });

  it("submits the selected repository with its default branch", () => {
    const onSubmit = vi.fn();
    const { container } = render(
      <AutomationForm
        mode="create"
        submitting={false}
        onSubmit={onSubmit}
        initialValues={scheduleBase}
      />
    );

    openRepositoryPicker();
    fireEvent.click(screen.getByRole("button", { name: "open-inspect/control-plane" }));
    fireEvent.submit(container.querySelector("form")!);

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0][0].repositories).toEqual([
      { repoOwner: "open-inspect", repoName: "control-plane", baseBranch: "develop" },
    ]);
  });

  it("lowercases repository identifiers on submit, matching the API contract", () => {
    const onSubmit = vi.fn();
    const { container } = render(
      <AutomationForm
        mode="create"
        submitting={false}
        onSubmit={onSubmit}
        initialValues={scheduleBase}
      />
    );

    openRepositoryPicker();
    fireEvent.click(screen.getByRole("button", { name: "Acme/Web-App" }));
    fireEvent.submit(container.querySelector("form")!);

    expect(onSubmit.mock.calls[0][0].repositories).toEqual([
      { repoOwner: "acme", repoName: "web-app", baseBranch: "main" },
    ]);
  });

  it("replaces the previous choice while multi-select is off", () => {
    const onSubmit = vi.fn();
    const { container } = render(
      <AutomationForm
        mode="create"
        submitting={false}
        onSubmit={onSubmit}
        initialValues={scheduleBase}
      />
    );

    openRepositoryPicker();
    fireEvent.click(screen.getByRole("button", { name: "open-inspect/background-agents" }));
    openRepositoryPicker();
    fireEvent.click(screen.getByRole("button", { name: "open-inspect/control-plane" }));
    fireEvent.submit(container.querySelector("form")!);

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0][0].repositories).toEqual([
      { repoOwner: "open-inspect", repoName: "control-plane", baseBranch: "develop" },
    ]);
  });

  it("submits multiple repositories after enabling multi-select", () => {
    const onSubmit = vi.fn();
    const { container } = render(
      <AutomationForm
        mode="create"
        submitting={false}
        onSubmit={onSubmit}
        initialValues={scheduleBase}
      />
    );

    openRepositoryPicker();
    fireEvent.click(screen.getByRole("button", { name: "Select Multiple" }));
    fireEvent.click(screen.getByLabelText("open-inspect/background-agents"));
    fireEvent.click(screen.getByLabelText("open-inspect/control-plane"));
    fireEvent.submit(container.querySelector("form")!);

    expect(screen.getByRole("button", { name: "Select One" })).toBeInTheDocument();
    expect(onSubmit).toHaveBeenCalledTimes(1);
    // New multi-repo entries carry no branch; the server resolves each repo's default.
    expect(onSubmit.mock.calls[0][0].repositories).toEqual([
      { repoOwner: "open-inspect", repoName: "background-agents" },
      { repoOwner: "open-inspect", repoName: "control-plane" },
    ]);
  });

  it("always sends the full selection in edit mode, even when untouched", () => {
    const onSubmit = vi.fn();
    const { container } = render(
      <AutomationForm
        mode="edit"
        submitting={false}
        onSubmit={onSubmit}
        initialValues={{ ...scheduleBase, triggerType: "schedule", repositories: singleRepository }}
      />
    );

    fireEvent.submit(container.querySelector("form")!);

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0][0].repositories).toEqual([
      { repoOwner: "open-inspect", repoName: "background-agents", baseBranch: "main" },
    ]);
  });

  it("submits an empty selection when edit mode clears the repository", () => {
    const onSubmit = vi.fn();
    const { container } = render(
      <AutomationForm
        mode="edit"
        submitting={false}
        onSubmit={onSubmit}
        initialValues={{ ...scheduleBase, triggerType: "schedule", repositories: singleRepository }}
      />
    );

    openRepositoryPicker();
    fireEvent.click(screen.getByRole("button", { name: "No repository" }));
    fireEvent.submit(container.querySelector("form")!);

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0][0].repositories).toEqual([]);
  });

  it("preserves each repository's stored branch on multi-repo edits", () => {
    const onSubmit = vi.fn();
    const { container } = render(
      <AutomationForm
        mode="edit"
        submitting={false}
        onSubmit={onSubmit}
        initialValues={{
          ...scheduleBase,
          triggerType: "schedule",
          repositories: [
            { repoOwner: "open-inspect", repoName: "background-agents", baseBranch: "release" },
            { repoOwner: "open-inspect", repoName: "control-plane", baseBranch: "develop" },
          ],
        }}
      />
    );

    fireEvent.submit(container.querySelector("form")!);

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0][0].repositories).toEqual([
      { repoOwner: "open-inspect", repoName: "background-agents", baseBranch: "release" },
      { repoOwner: "open-inspect", repoName: "control-plane", baseBranch: "develop" },
    ]);
  });

  it("requires exactly one repository for GitHub event automations", () => {
    render(
      <AutomationForm
        mode="create"
        submitting={false}
        onSubmit={vi.fn()}
        initialValues={{
          name: "Review new PRs",
          model: "openai/gpt-5.4",
          instructions: "Review incoming PRs.",
        }}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /GitHub Event/ }));

    expect(
      screen.getByText("Repository-scoped triggers need exactly one repository.")
    ).toBeInTheDocument();
    // No selection yet, so the form can't be submitted.
    expect(screen.getByRole("button", { name: "Create Automation" })).toBeDisabled();

    openRepositoryPicker();
    // Repo-less and multi-repo choices are unavailable for repo-scoped triggers.
    expect(screen.getByRole("button", { name: "No repository" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Select Multiple" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "open-inspect/background-agents" }));
    expect(screen.getByRole("button", { name: "Create Automation" })).toBeDisabled(); // still needs event type
  });

  it("collapses a multi-selection back to one repository when multi-select is turned off", () => {
    render(
      <AutomationForm
        mode="create"
        submitting={false}
        onSubmit={vi.fn()}
        initialValues={scheduleBase}
      />
    );

    openRepositoryPicker();
    fireEvent.click(screen.getByRole("button", { name: "Select Multiple" }));
    fireEvent.click(screen.getByLabelText("open-inspect/background-agents"));
    fireEvent.click(screen.getByLabelText("open-inspect/control-plane"));
    expect(screen.getByText("2 repositories")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Select One" }));

    expect(screen.queryByText("2 repositories")).not.toBeInTheDocument();
    expect(screen.getAllByText("open-inspect/background-agents").length).toBeGreaterThan(0);
  });

  it("caps the multi-selection at the shared repository maximum", () => {
    reposValue = Array.from({ length: MAX_AUTOMATION_REPOSITORIES + 1 }, (_, index) =>
      mockRepo(index + 1, "acme", `repo-${index + 1}`)
    );
    render(
      <AutomationForm
        mode="create"
        submitting={false}
        onSubmit={vi.fn()}
        initialValues={scheduleBase}
      />
    );

    openRepositoryPicker();
    fireEvent.click(screen.getByRole("button", { name: "Select Multiple" }));
    for (let index = 1; index <= MAX_AUTOMATION_REPOSITORIES; index++) {
      fireEvent.click(screen.getByLabelText(`acme/repo-${index}`));
    }

    expect(
      screen.getByText(`${MAX_AUTOMATION_REPOSITORIES}/${MAX_AUTOMATION_REPOSITORIES}`)
    ).toBeInTheDocument();
    expect(screen.getByLabelText(`acme/repo-${MAX_AUTOMATION_REPOSITORIES + 1}`)).toBeDisabled();
  });
});

describe("slack_event automation", () => {
  const slackBase = {
    name: "Triage Slack reports",
    repositories: singleRepository,
    model: "openai/gpt-5.4",
    instructions: "Triage the reported issue.",
    triggerType: "slack_event" as const,
  };

  const validConditions = {
    conditions: [
      { type: "slack_channel" as const, operator: "any_of" as const, value: ["C1"] },
      { type: "text_match" as const, operator: "contains" as const, value: { pattern: "deploy" } },
    ],
  };

  it("blocks submit until a slack_channel condition exists", () => {
    const onSubmit = vi.fn();
    const { container } = render(
      <AutomationForm
        mode="edit"
        submitting={false}
        onSubmit={onSubmit}
        initialValues={{ ...slackBase, triggerConfig: { conditions: [] } }}
      />
    );

    expect(screen.getByRole("button", { name: "Save Changes" })).toBeDisabled();
    fireEvent.submit(container.querySelector("form")!);
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByText(/require at least one Slack Channel/)).toBeInTheDocument();
  });

  it("submits a valid slack_event", () => {
    const onSubmit = vi.fn();
    const { container } = render(
      <AutomationForm
        mode="edit"
        submitting={false}
        onSubmit={onSubmit}
        initialValues={{ ...slackBase, triggerConfig: validConditions }}
      />
    );

    fireEvent.submit(container.querySelector("form")!);

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0][0]).toMatchObject({
      triggerType: "slack_event",
      triggerConfig: validConditions,
    });
  });

  it("submits a slack_event with only a slack_channel condition (no text_match)", () => {
    const onSubmit = vi.fn();
    const channelOnly = {
      conditions: [{ type: "slack_channel" as const, operator: "any_of" as const, value: ["C1"] }],
    };
    const { container } = render(
      <AutomationForm
        mode="edit"
        submitting={false}
        onSubmit={onSubmit}
        initialValues={{ ...slackBase, triggerConfig: channelOnly }}
      />
    );

    fireEvent.submit(container.querySelector("form")!);

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0][0]).toMatchObject({ triggerConfig: channelOnly });
  });
});

describe("instructions character counter", () => {
  const baseInitialValues = {
    name: "Daily review",
    repositories: singleRepository,
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

describe("model normalization", () => {
  const baseInitialValues = {
    name: "Daily review",
    repositories: singleRepository,
    model: "openai/gpt-5.4",
    scheduleCron: "0 9 * * *",
    scheduleTz: "UTC",
    instructions: "Review the repo.",
    triggerType: "schedule" as const,
  };

  const submitForm = (initialValues: Partial<AutomationFormValues>) => {
    const onSubmit = vi.fn();
    const { container } = render(
      <AutomationForm
        mode="edit"
        submitting={false}
        onSubmit={onSubmit}
        initialValues={{ ...baseInitialValues, ...initialValues }}
      />
    );
    fireEvent.submit(container.querySelector("form")!);
    return onSubmit;
  };

  it("coerces a disabled initial model to an enabled one before submit", () => {
    const onSubmit = submitForm({ model: "anthropic/claude-opus-4-8" });
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0][0].model).toBe("openai/gpt-5.4");
  });

  it("leaves an enabled initial model untouched", () => {
    const onSubmit = submitForm({ model: "openai/gpt-5.4" });
    expect(onSubmit.mock.calls[0][0].model).toBe("openai/gpt-5.4");
  });

  it("prefers the enabled default when the initial model is disabled", () => {
    enabledModelsValue = [DEFAULT_MODEL, "openai/gpt-5.4"];
    const onSubmit = submitForm({ model: "anthropic/claude-opus-4-8" });
    expect(onSubmit.mock.calls[0][0].model).toBe(DEFAULT_MODEL);
  });

  it("drops a reasoning effort the coerced model does not support", () => {
    // gpt-5.4 supports none/low/medium/high/xhigh but not "max".
    const onSubmit = submitForm({ model: "anthropic/claude-opus-4-8", reasoningEffort: "max" });
    expect(onSubmit.mock.calls[0][0].model).toBe("openai/gpt-5.4");
    expect(onSubmit.mock.calls[0][0].reasoningEffort).toBeNull();
  });

  it("keeps a reasoning effort the coerced model supports", () => {
    const onSubmit = submitForm({ model: "anthropic/claude-opus-4-8", reasoningEffort: "high" });
    expect(onSubmit.mock.calls[0][0].model).toBe("openai/gpt-5.4");
    expect(onSubmit.mock.calls[0][0].reasoningEffort).toBe("high");
  });

  it("does not submit while enabled models are still loading", () => {
    loadingModelsValue = true;
    const onSubmit = submitForm({ model: "anthropic/claude-opus-4-8" });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("disables the submit button while enabled models are still loading", () => {
    loadingModelsValue = true;
    render(
      <AutomationForm
        mode="edit"
        submitting={false}
        onSubmit={vi.fn()}
        initialValues={{ ...baseInitialValues, model: "anthropic/claude-opus-4-8" }}
      />
    );
    expect(screen.getByRole("button", { name: "Save Changes" })).toBeDisabled();
  });
});
