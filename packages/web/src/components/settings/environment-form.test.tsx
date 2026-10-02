// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as matchers from "@testing-library/jest-dom/matchers";
import { MAX_TARGET_REPOSITORIES } from "@open-inspect/shared/types/repositories";
import type { Environment } from "@open-inspect/shared/types/environments";
import { EnvironmentForm } from "./environment-form";

expect.extend(matchers);

afterEach(cleanup);

const mocks = vi.hoisted(() => ({
  useRepos: vi.fn(),
  allowWorkspace: true,
  reposValue: [] as Array<{
    id: number;
    fullName: string;
    owner: string;
    name: string;
    description: string | null;
    private: boolean;
    defaultBranch: string;
  }>,
}));

vi.mock("@/hooks/use-repos", () => ({
  useRepos: (enabled: boolean, teamId: string | null) => {
    mocks.useRepos(enabled, teamId);
    return { repos: mocks.reposValue, loading: false };
  },
}));
vi.mock("@/hooks/use-resource-teams", () => ({
  useResourceTeams: () => ({
    teams: [
      { id: "team-1", name: "Engineering" },
      { id: "team-2", name: "Design" },
    ],
    allTeams: [],
    loading: false,
    error: null,
    allowWorkspace: mocks.allowWorkspace,
  }),
}));

vi.mock("@/hooks/use-branches", () => ({
  useBranches: () => ({ branches: [{ name: "main" }, { name: "develop" }], loading: false }),
}));

beforeAll(() => {
  // Radix Select uses pointer capture, which jsdom lacks.
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.releasePointerCapture = () => {};
  Element.prototype.scrollIntoView = vi.fn();
  // Radix Switch measures itself via ResizeObserver, which jsdom lacks.
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
});

beforeEach(() => {
  mocks.allowWorkspace = true;
});

function repo(owner: string, name: string, id: number) {
  return {
    id,
    fullName: `${owner}/${name}`,
    owner,
    name,
    description: null,
    private: false,
    defaultBranch: "main",
  };
}

function environment(
  repositories: Array<{ repoOwner: string; repoName: string }>,
  overrides: Partial<Environment> = {}
): Environment {
  return {
    id: "env-1",
    name: "full-stack",
    description: null,
    prebuildEnabled: false,
    createdAt: 1,
    updatedAt: 1,
    repositories: repositories.map((entry, index) => ({
      ...entry,
      repoId: index + 1,
      baseBranch: "main",
    })),
    ...overrides,
  };
}

