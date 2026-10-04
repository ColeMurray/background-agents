// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as matchers from "@testing-library/jest-dom/matchers";
import type { SessionMemorySelectionStatus } from "@open-inspect/shared/types/memories";
import { MemoriesSection } from "./memories-section";

expect.extend(matchers);

const memories = vi.hoisted(() => ({ diagnostics: undefined as unknown }));
vi.mock("@/hooks/use-memories", () => ({
  useSessionMemories: () => ({
    diagnostics: memories.diagnostics,
    loading: false,
    error: undefined,
  }),
}));

afterEach(cleanup);

type Item = SessionMemorySelectionStatus["items"][number];

function item(overrides: Partial<Item>): Item {
  return {
    memoryId: "m",
    revisionNumber: 1,
    scope: { type: "personal" },
    memoryType: "fact",
    title: "Title",
    inclusion: "summary",
    estimatedTokens: 100,
    revisedSinceSelection: false,
    archivedSinceSelection: false,
    ...overrides,
  };
}

describe("MemoriesSection", () => {
  it("groups memories by scope with drift, archive, and budget notices", async () => {
    memories.diagnostics = {
      includePersonalMemories: true,
      directiveChars: 0,
      catalogChars: 0,
      estimatedTokens: 4210,
      omittedCount: 2,
      items: [
        item({ memoryId: "p1", title: "Review tone", scope: { type: "personal" } }),
        item({
          memoryId: "r1",
          title: "Use pnpm",
          scope: { type: "repository", repoOwner: "acme", repoName: "web" },
          memoryType: "directive",
          inclusion: "full",
          revisedSinceSelection: true,
        }),
        item({
          memoryId: "e1",
          title: "Old deploy notes",
          scope: { type: "environment", environmentId: "env-1" },
          archivedSinceSelection: true,
        }),
      ],
    } satisfies SessionMemorySelectionStatus;
    render(<MemoriesSection sessionId="session-1" />);
    await userEvent.setup().click(screen.getByRole("button", { name: "Memories (3)" }));

    const headings = screen.getAllByText(/^(Repository|Environment|Personal) · 1$/);
    expect(headings.map((heading) => heading.textContent)).toEqual([
      "Repository · 1",
      "Environment · 1",
      "Personal · 1",
    ]);
    const repoRow = screen.getByRole("link", { name: "Use pnpm" }).closest("li")!;
    expect(within(repoRow).getByText("revised")).toBeInTheDocument();
    expect(within(repoRow).getByLabelText("Directive")).toBeInTheDocument();
    const archivedRow = screen.getByRole("link", { name: "Old deploy notes" }).closest("li")!;
    expect(within(archivedRow).getByText("archived")).toBeInTheDocument();
    expect(screen.getByText(/~4\.2k tokens · personal included/)).toHaveTextContent(
      "2 omitted for budget"
    );
  });
});
