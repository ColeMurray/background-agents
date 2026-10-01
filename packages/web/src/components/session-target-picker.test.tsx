// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { SessionTargetPickerProps } from "@/hooks/use-session-target-picker";
import { NO_REPOSITORY_OPTION_VALUE } from "@/lib/session-target";
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
    };
    render(<SessionTargetPicker {...props} disabled={false} />);
    expect(screen.getByRole("alert")).toHaveTextContent("This team has no repository grants.");
    fireEvent.click(screen.getByRole("button", { name: "Select repo" }));
    fireEvent.click(screen.getByRole("option", { name: "No repository" }));
    expect(select).toHaveBeenCalledWith(NO_REPOSITORY_OPTION_VALUE);
  });
});