describe("EnvironmentForm", () => {
  it.each(["team-1", null])("validates owner %s and discards stale selections", async (teamId) => {
    mocks.allowWorkspace = teamId !== null;
    mocks.reposValue = [repo("acme", "web", 1)];
    const onSubmit = vi.fn();
    const user = userEvent.setup();
    const { container } = render(
      <EnvironmentForm
        mode="create"
        teamId={teamId}
        submitting={false}
        onSubmit={onSubmit}
        onCancel={vi.fn()}
        initialValues={environment([{ repoOwner: "acme", repoName: "web" }])}
      />
    );
    expect(mocks.useRepos).toHaveBeenLastCalledWith(true, teamId);
    expect(screen.getByRole("combobox", { name: "Team" })).toHaveTextContent(
      teamId ? "Engineering" : "Select a team"
    );
    fireEvent.submit(container.querySelector("form")!);
    if (!teamId) {
      expect(screen.getByRole("button", { name: "Create environment" })).toBeDisabled();
      expect(onSubmit).not.toHaveBeenCalled();
      return;
    }
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ teamId }));
    await user.click(screen.getByRole("combobox", { name: "Team" }));
    await user.click(screen.getByRole("option", { name: "Design" }));
    expect(mocks.useRepos).toHaveBeenLastCalledWith(true, "team-2");
    expect(screen.queryByTitle("acme/web")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create environment" })).toBeDisabled();
    fireEvent.submit(container.querySelector("form")!);
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("shows existing team ownership read-only and excludes it from edit submissions", () => {
    mocks.reposValue = [repo("acme", "web", 1)];
    const onSubmit = vi.fn();
    const { container } = render(
      <EnvironmentForm
        mode="edit"
        submitting={false}
        onSubmit={onSubmit}
        onCancel={vi.fn()}
        initialValues={environment([{ repoOwner: "acme", repoName: "web" }], {
          ownerTeamId: "team-1",
        })}
      />
    );
    expect(screen.getByRole("combobox", { name: "Team" })).toHaveTextContent("Engineering");
    expect(screen.getByRole("combobox", { name: "Team" })).toBeDisabled();
    fireEvent.submit(container.querySelector("form")!);
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0][0]).not.toHaveProperty("teamId");
    expect(onSubmit.mock.calls[0][0].repositories).toEqual([
      { repoOwner: "acme", repoName: "web", baseBranch: "main" },
    ]);
  });

  it("preserves a nested owner namespace when saving", async () => {
    mocks.reposValue = [repo("group/subgroup", "web", 1)];
    const onSubmit = vi.fn();
    const user = userEvent.setup();
    render(
      <EnvironmentForm
        mode="edit"
        initialValues={environment([{ repoOwner: "group/subgroup", repoName: "web" }])}
        onSubmit={onSubmit}
        onCancel={vi.fn()}
        submitting={false}
      />
    );

    await user.click(screen.getByRole("button", { name: /save environment/i }));

    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        repositories: [{ repoOwner: "group/subgroup", repoName: "web", baseBranch: "main" }],
      })
    );
  });

  it("marks the first repository as primary and reordering changes the submitted order", async () => {
    mocks.reposValue = [repo("acme", "backend", 1), repo("acme", "frontend", 2)];
    const onSubmit = vi.fn();
    const user = userEvent.setup();
    render(
      <EnvironmentForm
        mode="edit"
        initialValues={environment([
          { repoOwner: "acme", repoName: "backend" },
          { repoOwner: "acme", repoName: "frontend" },
        ])}
        onSubmit={onSubmit}
        onCancel={vi.fn()}
        submitting={false}
      />
    );

    // The primary badge sits on the first ordered row.
    const backendRow = screen.getByTitle("acme/backend").closest("div");
    expect(backendRow).not.toBeNull();
    expect(within(backendRow as HTMLElement).getByText("primary")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Move acme/frontend up" }));
    await user.click(screen.getByRole("button", { name: /save environment/i }));

    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        repositories: [
          { repoOwner: "acme", repoName: "frontend", baseBranch: "main" },
          { repoOwner: "acme", repoName: "backend", baseBranch: "main" },
        ],
      })
    );
  });

  it("disables further selection at the repository cap", async () => {
    const selected = Array.from({ length: MAX_TARGET_REPOSITORIES }, (_, index) => ({
      repoOwner: "acme",
      repoName: `repo${index + 1}`,
    }));
    mocks.reposValue = [
      ...selected.map((entry, index) => repo(entry.repoOwner, entry.repoName, index + 1)),
      repo("acme", "overflow", 99),
    ];
    const user = userEvent.setup();
    render(
      <EnvironmentForm
        mode="edit"
        initialValues={environment(selected)}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
        submitting={false}
      />
    );

    await user.click(screen.getByRole("button", { name: "Repository selection" }));
    expect(
      screen.getByText(`${MAX_TARGET_REPOSITORIES}/${MAX_TARGET_REPOSITORIES}`)
    ).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: /acme\/overflow/i })).toBeDisabled();
    // Already-selected entries stay toggleable.
    expect(screen.getByRole("checkbox", { name: /acme\/repo1$/i })).toBeEnabled();
  });

  it("blocks selecting a repository whose name collides with a selected one", async () => {
    mocks.reposValue = [repo("group/subgroup", "web", 1), repo("beta", "web", 2)];
    const user = userEvent.setup();
    render(
      <EnvironmentForm
        mode="edit"
        initialValues={environment([{ repoOwner: "group/subgroup", repoName: "web" }])}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
        submitting={false}
      />
    );

    await user.click(screen.getByRole("button", { name: "Repository selection" }));
    expect(screen.getByRole("checkbox", { name: /beta\/web/i })).toBeDisabled();
    expect(screen.getByRole("checkbox", { name: /group\/subgroup\/web/i })).toBeEnabled();
  });

  it("requires a name and at least one repository to submit", () => {
    mocks.reposValue = [repo("acme", "backend", 1)];
    render(
      <EnvironmentForm mode="create" onSubmit={vi.fn()} onCancel={vi.fn()} submitting={false} />
    );

    expect(screen.getByRole("button", { name: /create environment/i })).toBeDisabled();
  });
});
