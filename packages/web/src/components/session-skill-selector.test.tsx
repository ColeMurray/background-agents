// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { cleanup, render, screen } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionSkillSelector } from "./session-skill-selector";

expect.extend(matchers);

vi.mock("@/hooks/use-managed-skills", () => ({
  useSkillProfiles: () => ({ profiles: [], loading: false }),
}));

vi.mock("@/components/ui/combobox", () => ({
  Combobox: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

afterEach(() => {
  cleanup();
});

describe("SessionSkillSelector", () => {
  it("renders supplied preview counts and clears them without a target", () => {
    const { rerender } = render(
      <SessionSkillSelector
        value={{ mode: "all" }}
        onChange={vi.fn()}
        target={{ repositories: [] }}
        preview={{ skills: [], totalBytes: 1, ignoredProfileSkillIds: ["skill-2", "skill-3"] }}
        previewLoading={false}
      />
    );
    expect(screen.getByText("2 ignored")).toBeInTheDocument();

    rerender(
      <SessionSkillSelector
        value={{ mode: "all" }}
        onChange={vi.fn()}
        target={null}
        preview={null}
        previewLoading={false}
      />
    );

    expect(screen.queryByText("2 ignored")).not.toBeInTheDocument();
    expect(screen.queryByText("...")).not.toBeInTheDocument();
  });
});
