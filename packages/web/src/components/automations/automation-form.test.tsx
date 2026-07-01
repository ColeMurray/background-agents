// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
import type { ReactNode } from "react";
import { DEFAULT_MODEL } from "@open-inspect/shared";
import { AutomationForm, type AutomationFormValues } from "./automation-form";
import { CronPicker } from "./cron-picker";

expect.extend(matchers);

afterEach(cleanup);

// Mutable per-test enabled set; the hoisted use-enabled-models mock closes over it.
let enabledModelsValue: string[] = ["openai/gpt-5.4"];
let loadingModelsValue = false;
let reposValue = [
  {
    id: 1,
    fullName: "open-inspect/background-agents",
    owner: "open-inspect",
    name: "background-agents",
    description: null,
    private: false,
    defaultBranch: "main",
  },
  {
    id: 2,
    fullName: "open-inspect/control-plane",
    owner: "open-inspect",
    name: "control-plane",
    description: null,
    private: false,
    defaultBranch: "main",
  },
];
beforeEach(() => {
  enabledModelsValue = ["openai/gpt-5.4"];
  loadingModelsValue = false;
  reposValue = [
    {
      id: 1,
      fullName: "open-inspect/background-agents",
      owner: "open-inspect",
      name: "background-agents",
      description: null,
      private: false,
      defaultBranch: "main",
    },
    {
      id: 2,
      fullName: "open-inspect/control-plane",
      owner: "open-inspect",
      name: "control-plane",
      description: null,
      private: false,
      defaultBranch: "main",
    },
  ];
});

