// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RepositoryMultiSelect } from "./repository-multi-select";

afterEach(cleanup);

const repos = [
  {
    id: 1,
    fullName: "acme/app",
    owner: "acme",
    name: "app",
    description: null,
    private: true,
    defaultBranch: "main",
  },
  {
    id: 2,
    fullName: "globex/app",
    owner: "globex",
    name: "app",
    description: null,
    private: true,
    defaultBranch: "main",
  },
];

describe("RepositoryMultiSelect checkout layout", () => {
  it("allows duplicate names for position-rooted Pi selection", () => {
    const onChange = vi.fn();
    render(
      <RepositoryMultiSelect
        repos={repos}
        loadingRepos={false}
        selected={["acme/app"]}
        onChange={onChange}
        triggerLabel="1 repository"
        checkoutLayout="position"
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Repository selection" }));
    const checkbox = screen.getByRole("checkbox", { name: /globex\/app/i });
    expect(checkbox.hasAttribute("disabled")).toBe(false);
    fireEvent.click(checkbox);
    expect(onChange).toHaveBeenCalledWith(["acme/app", "globex/app"]);
  });

  it("keeps duplicate names disabled for name-rooted sandboxes", () => {
    render(
      <RepositoryMultiSelect
        repos={repos}
        loadingRepos={false}
        selected={["acme/app"]}
        onChange={vi.fn()}
        triggerLabel="1 repository"
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Repository selection" }));
    expect(screen.getByRole("checkbox", { name: /globex\/app/i }).hasAttribute("disabled")).toBe(
      true
    );
  });
});
