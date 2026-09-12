// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SandboxEvent } from "@/types/session";
import { CreatePullRequestEvent } from "./create-pull-request-event";

type ToolCallEvent = Extract<SandboxEvent, { type: "tool_call" }>;

const BASE_EVENT: ToolCallEvent = {
  type: "tool_call",
  tool: "create-pull-request",
  callId: "call-1",
  messageId: "message-1",
  sandboxId: "sandbox-1",
  timestamp: 1_700_000_000,
  status: "completed",
  args: {
    title: "Show creator attribution",
    body: "## Why\n\nShared skills now show their creator.",
    repo: "group/platform/web",
  },
};

function createdOutput({
  draft = false,
  url = "https://github.com/acme/web/pull/42",
}: {
  draft?: boolean;
  url?: string;
} = {}) {
  return JSON.stringify({
    kind: "created",
    prNumber: 42,
    prUrl: url,
    state: draft ? "draft" : "open",
    headBranch: "feature/creator",
    baseBranch: "main",
    agentMessage: "Pull request created successfully.",
  });
}

function renderExpanded(overrides: Partial<ToolCallEvent> = {}) {
  const event = { ...BASE_EVENT, ...overrides };
  return render(<CreatePullRequestEvent event={event} isExpanded onToggle={() => {}} />);
}

afterEach(cleanup);

describe("CreatePullRequestEvent", () => {
  it("leaves expansion state with the parent", () => {
    const onToggle = vi.fn();
    render(
      <CreatePullRequestEvent
        event={{ ...BASE_EVENT, output: createdOutput() }}
        isExpanded={false}
        onToggle={onToggle}
      />
    );

    expect(screen.queryByRole("link", { name: /open pr/i })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button"));
    expect(onToggle).toHaveBeenCalledOnce();
  });

  it("renders a created pull request with opaque markdown body content", () => {
    renderExpanded({ output: createdOutput() });

    expect(screen.getByText("Opened pull request #42")).toBeInTheDocument();
    expect(screen.getByText("group/platform/web")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Why" })).toBeInTheDocument();
    expect(screen.getByText("Shared skills now show their creator.")).toBeInTheDocument();
    expect(screen.getByText("feature/creator")).toBeInTheDocument();
    expect(screen.getByText("main")).toBeInTheDocument();
    expect(screen.getByText("Ready for review")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /open pr/i })).toHaveAttribute(
      "href",
      "https://github.com/acme/web/pull/42"
    );
  });

  it("keeps the PR action when optional success metadata is absent", () => {
    renderExpanded({
      output: JSON.stringify({
        kind: "created",
        prNumber: 42,
        prUrl: "https://github.com/acme/web/pull/42",
        agentMessage: "Pull request created successfully.",
      }),
    });

    expect(screen.getByText("Opened pull request #42")).toBeInTheDocument();
    expect(screen.getByText("Open")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /open pr/i })).toHaveAttribute(
      "href",
      "https://github.com/acme/web/pull/42"
    );
    expect(screen.queryByText("unknown")).not.toBeInTheDocument();
  });

  it("does not invent sections for a freeform body", () => {
    renderExpanded({
      args: {
        title: "Plain description",
        body: "This change keeps attribution visible without requiring structured headings.",
      },
      output: createdOutput(),
    });

    expect(screen.getByText(/without requiring structured headings/i)).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /summary/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /verification/i })).not.toBeInTheDocument();
  });

  it("renders draft state", () => {
    renderExpanded({ output: createdOutput({ draft: true }) });

    expect(screen.getByText("Draft")).toBeInTheDocument();
    expect(screen.getByText("Draft pull request")).toBeInTheDocument();
  });

  it("renders an updated pull request distinctly", () => {
    renderExpanded({
      output: JSON.stringify({
        kind: "updated",
        prNumber: 42,
        prUrl: "https://github.com/acme/web/pull/42",
        state: "open",
        headBranch: "feature/creator",
        baseBranch: "main",
        agentMessage: "Pull request updated with your latest commits.",
      }),
    });

    expect(screen.getByText("Updated pull request #42")).toBeInTheDocument();
    expect(screen.getByText("Latest commits pushed")).toBeInTheDocument();
  });

  it("renders completed textual failures as failures", () => {
    renderExpanded({
      output: JSON.stringify({
        kind: "failure",
        message: "Authentication failed: token expired. Please re-authenticate.",
        agentMessage: "Authentication failed: token expired. Please re-authenticate.",
      }),
    });

    expect(screen.getByText("Create pull request failed")).toBeInTheDocument();
    expect(screen.getByText("Couldn't create pull request")).toBeInTheDocument();
    expect(screen.getByText(/token expired/i)).toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("renders the manual creation fallback", () => {
    renderExpanded({
      output: JSON.stringify({
        kind: "manual",
        createPrUrl: "https://github.com/acme/web/compare/main...feature",
        agentMessage: "Create the pull request in GitHub.",
      }),
    });

    expect(screen.getByText("Branch pushed for pull request")).toBeInTheDocument();
    expect(screen.getByText("Branch ready")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /create pr/i })).toHaveAttribute(
      "href",
      "https://github.com/acme/web/compare/main...feature"
    );
  });

  it("omits unsafe result links", () => {
    renderExpanded({ output: createdOutput({ url: "javascript:alert(1)" }) });

    expect(screen.getByText("Opened pull request #42")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /open pr/i })).not.toBeInTheDocument();
  });

  it("preserves unrecognized output instead of dropping result details", () => {
    const output = "  Provider accepted the request with an unfamiliar response.\n";
    renderExpanded({ output });

    expect(screen.getByText("Create pull request completed")).toBeInTheDocument();
    expect(screen.getByText("Result details below")).toBeInTheDocument();
    expect(screen.getByText(/unfamiliar response/i).textContent).toBe(output);
  });

  it("keeps unrecognized running output pending", () => {
    renderExpanded({ status: "running", output: "Pushing branch to the remote..." });

    expect(screen.getByText("Creating pull request")).toBeInTheDocument();
    expect(screen.getByText("Pushing branch to the remote...")).toBeInTheDocument();
    expect(screen.queryByText("Create pull request completed")).not.toBeInTheDocument();
  });

  it("renders persisted prose output through the legacy fallback", () => {
    renderExpanded({
      output:
        "Pull request created successfully!\n\nPR #42 (feature/creator -> main): https://github.com/acme/web/pull/42\n\nThe pull request is now ready for review.",
    });

    expect(screen.getByText("Opened pull request #42")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /open pr/i })).toHaveAttribute(
      "href",
      "https://github.com/acme/web/pull/42"
    );
  });

  it("shows pending state before output arrives", () => {
    renderExpanded({ status: "running", output: undefined });

    expect(screen.getByText("Creating pull request")).toBeInTheDocument();
    expect(screen.getByText("Creating pull request...")).toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("allows long descriptions to be expanded", () => {
    renderExpanded({
      args: { title: "Long description", body: "Long body paragraph. ".repeat(30) },
      output: createdOutput(),
    });

    fireEvent.click(screen.getByRole("button", { name: "Show full description" }));
    expect(screen.getByRole("button", { name: "Show less" })).toBeInTheDocument();
  });
});
