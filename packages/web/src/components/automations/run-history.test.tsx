// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
import type { ComponentProps } from "react";
import type { AutomationInvocation, AutomationRun } from "@open-inspect/shared/types/automations";
import { RunHistory } from "./run-history";

expect.extend(matchers);
afterEach(cleanup);

vi.mock("next/link", () => ({
  default: ({ children, ...props }: ComponentProps<"a">) => <a {...props}>{children}</a>,
}));

vi.mock("@/hooks/use-environments", () => ({
  useEnvironments: () => ({
    environments: [{ id: "env_1", name: "Fullstack", repositories: [] }],
    loading: false,
  }),
}));

const FIRED_AT = new Date("2026-07-01T09:00:00Z").getTime();

function makeRun(overrides: Partial<AutomationRun> = {}): AutomationRun {
  return {
    id: "run-1",
    automationId: "auto-1",
    invocationId: "inv-1",
    sessionId: "session-1",
    status: "completed",
    skipReason: null,
    failureReason: null,
    scheduledAt: FIRED_AT,
    startedAt: FIRED_AT + 5_000,
    completedAt: FIRED_AT + 65_000,
    createdAt: FIRED_AT,
    sessionTitle: "Nightly review",
    artifactSummary: null,
    repoOwner: "acme",
    repoName: "web-app",
    repoId: 123,
    baseBranch: "main",
    environmentId: null,
    ...overrides,
  };
}

function makeInvocation(overrides: Partial<AutomationInvocation> = {}): AutomationInvocation {
  return {
    id: "inv-1",
    automationId: "auto-1",
    status: "completed",
    source: "schedule",
    scheduledAt: FIRED_AT,
    skipReason: null,
    createdAt: FIRED_AT,
    completedAt: FIRED_AT + 65_000,
    runs: [makeRun()],
    ...overrides,
  };
}

