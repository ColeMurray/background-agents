// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as matchers from "@testing-library/jest-dom/matchers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SkillSummary } from "@open-inspect/shared/types/skills";
import { SkillsCatalog } from "./skills-catalog";

expect.extend(matchers);

const { useSkillCatalogPageMock } = vi.hoisted(() => ({
  useSkillCatalogPageMock: vi.fn(),
}));

vi.mock("@/hooks/use-managed-skills", () => ({
  deleteSkill: vi.fn(),
  revalidateSkillCatalogPage: vi.fn(),
  setSkillEnabled: vi.fn(),
  useSkill: () => ({ skill: undefined, loading: false, error: undefined, mutate: vi.fn() }),
  useSkillCatalogPage: useSkillCatalogPageMock,
}));

function skill(id: string, name: string): SkillSummary {
  return {
    id,
    name,
    description: `${name} description`,
    enabled: true,
    currentRevisionId: `revision-${id}`,
    revisionNumber: 1,
    revisionSha256: "a".repeat(64),
    revisionCreatedBy: "user-1",
    creatorDisplayName: "User One",
    lastEditorDisplayName: "User One",
    revisionAuthorDisplayName: "User One",
    assignments: [],
    createdBy: "user-1",
    updatedBy: "user-1",
    createdAt: 1,
    updatedAt: 1,
  };
}

beforeEach(() => {
  useSkillCatalogPageMock.mockReset();
  useSkillCatalogPageMock.mockImplementation((cursor: string | null) =>
    cursor
      ? {
          skills: [skill("2", "second-skill")],
          hasMore: false,
          nextCursor: null,
          loading: false,
          error: undefined,
        }
      : {
          skills: [skill("1", "first-skill")],
          hasMore: true,
          nextCursor: "first-skill",
          loading: false,
          error: undefined,
        }
  );
});

afterEach(cleanup);

describe("SkillsCatalog", () => {
  it("loads catalog pages on demand and navigates back with cursor history", async () => {
    const user = userEvent.setup();
    render(<SkillsCatalog />);

    expect(screen.getByText("first-skill")).toBeInTheDocument();
    expect(screen.getByText("Page 1")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Previous" })).toBeDisabled();
    expect(useSkillCatalogPageMock).toHaveBeenLastCalledWith(null);

    await user.click(screen.getByRole("button", { name: "Next" }));

    expect(screen.getByText("second-skill")).toBeInTheDocument();
    expect(screen.getByText("Page 2")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
    expect(useSkillCatalogPageMock).toHaveBeenLastCalledWith("first-skill");

    await user.click(screen.getByRole("button", { name: "Previous" }));

    expect(screen.getByText("first-skill")).toBeInTheDocument();
    expect(useSkillCatalogPageMock).toHaveBeenLastCalledWith(null);
  });

  it.each([
    [
      "empty",
      {
        skills: [],
        hasMore: false,
        nextCursor: null,
        loading: false,
        error: undefined,
      },
      "No skills on this page.",
    ],
    [
      "failed",
      {
        skills: [],
        hasMore: false,
        nextCursor: null,
        loading: false,
        error: new Error("request failed"),
      },
      "Failed to load managed skills.",
    ],
  ])("can navigate back when a later page is %s", async (_state, page, message) => {
    useSkillCatalogPageMock.mockImplementation((cursor: string | null) =>
      cursor
        ? page
        : {
            skills: [skill("1", "first-skill")],
            hasMore: true,
            nextCursor: "first-skill",
            loading: false,
            error: undefined,
          }
    );
    const user = userEvent.setup();
    render(<SkillsCatalog />);

    await user.click(screen.getByRole("button", { name: "Next" }));

    expect(screen.getByText(message)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Previous" })).toBeEnabled();

    await user.click(screen.getByRole("button", { name: "Previous" }));

    expect(screen.getByText("first-skill")).toBeInTheDocument();
    expect(useSkillCatalogPageMock).toHaveBeenLastCalledWith(null);
  });
});
