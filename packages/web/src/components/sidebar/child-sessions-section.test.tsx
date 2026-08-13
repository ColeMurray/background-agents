// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as matchers from "@testing-library/jest-dom/matchers";
import { SWRConfig } from "swr";
import { ChildSessionsSection } from "./child-sessions-section";

expect.extend(matchers);

afterEach(cleanup);

vi.mock("next/link", () => ({
  default: ({ children, href, ...props }: React.ComponentProps<"a">) => (
    <a href={typeof href === "string" ? href : "#"} {...props}>
      {children}
    </a>
  ),
}));

describe("ChildSessionsSection", () => {
  it("shows child sessions expanded by default", async () => {
    const sessionId = "parent-session";
    render(
      <SWRConfig
        value={{
          fallback: {
            [`/api/sessions/${sessionId}/children`]: {
              children: [
                {
                  id: "child-session",
                  title: "Child session",
                  repoOwner: "owner",
                  repoName: "repo",
                  parentSessionId: sessionId,
                  spawnSource: "agent",
                  spawnDepth: 1,
                  status: "completed",
                  createdAt: 1000,
                  updatedAt: 2000,
                },
              ],
            },
          },
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
      fallback: Object.fromEntries(
        ["parent-a", "parent-b"].map((sessionId) => [
          `/api/sessions/${sessionId}/children`,
          {
            children: [
              {
                id: `child-${sessionId}`,
                title: `Child ${sessionId}`,
                repoOwner: "owner",
                repoName: "repo",
                parentSessionId: sessionId,
                spawnSource: "agent",
                spawnDepth: 1,
                status: "completed",
                createdAt: 1000,
                updatedAt: 2000,
              },
            ],
          },
        ])
      ),
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
          fallback: {
            [`/api/sessions/${sessionId}/children`]: {
              children: [
                {
                  id: "child-session",
                  title: "Child session",
                  repoOwner: "owner",
                  repoName: "repo",
                  parentSessionId: sessionId,
                  spawnSource: "agent",
                  spawnDepth: 1,
                  status: "completed",
                  createdAt: 1000,
                  updatedAt: 2000,
                  pullRequestSummary: {
                    total: 1,
                    open: 0,
                    draft: 0,
                    merged: 1,
                    closed: 0,
                  },
                },
              ],
            },
          },
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
