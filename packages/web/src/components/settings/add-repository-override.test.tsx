// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as matchers from "@testing-library/jest-dom/matchers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AddRepositoryOverride } from "./add-repository-override";

expect.extend(matchers);
afterEach(cleanup);

const repositories = [{ fullName: "Group/Subgroup/Repository" }] as const;

describe("AddRepositoryOverride", () => {
  it.each([{ repos: [] }, { repos: repositories }])(
    "requires a selection before adding (%j)",
    async ({ repos }) => {
      const user = userEvent.setup();
      const onAdd = vi.fn();
      render(
        <AddRepositoryOverride
          repositories={repos}
          value=""
          onValueChange={vi.fn()}
          onAdd={onAdd}
        />
      );

      expect(screen.getByRole("combobox", { name: "Select a repository" })).toHaveTextContent(
        "Select a repository..."
      );
      const add = screen.getByRole("button", { name: "Add Override" });
      expect(add).toBeDisabled();
      await user.click(add);
      expect(onAdd).not.toHaveBeenCalled();
    }
  );

  it("preserves display casing, emits a normalized identity, and follows controlled resets", async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    const onAdd = vi.fn();
    const props = { repositories, onValueChange, onAdd };
    const { rerender } = render(<AddRepositoryOverride {...props} value="" />);

    const picker = screen.getByRole("combobox", { name: "Select a repository" });
    await user.click(picker);
    await user.click(screen.getByRole("option", { name: "Group/Subgroup/Repository" }));
    expect(onValueChange).toHaveBeenCalledExactlyOnceWith("group/subgroup/repository");
    expect(onAdd).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Add Override" })).toBeDisabled();

    rerender(<AddRepositoryOverride {...props} value="group/subgroup/repository" />);
    expect(picker).toHaveTextContent("Group/Subgroup/Repository");
    await user.click(screen.getByRole("button", { name: "Add Override" }));
    expect(onAdd).toHaveBeenCalledTimes(1);

    rerender(<AddRepositoryOverride {...props} value="" repositories={[]} />);
    expect(picker).toHaveTextContent("Select a repository...");
    expect(screen.getByRole("button", { name: "Add Override" })).toBeDisabled();
  });

  it("supports keyboard selection and Escape cancellation with focus restoration", async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    render(
      <AddRepositoryOverride
        repositories={repositories}
        value=""
        onValueChange={onValueChange}
        onAdd={vi.fn()}
      />
    );

    const picker = screen.getByRole("combobox", { name: "Select a repository" });
    await user.tab();
    expect(picker).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(picker).toHaveFocus());
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(onValueChange).not.toHaveBeenCalled();

    await user.keyboard("{ArrowDown}");
    await waitFor(() =>
      expect(screen.getByRole("option", { name: "Group/Subgroup/Repository" })).toHaveFocus()
    );
    await user.keyboard("{Enter}");
    expect(onValueChange).toHaveBeenCalledExactlyOnceWith("group/subgroup/repository");
    await waitFor(() => expect(picker).toHaveFocus());
  });

  it("prevents adding inside the caller's disabled fieldset even with a selection", async () => {
    const user = userEvent.setup();
    const onAdd = vi.fn();
    render(
      <fieldset disabled>
        <AddRepositoryOverride
          repositories={repositories}
          value="group/subgroup/repository"
          onValueChange={vi.fn()}
          onAdd={onAdd}
        />
      </fieldset>
    );

    const picker = screen.getByRole("combobox", { name: "Select a repository" });
    const add = screen.getByRole("button", { name: "Add Override" });
    expect(picker).toBeDisabled();
    expect(add).toBeDisabled();
    await user.click(add);
    expect(onAdd).not.toHaveBeenCalled();
  });
});
