// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as matchers from "@testing-library/jest-dom/matchers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppearanceSettings } from "./appearance-settings";

expect.extend(matchers);

vi.mock("next-themes", () => ({
  useTheme: () => ({ theme: "system", setTheme: vi.fn() }),
}));

beforeEach(() => localStorage.clear());
afterEach(cleanup);

describe("AppearanceSettings", () => {
  it("changes and persists the light and dark themes through their labeled triggers", async () => {
    const user = userEvent.setup();
    const { unmount } = render(<AppearanceSettings />);
    expect(screen.getByLabelText("Light theme")).toHaveTextContent("Atom One Light");
    expect(screen.getByLabelText("Dark theme")).toHaveTextContent("Atom One Dark");

    await user.click(screen.getByLabelText("Light theme"));
    await user.click(await screen.findByRole("option", { name: "GitHub" }));
    await user.click(screen.getByLabelText("Dark theme"));
    await user.click(await screen.findByRole("option", { name: "GitHub Dark" }));

    expect(screen.getByLabelText("Light theme")).toHaveTextContent("GitHub");
    expect(screen.getByLabelText("Dark theme")).toHaveTextContent("GitHub Dark");
    unmount();
    render(<AppearanceSettings />);
    expect(screen.getByLabelText("Light theme")).toHaveTextContent("GitHub");
    expect(screen.getByLabelText("Dark theme")).toHaveTextContent("GitHub Dark");
  });

  it("supports keyboard selection and returns focus to the trigger", async () => {
    const user = userEvent.setup();
    render(<AppearanceSettings />);
    const trigger = screen.getByRole("combobox", { name: "Light theme" });
    trigger.focus();
    await user.keyboard("{Enter}");
    await waitFor(() =>
      expect(screen.getByRole("option", { name: "Atom One Light" })).toHaveFocus()
    );
    await user.keyboard("{ArrowDown}{Enter}");
    expect(trigger).toHaveTextContent("GitHub");
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });
});
