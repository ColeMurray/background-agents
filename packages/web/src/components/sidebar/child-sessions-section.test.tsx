// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
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
