// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { SessionTargetPickerProps } from "@/hooks/use-session-target-picker";
import {
  MULTIPLE_REPOSITORIES_OPTION_VALUE,
  NO_REPOSITORY_OPTION_VALUE,
} from "@/lib/session-target";
import { SessionTargetPicker } from "./session-target-picker";

expect.extend(matchers);
beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(cleanup);

describe("SessionTargetPicker empty grants", () => {
  it("renders the explicit grant error alongside usable target controls", () => {
    const select = vi.fn();
    const props: SessionTargetPickerProps = {
      sessionTarget: null,
      targetSelectValue: "",
      targetOptions: [{ value: NO_REPOSITORY_OPTION_VALUE, label: "No repository" }],
      displayTargetName: "Select repo",
      onTargetSelectValueChange: select,
      onMultiSelectionChange: vi.fn(),
      selectedBranch: "",
      setSelectedBranch: vi.fn(),
      branches: [],
      loadingBranches: false,
      repos: [],
      loadingRepos: false,
      repositoryGrantError: "This team has no repository grants.",
      selectionError: null,
    };
    render(<SessionTargetPicker {...props} disabled={false} />);
    expect(screen.getByRole("alert")).toHaveTextContent("This team has no repository grants.");
    fireEvent.click(screen.getByRole("button", { name: "Select repo" }));
    fireEvent.click(screen.getByRole("option", { name: "No repository" }));
    expect(select).toHaveBeenCalledWith(NO_REPOSITORY_OPTION_VALUE);
  });
});

describe("SessionTargetPicker invalidated selections", () => {
  const props: SessionTargetPickerProps = {
    sessionTarget: { kind: "repo", repoFullName: "acme/web" },
    targetSelectValue: "acme/web",
    targetOptions: [{ value: NO_REPOSITORY_OPTION_VALUE, label: "No repository" }],
    displayTargetName: "acme/web",
    onTargetSelectValueChange: vi.fn(),
    onMultiSelectionChange: vi.fn(),
    selectedBranch: "feature",
    setSelectedBranch: vi.fn(),
    branches: [{ name: "feature" }],
    loadingBranches: false,
    repos: [],
    loadingRepos: false,
    repositoryGrantError: null,
    selectionError: "Your selected target is no longer available. Choose a target again.",
  };

  it("shows the retained target and invalidation message while allowing a new target choice", () => {
    const select = vi.fn();
    render(<SessionTargetPicker {...props} onTargetSelectValueChange={select} disabled={false} />);
    expect(screen.getByRole("alert")).toHaveTextContent(/choose a target again/i);
    expect(screen.getByRole("button", { name: "feature" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "acme/web" }));
    fireEvent.click(screen.getByRole("option", { name: "No repository" }));
    expect(select).toHaveBeenCalledWith(NO_REPOSITORY_OPTION_VALUE);
  });

  it("keeps the exact multi-repository list visible and supports explicitly clearing it", () => {
    const selectRepositories = vi.fn();
    render(
      <SessionTargetPicker
        {...props}
        sessionTarget={{ kind: "repos", repoFullNames: ["acme/api", "acme/web"] }}
        targetSelectValue={MULTIPLE_REPOSITORIES_OPTION_VALUE}
        displayTargetName="2 repositories"
        onMultiSelectionChange={selectRepositories}
        disabled={false}
      />
    );
    expect(screen.getByRole("button", { name: "Repository selection" })).toHaveTextContent(
      "acme/api, acme/web"
    );
    fireEvent.click(screen.getByRole("button", { name: "Choose repositories again" }));
    expect(selectRepositories).toHaveBeenCalledWith([]);
  });

  it("removes the invalidation message after a new explicit choice", () => {
    const { rerender } = render(<SessionTargetPicker {...props} disabled={false} />);
    rerender(
      <SessionTargetPicker
        {...props}
        sessionTarget={{ kind: "none" }}
        targetSelectValue={NO_REPOSITORY_OPTION_VALUE}
        displayTargetName="No repository"
        selectionError={null}
        disabled={false}
      />
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("keeps the recovery action disabled when the composer is disabled", () => {
    render(
      <SessionTargetPicker
        {...props}
        sessionTarget={{ kind: "repos", repoFullNames: ["acme/web"] }}
        targetSelectValue={MULTIPLE_REPOSITORIES_OPTION_VALUE}
        displayTargetName="1 repository"
        disabled
      />
    );
    expect(screen.getByRole("button", { name: "Choose repositories again" })).toBeDisabled();
  });
});