vi.mock("@/hooks/use-repos", () => ({
  useRepos: () => ({
    repos: reposValue,
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

  it("submits repo-less automations without repo fields", () => {
    const onSubmit = vi.fn();
    const { container } = render(
      <AutomationForm
        mode="create"
        submitting={false}
        onSubmit={onSubmit}
        initialValues={{
          name: "Check incidents",
          model: "openai/gpt-5.4",
          scheduleCron: "0 9 * * *",
          scheduleTz: "UTC",
          instructions: "Inspect recent alerts and send a summary.",
        }}
      />
    );

    expect(screen.getAllByText("No repository").length).toBeGreaterThan(0);
    expect(screen.getByText("Select no repository or one repository.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Repository selection" }));
    expect(screen.getByRole("button", { name: "Select Multiple" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create Automation" })).toBeEnabled();

    fireEvent.submit(container.querySelector("form")!);

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0][0]).toMatchObject({
      name: "Check incidents",
      instructions: "Inspect recent alerts and send a summary.",
    });
    expect(onSubmit.mock.calls[0][0].repoOwner).toBeUndefined();
    expect(onSubmit.mock.calls[0][0].repoName).toBeUndefined();
    expect(onSubmit.mock.calls[0][0].baseBranch).toBeUndefined();
  });

  it("keeps scheduled repository selection single until multi-select is enabled", () => {
    const onSubmit = vi.fn();
    const { container } = render(
      <AutomationForm
        mode="create"
        submitting={false}
        onSubmit={onSubmit}
        initialValues={{
          name: "Weekly review",
          model: "openai/gpt-5.4",
          scheduleCron: "0 9 * * 1",
          scheduleTz: "UTC",
          instructions: "Review the repo.",
        }}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Repository selection" }));
    fireEvent.click(screen.getByRole("button", { name: "open-inspect/background-agents" }));
    fireEvent.click(screen.getByRole("button", { name: "Repository selection" }));
    fireEvent.click(screen.getByRole("button", { name: "open-inspect/control-plane" }));
    fireEvent.submit(container.querySelector("form")!);

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0][0]).toMatchObject({
      repoOwner: "open-inspect",
      repoName: "control-plane",
    });
    expect(onSubmit.mock.calls[0][0].targets).toBeUndefined();
  });

  it("backfills a single-repo base branch when repository data arrives later", async () => {
    reposValue = [];
    const onSubmit = vi.fn();
    const initialValues: Partial<AutomationFormValues> = {
      name: "Weekly review",
      model: "openai/gpt-5.4",
      repoOwner: "open-inspect",
      repoName: "control-plane",
      baseBranch: "",
      scheduleCron: "0 9 * * 1",
      scheduleTz: "UTC",
      instructions: "Review the repo.",
    };

    const props = {
      mode: "create" as const,
      submitting: false,
      onSubmit,
      initialValues,
    };
    const { container, rerender } = render(<AutomationForm {...props} />);

    fireEvent.submit(container.querySelector("form")!);
    expect(onSubmit).not.toHaveBeenCalled();

    reposValue = [
      {
        id: 2,
        fullName: "open-inspect/control-plane",
        owner: "open-inspect",
        name: "control-plane",
        description: null,
        private: false,
        defaultBranch: "develop",
      },
    ];

    rerender(<AutomationForm {...props} />);
    await waitFor(() => {
      expect(screen.getByText("develop")).toBeInTheDocument();
    });

    fireEvent.submit(container.querySelector("form")!);

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0][0]).toMatchObject({
      repoOwner: "open-inspect",
      repoName: "control-plane",
      baseBranch: "develop",
    });
  });

  it("submits multiple repositories after enabling multi-select", () => {
    const onSubmit = vi.fn();
    const { container } = render(
      <AutomationForm
        mode="create"
        submitting={false}
        onSubmit={onSubmit}
        initialValues={{
          name: "Weekly review",
          model: "openai/gpt-5.4",
          scheduleCron: "0 9 * * 1",
          scheduleTz: "UTC",
          instructions: "Review the repos.",
        }}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Repository selection" }));
    fireEvent.click(screen.getByRole("button", { name: "Select Multiple" }));
    fireEvent.click(screen.getByLabelText("open-inspect/background-agents"));
    fireEvent.click(screen.getByLabelText("open-inspect/control-plane"));
    fireEvent.submit(container.querySelector("form")!);

    expect(screen.getByRole("button", { name: "Select One" })).toBeInTheDocument();
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0][0]).toMatchObject({
      targets: [
        { repoOwner: "open-inspect", repoName: "background-agents" },
        { repoOwner: "open-inspect", repoName: "control-plane" },
      ],
    });
    expect(onSubmit.mock.calls[0][0].repoOwner).toBeUndefined();
    expect(onSubmit.mock.calls[0][0].repoName).toBeUndefined();
  });

  it("clears repository search when the picker closes", () => {
    render(
      <AutomationForm
        mode="create"
        submitting={false}
        onSubmit={vi.fn()}
        initialValues={{
          name: "Weekly review",
          model: "openai/gpt-5.4",
          scheduleCron: "0 9 * * 1",
          scheduleTz: "UTC",
          instructions: "Review the repo.",
        }}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Repository selection" }));
    fireEvent.change(screen.getByPlaceholderText("Search repositories"), {
      target: { value: "control" },
    });
    expect(
      screen.queryByRole("button", { name: "open-inspect/background-agents" })
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "open-inspect/control-plane" }));
    fireEvent.click(screen.getByRole("button", { name: "Repository selection" }));

    expect(screen.getByPlaceholderText("Search repositories")).toHaveValue("");
    expect(
      screen.getByRole("button", { name: "open-inspect/background-agents" })
    ).toBeInTheDocument();
  });

  it("selects a repository for GitHub event automations", () => {
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

    expect(screen.getAllByText("open-inspect/background-agents").length).toBeGreaterThan(0);
    expect(
      screen.getByText("Repository-scoped triggers need exactly one repository.")
    ).toBeInTheDocument();
  });

  it("describes optional non-schedule repository selection as one repository max", () => {
    render(
      <AutomationForm
        mode="edit"
        submitting={false}
        onSubmit={vi.fn()}
        initialValues={{
          name: "Inspect Sentry alerts",
          model: "openai/gpt-5.4",
          instructions: "Triage recent alerts.",
          triggerType: "sentry",
          eventType: "issue.created",
          triggerConfig: { conditions: [] },
        }}
      />
    );

    expect(screen.getByText("Select no repository or one repository.")).toBeInTheDocument();
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
          repoOwner: "open-inspect",
          repoName: "background-agents",
          baseBranch: "main",
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

describe("slack_event automation", () => {
  const slackBase = {
    name: "Triage Slack reports",
    repoOwner: "open-inspect",
    repoName: "background-agents",
    baseBranch: "main",
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

describe("model normalization", () => {
  const baseInitialValues = {
    name: "Daily review",
    repoOwner: "open-inspect",
    repoName: "background-agents",
    baseBranch: "main",
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
