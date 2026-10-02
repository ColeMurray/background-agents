// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as matchers from "@testing-library/jest-dom/matchers";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { RepositoryOverrideSelector } from "./repository-override-selector";

expect.extend(matchers);

beforeAll(() => {
  if (!Element.prototype.hasPointerCapture) {
    Element.prototype.hasPointerCapture = () => false;
  }
  if (!Element.prototype.releasePointerCapture) {
    Element.prototype.releasePointerCapture = () => {};
  }
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = () => {};
  }
});

afterEach(cleanup);

async function selectRepository(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click(screen.getByRole("combobox", { name: "Select a repository" }));
  await user.click(within(screen.getByRole("listbox")).getByRole("option", { name }));
}

describe("RepositoryOverrideSelector", () => {
  it("does not submit a selection that becomes unavailable", async () => {
    const user = userEvent.setup();
    const onAdd = vi.fn().mockResolvedValue(true);
    const repositories = [{ fullName: "Example/Repo" }];
    const { rerender } = render(
      <RepositoryOverrideSelector
        repositories={repositories}
        overriddenRepositories={[]}
        onAdd={onAdd}
      />
    );

    await selectRepository(user, "Example/Repo");
    rerender(
      <RepositoryOverrideSelector
        repositories={repositories}
        overriddenRepositories={["EXAMPLE/REPO"]}
        onAdd={onAdd}
      />
    );

    const addButton = screen.getByRole("button", { name: "Add Override" });
    expect(addButton).toBeDisabled();
    await user.click(addButton);
    expect(onAdd).not.toHaveBeenCalled();
  });

  it("disables selection and prevents duplicate adds while pending", async () => {
    const user = userEvent.setup();
    let resolveAdd!: (added: boolean) => void;
    const onAdd = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          resolveAdd = resolve;
        })
    );
    render(
      <RepositoryOverrideSelector
        repositories={[{ fullName: "Example/Repo" }]}
        overriddenRepositories={[]}
        onAdd={onAdd}
      />
    );

    await selectRepository(user, "Example/Repo");
    const addButton = screen.getByRole("button", { name: "Add Override" });
    await user.click(addButton);

    expect(onAdd).toHaveBeenCalledOnce();
    expect(screen.getByRole("combobox", { name: "Select a repository" })).toBeDisabled();
    expect(addButton).toBeDisabled();
    await user.click(addButton);
    expect(onAdd).toHaveBeenCalledOnce();

    await act(async () => resolveAdd(true));
    expect(screen.getByRole("combobox", { name: "Select a repository" })).toBeEnabled();
    expect(addButton).toBeDisabled();
  });
});
