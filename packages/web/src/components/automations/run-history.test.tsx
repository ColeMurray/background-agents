// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
import type { AutomationRun, AutomationRunGroup } from "@open-inspect/shared";
import { RunHistory } from "./run-history";

expect.extend(matchers);

afterEach(cleanup);

describe("RunHistory", () => {
  it("renders skipped zero-child groups as a skipped summary", () => {
    const group: AutomationRunGroup = {
      id: "group-1",
      automationId: "auto-1",
      status: "skipped",
      skipReason: "Skipped because another group is still active",
      failureReason: null,
      scheduledAt: Date.now(),
      startedAt: Date.now(),
      completedAt: Date.now(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      failureCountedAt: null,
      totalRuns: 0,
      startingRuns: 0,
      runningRuns: 0,
      completedRuns: 0,
      failedRuns: 0,
      skippedRuns: 0,
      runs: [],
    };

    render(<RunHistory runs={[]} groups={[group]} total={1} loading={false} hasMore={false} />);

    expect(screen.getByText("Skipped because another group is still active")).toBeInTheDocument();
    expect(screen.queryByText("0 repositories")).not.toBeInTheDocument();
    expect(screen.queryByText("0 completed")).not.toBeInTheDocument();
  });

  it("does not render flattened compatibility runs when groups are present", () => {
    const run: AutomationRun = {
      id: "run-1",
      automationId: "auto-1",
      sessionId: "session-1",
      status: "completed",
      skipReason: null,
      failureReason: null,
      scheduledAt: Date.now(),
      startedAt: Date.now(),
      completedAt: Date.now(),
      createdAt: Date.now(),
      sessionTitle: "Child run",
      artifactSummary: null,
      triggerKey: null,
      concurrencyKey: null,
      groupId: "group-1",
      targetRepoOwner: "acme",
      targetRepoName: "web-app",
      targetRepoId: 123,
      targetBaseBranch: "main",
    };
    const group: AutomationRunGroup = {
      id: "group-1",
      automationId: "auto-1",
      status: "completed",
      skipReason: null,
      failureReason: null,
      scheduledAt: Date.now(),
      startedAt: Date.now(),
      completedAt: Date.now(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      failureCountedAt: null,
      totalRuns: 1,
      startingRuns: 0,
      runningRuns: 0,
      completedRuns: 1,
      failedRuns: 0,
      skippedRuns: 0,
      runs: [run],
    };

    render(<RunHistory runs={[run]} groups={[group]} total={1} loading={false} hasMore={false} />);

    expect(screen.getByText("1 repository")).toBeInTheDocument();
    expect(screen.queryByText("Child run")).not.toBeInTheDocument();
  });

  it("shows repository outcomes without exposing run identifiers when a group is expanded", () => {
    const failedRun: AutomationRun = {
      id: "run-1",
      automationId: "auto-1",
      sessionId: "session-1",
      status: "failed",
      skipReason: null,
      failureReason: "Repository is not accessible",
      scheduledAt: Date.now(),
      startedAt: Date.now(),
      completedAt: Date.now(),
      createdAt: Date.now(),
      sessionTitle: "Failed child",
      artifactSummary: null,
      triggerKey: null,
      concurrencyKey: null,
      groupId: "group-1",
      targetRepoOwner: "acme",
      targetRepoName: "api",
      targetRepoId: 123,
      targetBaseBranch: "main",
    };
    const skippedRun: AutomationRun = {
      ...failedRun,
      id: "run-2",
      sessionId: null,
      status: "skipped",
      skipReason: "Skipped by concurrency guard",
      failureReason: null,
      sessionTitle: "Skipped child",
      targetRepoName: "web",
    };
    const group: AutomationRunGroup = {
      id: "group-1",
      automationId: "auto-1",
      status: "partial_failed",
      skipReason: null,
      failureReason: null,
      scheduledAt: Date.now(),
      startedAt: Date.now(),
      completedAt: Date.now(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      failureCountedAt: Date.now(),
      totalRuns: 2,
      startingRuns: 0,
      runningRuns: 0,
      completedRuns: 0,
      failedRuns: 1,
      skippedRuns: 1,
      runs: [failedRun, skippedRun],
    };

    render(<RunHistory runs={[]} groups={[group]} total={1} loading={false} hasMore={false} />);

    fireEvent.click(screen.getByRole("button", { name: /2 repositories/ }));

    expect(screen.getByText("Repository is not accessible")).toBeInTheDocument();
    expect(screen.getByText("Skipped by concurrency guard")).toBeInTheDocument();
    expect(screen.getByText("acme/api")).toBeInTheDocument();
    expect(screen.getByText("acme/web")).toBeInTheDocument();
    expect(screen.getByText("Session created")).toBeInTheDocument();
    expect(screen.getByText("No session needed")).toBeInTheDocument();
    expect(screen.getByText(/Counts toward auto-pause since/)).toBeInTheDocument();
    expect(screen.queryByText("Parent run")).not.toBeInTheDocument();
    expect(screen.queryByText("group-1")).not.toBeInTheDocument();
    expect(screen.queryByText("Targets")).not.toBeInTheDocument();
    expect(screen.queryByText("Run run-1, session session-1")).not.toBeInTheDocument();
    expect(screen.queryByText("Run run-2, no session")).not.toBeInTheDocument();
  });
});
