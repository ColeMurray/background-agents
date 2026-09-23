// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as matchers from "@testing-library/jest-dom/matchers";
import { SWRConfig } from "swr";
import { ChildSessionsSection } from "./child-sessions-section";
import type { ChildSessionSummary } from "@open-inspect/shared/types/sessions";

expect.extend(matchers);

afterEach(cleanup);

vi.mock("next/link", () => ({
  default: ({ children, href, ...props }: React.ComponentProps<"a">) => (
    <a href={typeof href === "string" ? href : "#"} {...props}>
      {children}
    </a>
  ),
}));

function childSession(
  id: string,
  parentSessionId: string,
  overrides: Partial<ChildSessionSummary> = {}
): ChildSessionSummary {
  return {
    id,
    title: "Child session",
    repoOwner: "owner",
    repoName: "repo",
    baseBranch: "main",
    status: "completed",
    parentSessionId,
    spawnSource: "agent",
    environmentId: null,
    createdAt: 1000,
    updatedAt: 2000,
    harness: "opencode",
    model: "anthropic/claude-sonnet-4-6",
    reasoningEffort: null,
    spawnDepth: 1,
    automationId: null,
    automationRunId: null,
    scmLogin: null,
    userId: null,
    totalCost: 0,
    activeDurationMs: 0,
    messageCount: 0,
    prCount: 0,
    ...overrides,
  };
}

describe("ChildSessionsSection", () => {
  it("rejects malformed child summaries at the web boundary", async () => {
    const onError = vi.fn();
    render(
      <SWRConfig
        value={{
          provider: () => new Map(),
          fetcher: async () => ({
            children: [{ id: "child-session", title: "Incomplete child" }],
          }),
          onError,
          shouldRetryOnError: false,
        }}
      >
        <ChildSessionsSection sessionId="parent-session" />
      </SWRConfig>
    );

    await waitFor(() => expect(onError).toHaveBeenCalledOnce());
    expect(screen.queryByRole("button", { name: "Child sessions" })).not.toBeInTheDocument();
  });

  it("shows child sessions expanded by default", async () => {
    const sessionId = "parent-session";
    render(
      <SWRConfig
        value={{
          fetcher: async () => ({ children: [childSession("child-session", sessionId)] }),
          provider: () => new Map(),
          revalidateOnFocus: false,
        }}
      >
        <ChildSessionsSection sessionId={sessionId} />
      </SWRConfig>
    );

    const toggle = await screen.findByRole("button", { name: "Child sessions" });
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(toggle).toHaveAttribute("aria-controls");
    expect(screen.getByRole("link", { name: /Child session/ })).toBeInTheDocument();
  });

  it("shows child sessions expanded when navigating to another session", async () => {
    const user = userEvent.setup();
    const swrConfig = {
      fetcher: async (key: string) => {
        const sessionId = key.split("/").at(-2)!;
        return {
          children: [
            childSession(`child-${sessionId}`, sessionId, { title: `Child ${sessionId}` }),
          ],
        };
      },
      provider: () => new Map(),
      revalidateOnFocus: false,
    };
    const { rerender } = render(
      <SWRConfig value={swrConfig}>
        <ChildSessionsSection sessionId="parent-a" />
      </SWRConfig>
    );
    const toggle = await screen.findByRole("button", { name: "Child sessions" });
    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "false");

    rerender(
      <SWRConfig value={swrConfig}>
        <ChildSessionsSection sessionId="parent-b" />
      </SWRConfig>
    );

    expect(await screen.findByRole("button", { name: "Child sessions" })).toHaveAttribute(
      "aria-expanded",
      "true"
    );
    expect(screen.getByRole("link", { name: /Child parent-b/ })).toBeInTheDocument();
  });

  it("renders a child's pull request state icon", async () => {
    const sessionId = "parent-session";
    render(
      <SWRConfig
        value={{
          fetcher: async () => ({
            children: [
              childSession("child-session", sessionId, {
                pullRequestSummary: {
                  total: 1,
                  open: 0,
                  draft: 0,
                  merged: 1,
                  closed: 0,
                },
              }),
            ],
          }),
          provider: () => new Map(),
          revalidateOnFocus: false,
        }}
      >
        <ChildSessionsSection sessionId={sessionId} />
      </SWRConfig>
    );

    const childLink = (await screen.findByText("Child session")).closest("a");
    expect(childLink).toBeInTheDocument();
    expect(childLink).toContainElement(screen.getByLabelText("PR merged"));
  });
});