describe("RunHistory", () => {
  it("shows the empty state before any firing", () => {
    render(<RunHistory invocations={[]} total={0} loading={false} hasMore={false} />);

    expect(screen.getByText("No runs yet.")).toBeInTheDocument();
  });

  it("renders a childless skipped firing as a reason-only row", () => {
    const invocation = makeInvocation({
      status: "skipped",
      skipReason: "concurrent_run_active",
      completedAt: null,
      runs: [],
    });

    render(<RunHistory invocations={[invocation]} total={1} loading={false} hasMore={false} />);

    expect(screen.getByText("Skipped")).toBeInTheDocument();
    expect(screen.getByText("Skipped because a previous run is still active")).toBeInTheDocument();
    expect(screen.queryByText(/repositories/)).not.toBeInTheDocument();
    expect(screen.queryByText(/completed/)).not.toBeInTheDocument();
  });

  it("renders an invocation of one exactly like a flat run row", () => {
    const invocation = makeInvocation();

    render(<RunHistory invocations={[invocation]} total={1} loading={false} hasMore={false} />);

    expect(screen.getByText("Completed")).toBeInTheDocument();
    expect(screen.getByText("Nightly review")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "View session" })).toHaveAttribute(
      "href",
      "/session/session-1"
    );
    // Single-repository firings don't get the fan-out treatment.
    expect(screen.queryByText("1 repositories")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /repositories/ })).not.toBeInTheDocument();
  });

  it("renders a childless unauthorized firing as a grant denial without a session", () => {
    const invocation = makeInvocation({
      status: "unauthorized",
      source: "event",
      skipReason: "repo_not_granted",
      runs: [],
    });

    render(<RunHistory invocations={[invocation]} total={1} loading={false} hasMore={false} />);

    expect(screen.getByText("Unauthorized")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Repository is not granted to the automation's team. No sandbox or session was created."
      )
    ).toBeInTheDocument();
    expect(screen.queryByText("repo_not_granted")).not.toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it.each(["skipReason", "failureReason"] as const)(
    "renders an unauthorized run's %s as a grant denial, not a launched session",
    (reasonField) => {
      const invocation = makeInvocation({
        status: "unauthorized",
        source: "event",
        runs: [
          makeRun({
            status: "unauthorized",
            sessionId: null,
            sessionTitle: null,
            startedAt: null,
            [reasonField]: "repo_not_granted",
          }),
        ],
      });

      render(<RunHistory invocations={[invocation]} total={1} loading={false} hasMore={false} />);

      expect(screen.getByText("Unauthorized")).toBeInTheDocument();
      expect(
        screen.getByText(
          "Repository is not granted to the automation's team. No sandbox or session was created."
        )
      ).toBeInTheDocument();
      expect(screen.queryByText("repo_not_granted")).not.toBeInTheDocument();
      expect(screen.queryByText("1m 0s")).not.toBeInTheDocument();
      expect(screen.queryByRole("link")).not.toBeInTheDocument();
    }
  );

  it("counts unauthorized targets and shows their grant denial in expanded history", () => {
    const invocation = makeInvocation({
      status: "partial_failed",
      runs: [
        makeRun(),
        makeRun({
          id: "run-denied",
          status: "unauthorized",
          repoName: "api",
          sessionId: null,
          sessionTitle: null,
          startedAt: null,
          failureReason: "repo_not_granted",
        }),
      ],
    });

    render(<RunHistory invocations={[invocation]} total={1} loading={false} hasMore={false} />);

    expect(screen.getByText("1 completed, 1 unauthorized")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /2 repositories/ }));
    expect(screen.getByText("Unauthorized")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Repository is not granted to the automation's team. No sandbox or session was created."
      )
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: "View session for acme/api" })
    ).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "View session for acme/web-app" })).toBeInTheDocument();
  });

  it("renders a failed single run with its failure reason", () => {
    const invocation = makeInvocation({
      status: "failed",
      runs: [
        makeRun({
          status: "failed",
          sessionId: null,
          sessionTitle: null,
          failureReason: "Repository is not accessible for the configured SCM provider",
        }),
      ],
    });

    render(<RunHistory invocations={[invocation]} total={1} loading={false} hasMore={false} />);

    expect(screen.getByText("Failed")).toBeInTheDocument();
    expect(
      screen.getByText("Repository is not accessible for the configured SCM provider")
    ).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "View session" })).not.toBeInTheDocument();
  });

  it("summarizes a fan-out firing and expands into repository rows", () => {
    const invocation = makeInvocation({
      id: "inv-multi",
      status: "partial_failed",
      runs: [
        makeRun({ id: "run-web", repoName: "web-app" }),
        makeRun({
          id: "run-api",
          sessionId: "session-api",
          sessionTitle: "API sweep",
          status: "failed",
          repoName: "api",
          failureReason: "Sandbox spawn failed",
        }),
      ],
    });

    render(<RunHistory invocations={[invocation]} total={1} loading={false} hasMore={false} />);

    expect(screen.getByText("Partial failure")).toBeInTheDocument();
    expect(screen.getByText("2 repositories")).toBeInTheDocument();
    expect(screen.getByText("1 completed, 1 failed")).toBeInTheDocument();
    // Children are collapsed until the row is expanded.
    expect(screen.queryByText("acme/web-app")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /2 repositories/ }));

    expect(screen.getByText("acme/web-app")).toBeInTheDocument();
    expect(screen.getByText("acme/api")).toBeInTheDocument();
    expect(screen.getByText("Sandbox spawn failed")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "View session for acme/web-app" })).toHaveAttribute(
      "href",
      "/session/session-1"
    );
    expect(screen.getByRole("link", { name: "View session for acme/api" })).toHaveAttribute(
      "href",
      "/session/session-api"
    );
  });

  it("shows active fan-out children in the summary counts", () => {
    const invocation = makeInvocation({
      id: "inv-active",
      status: "running",
      completedAt: null,
      runs: [
        makeRun({ id: "run-web", status: "running", completedAt: null }),
        makeRun({ id: "run-api", status: "starting", startedAt: null, completedAt: null }),
      ],
    });

    render(<RunHistory invocations={[invocation]} total={1} loading={false} hasMore={false} />);

    expect(screen.getByText("Running")).toBeInTheDocument();
    expect(screen.getByText("0 completed, 2 running")).toBeInTheDocument();
  });

  it("counts invocations, not repository runs, in the load-more affordance", () => {
    const invocations = [
      makeInvocation({
        id: "inv-1",
        runs: [makeRun({ id: "run-1" }), makeRun({ id: "run-2", repoName: "api" })],
      }),
      makeInvocation({ id: "inv-2", runs: [makeRun({ id: "run-3" })] }),
    ];

    render(
      <RunHistory
        invocations={invocations}
        total={5}
        loading={false}
        hasMore={true}
        onLoadMore={() => {}}
      />
    );

    expect(screen.getByRole("button", { name: "Load more (2 of 5)" })).toBeInTheDocument();
  });
});
